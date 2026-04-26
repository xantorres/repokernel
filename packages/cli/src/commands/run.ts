import { join, resolve } from 'node:path';
import {
  buildExecutionWaves,
  type Config,
  loadProject,
  meetsThreshold,
  type ParallelWorker,
  type PendingWave,
  RepoKernelError,
  type Run,
  type RunSprintRecord,
  runValidators,
  type SprintId,
} from '@repokernel/core';
import pc from 'picocolors';
import { getRunner } from '../agents/index.js';
import type { AgentRunner, SprintRunResult } from '../agents/types.js';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { isWorktreeCheckout, operationalRoot } from '../lifecycle/controlPaths.js';
import { claimLane, isLaneClaimed, releaseLane } from '../lifecycle/laneState.js';
import { withLock, withWaveLock } from '../lifecycle/locks.js';
import { mergeWaveBranches } from '../lifecycle/merge.js';
import { mutateReviewFrontmatter } from '../lifecycle/mutate.js';
import {
  closeAfterMerge,
  type ParallelWorkerInput,
  runWaveParallel,
} from '../lifecycle/parallelRunner.js';
import { detectPathConflicts } from '../lifecycle/pathConflict.js';
import { refreshRegistry } from '../lifecycle/registry.js';
import { allocateReviewIds } from '../lifecycle/reviewAlloc.js';
import { allocateRun, listRuns, loadRun, updateRun } from '../lifecycle/runState.js';
import {
  generateSprintPacket,
  loadPrevSummaries,
  writeSprintPacket,
  writeSummary,
} from '../lifecycle/sprintPacket.js';
import {
  acquireSprintWorktree,
  acquireWorktree,
  releaseSprintWorktree,
  worktreeBranch,
  worktreePath,
} from '../lifecycle/worktree.js';
import { isoNow } from '../templates/time.js';
import { buildChain } from './chain.js';
import { runCloseCommand, runReviewCommand, runStartCommand } from './lifecycle.js';
import type { CommandResult } from './validate.js';

export interface RunCommandOptions {
  readonly cwd: string;
  readonly epicId?: string;
  readonly resume?: string;
  readonly lane?: string;
  readonly agent: string;
  readonly mode: 'assisted' | 'autonomous';
  readonly limit?: number;
  readonly worktree: boolean;
  readonly dryRun: boolean;
  readonly experimental: boolean;
  /** Force sequential execution even if epic declares parallel. Narrows only. */
  readonly sequential?: boolean;
  /** Accepted silently when epic is parallel; error when epic is sequential. */
  readonly parallel?: boolean;
  /** Max concurrent sprints per wave (clamped to epic.parallel_limit). */
  readonly concurrency?: number;
  /** Allow overlapping allowed_paths across parallel sprints (requires config allowOverlapFlag). */
  readonly allowOverlap?: boolean;
}

export async function runRunCommand(opts: RunCommandOptions): Promise<CommandResult> {
  const controlCwd = resolve(opts.cwd);

  try {
    // guard: must not be invoked from inside a worktree checkout
    if (await isWorktreeCheckout(controlCwd)) {
      return err(
        'WORKTREE_CWD',
        'rk run must be invoked from the main repo checkout, not a worktree',
        'cd to the original repo root first',
      );
    }

    const opRoot = await operationalRoot(controlCwd);

    // — resume path —
    if (opts.resume) {
      return resumeRun(opts.resume, opRoot, controlCwd, opts);
    }

    if (!opts.epicId) {
      return err('MISSING_EPIC', 'epic ID required (e.g. rk run E-001)', 'rk run E-001');
    }

    // — preflight —
    const outcome = await loadProject({ cwd: controlCwd });
    if (!outcome.ok) return configError();

    const { graph, config } = outcome;

    // autonomous mode guard
    if (opts.mode === 'autonomous' && !config.automation.allowAutonomousClose) {
      return err(
        'AUTONOMOUS_DISABLED',
        'autonomous mode requires config.automation.allowAutonomousClose: true',
        'add automation:\\n  allowAutonomousClose: true  to repokernel.config.yaml',
      );
    }

    const epic = graph.epics.get(opts.epicId);
    if (!epic) return err('EPIC_NOT_FOUND', `epic ${opts.epicId} not found`);
    if (!['planned', 'active'].includes(epic.status)) {
      return err(
        'INVALID_EPIC_STATUS',
        `epic ${opts.epicId} status is ${epic.status}`,
        'epic must be planned or active to run',
      );
    }

    const lane = opts.lane ?? config.policies.defaultLane;
    // Operational claim key is epic-scoped so parallel epics can each own one lane slot
    // without colliding even when running the same sprint queue lane.
    const laneClaimKey = `epic-${opts.epicId}`;

    // check for active run on this epic
    const existingRuns = await listRuns(opRoot);
    const activeRun = existingRuns.find((r) => r.epic_id === opts.epicId && r.status === 'running');
    if (activeRun) {
      return err(
        'RUN_ALREADY_ACTIVE',
        `run ${activeRun.id} is already active for epic ${opts.epicId}`,
        `resume with: rk run --resume ${activeRun.id}`,
      );
    }

    // validate project
    const findings = runValidators({
      graph,
      config,
      parsed: outcome.parsed,
      parseFindings: outcome.parsed.findings,
    });
    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, config.policies.severityFailThreshold),
    );
    if (blocking.length > 0) {
      return err(
        'VALIDATION_FAILED',
        `${blocking.length} blocking finding(s) — run rk validate`,
        'fix validation errors before running',
      );
    }

    // Authority and runner checks happen before acquiring worktrees, runs, or lane claims.
    const epicStrategy = epic.execution_strategy ?? 'sequential';
    if (opts.parallel && epicStrategy === 'sequential') {
      return err(
        'PARALLEL_UPGRADE_DENIED',
        `epic ${epic.id} uses execution_strategy=sequential; --parallel cannot override`,
        'set execution_strategy: parallel in the epic file to enable parallel execution',
      );
    }
    if (opts.allowOverlap && !config.parallel.allowOverlapFlag) {
      return err(
        'OVERLAP_FLAG_DISABLED',
        '--allow-overlap requires parallel.allowOverlapFlag: true in repokernel.config.yaml',
        'add parallel:\\n  allowOverlapFlag: true  to your config',
      );
    }
    if (
      opts.concurrency !== undefined &&
      epic.parallel_limit !== undefined &&
      opts.concurrency > epic.parallel_limit
    ) {
      process.stderr.write(
        `warning: --concurrency ${opts.concurrency} > epic.parallel_limit ${epic.parallel_limit}, clamping\n`,
      );
    }
    const effectiveStrategy = opts.sequential ? 'sequential' : epicStrategy;

    // dry run — preview chain
    if (opts.dryRun) {
      const { chain, ineligible, gate } = buildChain(
        outcome,
        lane,
        opts.limit ?? 99,
        config.chaining.sameEpicOnly,
        opts.epicId as `E-${string}`,
      );
      const lines = [
        `dry-run: rk run ${opts.epicId}`,
        '',
        `  Epic:    ${epic.id} — ${epic.title}`,
        `  Lane:    ${lane}`,
        `  Agent:   ${opts.agent}`,
        `  Mode:    ${opts.mode}`,
        opts.worktree
          ? `  Worktree: ${worktreePath(opts.epicId as `E-${string}`, config, controlCwd)}`
          : '  Worktree: disabled (--no-worktree)',
        `  Branch:  ${worktreeBranch(opts.epicId as `E-${string}`, config)}`,
        '',
        `Chain preview (limit: ${opts.limit ?? 'none'}):`,
      ];
      if (chain.length === 0) {
        lines.push('  (no eligible sprints)');
      } else {
        for (let i = 0; i < chain.length; i++) {
          const s = chain[i]!;
          lines.push(`  ${i + 1}. ${s.id} — ${s.title}`);
        }
      }
      if (ineligible.length > 0) {
        lines.push('', '  Ineligible:');
        for (const { sprint: s, reason } of ineligible) {
          lines.push(`    ${s.id} — ${reason}`);
        }
      }
      if (gate) {
        lines.push('', `  Stops before gate: ${gate.id} (${gate.gate})`);
      }
      lines.push('', 'No files written.');
      return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }

    const runner = getRunner(opts.agent, opts.experimental);

    // — acquire worktree + lane —
    // Optimistic lane check first — fail before acquiring any resources.
    if (await isLaneClaimed(laneClaimKey, opRoot)) {
      return err(
        'LANE_CLAIMED',
        `epic ${opts.epicId} already has an active lane claim`,
        'wait for other run to finish or release the lane',
      );
    }

    let executionCwd = controlCwd;
    if (opts.worktree && config.worktrees.autoAcquire) {
      const worktreeInfo = await withLock(`worktree-${opts.epicId}`, opRoot, () =>
        acquireWorktree(opts.epicId as `E-${string}`, config, controlCwd),
      );
      executionCwd = worktreeInfo.path;
    }

    const branch = opts.worktree
      ? worktreeBranch(opts.epicId as `E-${string}`, config)
      : await getCurrentBranch(controlCwd);

    // create run (atomic: scan + write under one lock)
    const run = await allocateRun(
      {
        epic_id: opts.epicId as `E-${string}`,
        lane,
        status: 'running',
        mode: opts.mode,
        agent: opts.agent as 'manual' | 'claude',
        worktree: executionCwd,
        branch,
        started_at: isoNow(),
        ended_at: null,
        current_sprint: null,
        completed_sprints: [],
        halt_reason: null,
        limit: opts.limit ?? null,
        sprint_count: 0,
        execution_strategy: effectiveStrategy,
        wave_index: -1,
        active_sprints: [],
        parallel_workers: [],
      },
      opRoot,
    );

    // Claim lane — the claimLane lock re-checks atomically inside.
    // If this throws, mark the run as aborted so rk runs shows it correctly.
    try {
      await claimLane(laneClaimKey, run.id, run.epic_id, executionCwd, branch, opRoot);
    } catch (e) {
      await updateRun(run.id, { status: 'aborted', ended_at: isoNow() }, opRoot).catch(() => null);
      throw e;
    }

    process.stdout.write(
      [
        '',
        `${pc.bold('Run')} ${run.id}`,
        `  Epic:    ${epic.id} — ${epic.title}`,
        `  Lane:    ${lane}`,
        `  Agent:   ${run.agent}`,
        `  Mode:    ${run.mode}`,
        `  Worktree: ${executionCwd}`,
        '',
      ].join('\n'),
    );

    if (effectiveStrategy === 'parallel') {
      return executeParallelRunLoop(
        run,
        opRoot,
        controlCwd,
        executionCwd,
        outcome.config,
        opts,
        runner,
      );
    }
    return executeRunLoop(run, opRoot, controlCwd, executionCwd, outcome.config, opts, runner);
  } catch (e) {
    return runtimeErr(e);
  }
}

// — run loop —

async function executeRunLoop(
  initialRun: Run,
  opRoot: string,
  controlCwd: string,
  executionCwd: string,
  _config: Config,
  _opts: RunCommandOptions,
  runner: AgentRunner,
): Promise<CommandResult> {
  let run = initialRun;

  try {
    while (true) {
      // check limit
      if (run.limit !== null && run.sprint_count >= run.limit) {
        run = await updateRun(
          run.id,
          { status: 'completed', halt_reason: 'limit_reached', ended_at: isoNow() },
          opRoot,
        );
        break;
      }

      // a. resolve next sprint
      const projectOutcome = await loadProject({ cwd: executionCwd });
      if (!projectOutcome.ok) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: 'config_error', ended_at: isoNow() },
          opRoot,
        );
        return configError();
      }

      // rk run always resolves a chain regardless of config.chaining.enabled —
      // the run loop is the orchestrator; chaining.enabled guards the rk chain CLI command only.
      const { chain, gate } = buildChain(
        projectOutcome,
        run.lane,
        1,
        projectOutcome.config.chaining.sameEpicOnly,
        run.epic_id,
      );

      if (gate) {
        const haltReason = `gate:${gate.id}:${gate.gate ?? 'unknown'}`;
        run = await updateRun(
          run.id,
          { status: 'paused', halt_reason: haltReason, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return {
          exitCode: EXIT_OK,
          stdout: [
            '',
            `Run ${run.id} halted at gate`,
            `  Sprint: ${gate.id} — ${gate.title}`,
            `  Gate:   ${gate.gate}`,
            '',
            'Resolve the gate in the sprint file, then resume:',
            `  rk run --resume ${run.id}`,
            '',
          ].join('\n'),
          stderr: '',
        };
      }

      if (chain.length === 0) {
        // check if epic is fully done
        const epicSprints = [...projectOutcome.graph.sprints.values()].filter(
          (s) => s.epic_id === run.epic_id,
        );
        const allDone = epicSprints.every((s) => ['shipped', 'cancelled'].includes(s.status));
        const haltReason = allDone ? 'epic_completed' : 'no_runnable_sprint';
        run = await updateRun(
          run.id,
          { status: 'completed', halt_reason: haltReason, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        break;
      }

      const sprint = chain[0]!;
      const epic = projectOutcome.graph.epics.get(run.epic_id);
      if (!epic) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: 'epic_not_found', ended_at: isoNow() },
          opRoot,
        );
        return err('EPIC_NOT_FOUND', `epic ${run.epic_id} not found`);
      }

      // b. generate sprint packet
      const prevSummaries = await loadPrevSummaries(run, opRoot);
      const packetContent = generateSprintPacket(run, sprint, epic, prevSummaries);
      const packetPath = await writeSprintPacket(run, sprint, packetContent, opRoot);

      process.stdout.write(`\n${pc.bold(`Sprint ${sprint.id}`)} — ${sprint.title}\n`);
      process.stdout.write(`  Packet: ${packetPath}\n\n`);

      // c. start sprint
      const startResult = await runStartCommand(sprint.id, {
        cwd: executionCwd,
        force: false,
        dryRun: false,
        json: false,
      });
      if (startResult.stdout) process.stdout.write(startResult.stdout);
      if (startResult.stderr) process.stderr.write(startResult.stderr);
      if (startResult.exitCode !== EXIT_OK) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: `agent_failed:${sprint.id}`, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return startResult;
      }

      run = await updateRun(run.id, { current_sprint: sprint.id }, opRoot);

      // d. invoke agent
      const registryPath = join(executionCwd, projectOutcome.config.paths.registry);
      let agentResult: SprintRunResult;
      try {
        agentResult = await runner.runSprint({
          run_id: run.id,
          epic_id: run.epic_id,
          sprint_id: sprint.id,
          worktree: executionCwd,
          control_cwd: controlCwd,
          op_root: opRoot,
          sprint_packet_path: packetPath,
          registry_path: registryPath,
          mode: run.mode,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        agentResult = { status: 'failed', summary: errMsg, changed_files: [], needs_human: false };
      }

      // e. post-agent validation
      const postOutcome = await loadProject({ cwd: executionCwd });
      if (postOutcome.ok) {
        const postFindings = runValidators({
          graph: postOutcome.graph,
          config: postOutcome.config,
          parsed: postOutcome.parsed,
          parseFindings: postOutcome.parsed.findings,
        });
        const postBlocking = postFindings.filter((f) =>
          meetsThreshold(f.severity, postOutcome.config.policies.severityFailThreshold),
        );
        if (postBlocking.length > 0 && agentResult.status === 'completed') {
          agentResult = {
            ...agentResult,
            status: 'failed',
            summary: `validation failed after agent: ${postBlocking[0]?.message ?? 'unknown'}`,
          };
        }
      }

      // write summary regardless of outcome
      const summaryContent = [
        `# ${sprint.id} — ${sprint.title}`,
        `\nStatus: ${agentResult.status}`,
        `\n${agentResult.summary}`,
        agentResult.changed_files.length > 0
          ? `\n\nChanged files:\n${agentResult.changed_files.map((f) => `- ${f}`).join('\n')}`
          : '',
      ].join('');
      const summaryPath = await writeSummary(run, sprint, summaryContent, opRoot);

      if (agentResult.status !== 'completed') {
        const haltReason = `agent_${agentResult.status}:${sprint.id}`;
        const record: RunSprintRecord = {
          id: sprint.id,
          verdict: agentResult.status,
          summary_path: summaryPath,
          start_sha: null,
          end_sha: null,
        };
        run = await updateRun(
          run.id,
          {
            status: 'failed',
            halt_reason: haltReason,
            ended_at: isoNow(),
            completed_sprints: [...run.completed_sprints, record],
            current_sprint: null,
          },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return err(
          'AGENT_FAILED',
          `agent returned ${agentResult.status} for ${sprint.id}: ${agentResult.summary}`,
          `check logs: rk runs`,
        );
      }

      // f. review phase
      if (run.mode === 'assisted') {
        // create pending review
        const reviewResult = await runReviewCommand(sprint.id, {
          cwd: executionCwd,
          dryRun: false,
          json: false,
        });
        if (reviewResult.stdout) process.stdout.write(reviewResult.stdout);
        if (reviewResult.stderr) process.stderr.write(reviewResult.stderr);

        // reload to get review_id
        const reviewOutcome = await loadProject({ cwd: executionCwd });
        const updatedSprint = reviewOutcome.ok ? reviewOutcome.graph.sprints.get(sprint.id) : null;
        const reviewId = updatedSprint?.review_id ?? 'R-???';

        run = await updateRun(
          run.id,
          { status: 'paused', halt_reason: 'awaiting_review', current_sprint: sprint.id },
          opRoot,
        );

        process.stdout.write(
          [
            '',
            `${pc.bold('Run paused')} — awaiting review`,
            `  Sprint: ${sprint.id}`,
            `  Review: ${reviewId}`,
            '',
            `Next steps:`,
            `  1. Review the sprint changes`,
            `  2. ${pc.dim(`rk review-verdict ${reviewId} accepted`)}`,
            `  3. ${pc.dim(`rk run --resume ${run.id}`)}`,
            '',
          ].join('\n'),
        );

        return { exitCode: EXIT_OK, stdout: '', stderr: '' };
      }

      // autonomous mode
      if (!agentResult.review || agentResult.review.verdict !== 'accepted') {
        const record: RunSprintRecord = {
          id: sprint.id,
          verdict: 'rejected',
          summary_path: summaryPath,
          start_sha: null,
          end_sha: null,
        };
        run = await updateRun(
          run.id,
          {
            status: 'paused',
            halt_reason: 'review_not_accepted',
            completed_sprints: [...run.completed_sprints, record],
            current_sprint: null,
          },
          opRoot,
        );
        return err(
          'REVIEW_NOT_ACCEPTED',
          `autonomous mode: agent review verdict was ${agentResult.review?.verdict ?? 'missing'}`,
          `resume with manual review: rk run --resume ${run.id}`,
        );
      }

      const reviewResult = await runReviewCommand(sprint.id, {
        cwd: executionCwd,
        dryRun: false,
        json: false,
      });
      if (reviewResult.exitCode !== EXIT_OK) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: `review_failed:${sprint.id}`, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return reviewResult;
      }

      const closeResult = await runCloseCommand(sprint.id, {
        cwd: executionCwd,
        dryRun: false,
        json: false,
      });
      if (closeResult.stdout) process.stdout.write(closeResult.stdout);
      if (closeResult.stderr) process.stderr.write(closeResult.stderr);
      if (closeResult.exitCode !== EXIT_OK) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: `close_failed:${sprint.id}`, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return closeResult;
      }

      // g+h. advance
      const closedOutcome = await loadProject({ cwd: executionCwd });
      const closedSprint = closedOutcome.ok ? closedOutcome.graph.sprints.get(sprint.id) : null;
      const record: RunSprintRecord = {
        id: sprint.id,
        verdict: 'accepted',
        summary_path: summaryPath,
        start_sha: closedSprint?.base_sha ?? '',
        end_sha: closedSprint?.end_sha ?? null,
      };

      await refreshRegistry(executionCwd);
      run = await updateRun(
        run.id,
        {
          completed_sprints: [...run.completed_sprints, record],
          sprint_count: run.sprint_count + 1,
          current_sprint: null,
        },
        opRoot,
      );

      process.stdout.write(`${pc.green('✓')} Sprint ${sprint.id} closed\n`);
    }

    // finalize
    await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
    const duration = run.ended_at
      ? Math.round((new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 1000)
      : 0;

    return {
      exitCode: EXIT_OK,
      stdout: [
        '',
        `${pc.bold('Run')} ${run.id} ${run.status === 'completed' ? pc.green('completed') : run.status}`,
        `  Epic:    ${run.epic_id}`,
        `  Sprints: ${run.sprint_count}`,
        `  Halt:    ${run.halt_reason ?? 'none'}`,
        `  Time:    ${duration}s`,
        '',
      ].join('\n'),
      stderr: '',
    };
  } catch (e) {
    await updateRun(run.id, { status: 'failed', ended_at: isoNow() }, opRoot).catch(() => null);
    await releaseLane(`epic-${run.epic_id}`, opRoot, run.id).catch(() => null);
    return runtimeErr(e);
  }
}

// — parallel run loop —

async function executeParallelRunLoop(
  initialRun: Run,
  opRoot: string,
  controlCwd: string,
  epicWorktree: string,
  _config: Config,
  opts: RunCommandOptions,
  runner: AgentRunner,
): Promise<CommandResult> {
  let run = initialRun;
  const epicId = run.epic_id;

  try {
    while (true) {
      // Reload project from epic worktree each iteration to get fresh state
      const projectOutcome = await loadProject({ cwd: epicWorktree });
      if (!projectOutcome.ok) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: 'config_error', ended_at: isoNow() },
          opRoot,
        );
        return configError();
      }

      const { graph, config } = projectOutcome;
      const epic = graph.epics.get(epicId);
      if (!epic) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: 'epic_not_found', ended_at: isoNow() },
          opRoot,
        );
        return err('EPIC_NOT_FOUND', `epic ${epicId} not found`);
      }

      // Check run limit
      if (run.limit !== null && run.sprint_count >= run.limit) {
        run = await updateRun(
          run.id,
          { status: 'completed', halt_reason: 'limit_reached', ended_at: isoNow() },
          opRoot,
        );
        break;
      }

      // Build shipped set from current graph state (authoritative after each wave close)
      const shipped = new Set<SprintId>();
      for (const sprint of graph.sprints.values()) {
        if (['shipped', 'cancelled'].includes(sprint.status)) {
          shipped.add(sprint.id as SprintId);
        }
      }

      const epicParallelLimit = epic.parallel_limit ?? config.parallel.maxConcurrentSprints;
      const concurrencyArg = opts.concurrency ?? Infinity;
      const remainingLimit = run.limit === null ? Infinity : run.limit - run.sprint_count;
      const effectiveLimit = Math.min(
        epicParallelLimit,
        config.parallel.maxConcurrentSprints,
        concurrencyArg,
        remainingLimit,
      );

      // Build waves
      const waves = buildExecutionWaves(graph, epicId, shipped, effectiveLimit, { lane: run.lane });
      if (waves.length === 0) {
        const epicSprints = [...graph.sprints.values()].filter((s) => s.epic_id === epicId);
        const allDone = epicSprints.every((s) => ['shipped', 'cancelled'].includes(s.status));
        const haltReason = allDone ? 'epic_completed' : 'no_runnable_sprint';
        run = await updateRun(
          run.id,
          { status: 'completed', halt_reason: haltReason, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        break;
      }

      const wave = waves[0]!;
      const totalWaves = waves.length; // waves from current iteration only; indicates remaining

      // 1. Path conflict preflight (skip when --allow-overlap is set)
      const conflicts = detectPathConflicts(
        wave.sprints as Parameters<typeof detectPathConflicts>[0],
      );
      if (conflicts.hasConflicts && !opts.allowOverlap) {
        const details = [
          ...conflicts.definiteConflicts.map(
            (c) => `  ${c.sprint1} ∩ ${c.sprint2}: ${c.overlappingGlobs.join(', ')}`,
          ),
          ...conflicts.unknownRiskPairs.map(
            (c) => `  ${c.sprint1} ∩ ${c.sprint2}: unknown overlap`,
          ),
        ].join('\n');
        run = await updateRun(run.id, { status: 'paused', halt_reason: 'path_conflict' }, opRoot);
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        return err(
          'PATH_CONFLICT',
          `wave ${wave.index} has path conflicts:\n${details}`,
          'resolve path conflicts or run --sequential',
        );
      }

      // 2-5. Wave setup under wave lock
      const reviewsDir = join(epicWorktree, config.paths.reviews);
      const prevSummaries = await loadPrevSummaries(run, opRoot);

      const waveSetup = await withWaveLock(run.id, opRoot, async () => {
        // Pre-allocate review IDs under the wave lock
        const reviewIdMap = await allocateReviewIds(
          wave.sprints.map((s) => s.id as SprintId),
          reviewsDir,
          opRoot,
        );

        // Create sprint worktrees
        const sprintEntries: Array<{
          sprint: (typeof wave.sprints)[number];
          worktree: string;
          branch: string;
          reviewId: string;
        }> = [];

        for (const sprint of wave.sprints) {
          const sprintInfo = await acquireSprintWorktree(
            epicId,
            sprint.id as SprintId,
            epicWorktree,
            config,
            controlCwd,
          );
          sprintEntries.push({
            sprint,
            worktree: sprintInfo.path,
            branch: sprintInfo.branch,
            reviewId: reviewIdMap.get(sprint.id as SprintId) ?? `R-???`,
          });
        }

        // Update run state
        const workers: ParallelWorker[] = sprintEntries.map((e) => ({
          sprint_id: e.sprint.id as SprintId,
          worktree: e.worktree,
          branch: e.branch,
          status: 'running' as const,
          started_at: isoNow(),
        }));

        const pendingWave: PendingWave = {
          index: wave.index,
          status: 'running',
          sprint_ids: wave.sprints.map((s) => s.id as SprintId),
          branches: Object.fromEntries(sprintEntries.map((e) => [e.sprint.id, e.branch])),
        };

        run = await updateRun(
          run.id,
          {
            wave_index: wave.index,
            active_sprints: wave.sprints.map((s) => s.id as SprintId),
            parallel_workers: workers,
            pending_wave: pendingWave,
          },
          opRoot,
        );

        return { sprintEntries, reviewIdMap };
      });

      const { sprintEntries, reviewIdMap } = waveSetup;

      // 6. Fire all agents concurrently
      const waveLabel = wave.canParallelize
        ? `${wave.sprints.length} sprints running in parallel`
        : `1 sprint running (sequential)`;
      process.stderr.write(
        `\n${pc.bold(`[Wave ${wave.index + 1}/${wave.index + totalWaves}]`)} ${waveLabel}\n`,
      );
      for (const e of sprintEntries) {
        process.stderr.write(`  ${pc.dim(e.sprint.id)}  running  ${e.branch}\n`);
      }

      const registryPath = join(epicWorktree, config.paths.registry);
      const workerInputs: ParallelWorkerInput[] = sprintEntries.map((e) => ({
        sprint: e.sprint,
        epic,
        run,
        epicWorktree,
        sprintWorktree: e.worktree,
        sprintBranch: e.branch,
        allocatedReviewId: e.reviewId,
        opRoot,
        runner,
        controlCwd,
        registryPath,
        prevSummaries,
      }));

      const waveResult = await runWaveParallel(workerInputs);

      // 7. Handle worker failures
      if (waveResult.failed.length > 0) {
        const failedIds = waveResult.failed.map((f) => f.sprint.id).join(', ');
        run = await updateRun(
          run.id,
          {
            status: 'failed',
            halt_reason: `agent_failed:${failedIds}`,
            active_sprints: [],
            ended_at: isoNow(),
          },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        return err(
          'AGENT_FAILED',
          `wave ${wave.index}: agents failed for ${failedIds}`,
          'inspect sprint worktrees and logs, then restart the run after cleanup',
        );
      }

      // 8. Assisted mode: pause for reviews
      if (run.mode === 'assisted') {
        const awaitingReviews = waveResult.completed.map((c) => c.reviewId);
        const pendingWave: PendingWave = {
          index: wave.index,
          status: 'awaiting_reviews',
          sprint_ids: wave.sprints.map((s) => s.id as SprintId),
          awaiting_reviews: awaitingReviews,
          branches: Object.fromEntries(waveResult.completed.map((c) => [c.sprint.id, c.branch])),
        };
        run = await updateRun(
          run.id,
          {
            status: 'paused',
            halt_reason: 'awaiting_reviews',
            active_sprints: [],
            pending_wave: pendingWave,
          },
          opRoot,
        );

        process.stdout.write(
          [
            '',
            `[Wave ${wave.index + 1}] All sprints complete. Awaiting reviews:`,
            ...waveResult.completed.map(
              (c) => `  ${c.sprint.id}  completed → ${c.reviewId} pending`,
            ),
            '',
            `Run ${run.id} paused — awaiting_reviews`,
            `Resume with: rk run --resume ${run.id}`,
            '',
          ].join('\n'),
        );

        return { exitCode: EXIT_OK, stdout: '', stderr: '' };
      }

      // 9. Autonomous: auto-accept reviews (agent provided self-review)
      for (const completed of waveResult.completed) {
        if (!completed.result.review || completed.result.review.verdict !== 'accepted') {
          run = await updateRun(
            run.id,
            {
              status: 'failed',
              halt_reason: `review_not_accepted:${completed.sprint.id}`,
              active_sprints: [],
              ended_at: isoNow(),
            },
            opRoot,
          );
          await releaseLane(`epic-${epicId}`, opRoot, run.id);
          return err(
            'REVIEW_NOT_ACCEPTED',
            `autonomous mode: agent review verdict for ${completed.sprint.id} was ${completed.result.review?.verdict ?? 'missing'}`,
            'inspect sprint worktree and rerun after review is corrected',
          );
        }
        const reviewFilePath = join(reviewsDir, `${completed.reviewId}.md`);
        const reviewPatch: Record<string, unknown> = {
          verdict: 'accepted',
          updated_at: isoNow(),
          changed_files: completed.result.changed_files,
        };
        if (completed.result.review?.findings) {
          reviewPatch.findings = completed.result.review.findings;
        }
        await mutateReviewFrontmatter(reviewFilePath, reviewPatch);
      }

      // 10. Merge (under wave lock — marks pending_wave.status = merging)
      const sprintBranchEntries = waveResult.completed.map((c) => ({
        sprintId: c.sprint.id as SprintId,
        branch: c.branch,
        worktree: c.worktree,
      }));

      await withWaveLock(run.id, opRoot, async () => {
        if (run.pending_wave) {
          run = await updateRun(
            run.id,
            { pending_wave: { ...run.pending_wave, status: 'merging' as const } },
            opRoot,
          );
        }
      });

      const mergeResult = await mergeWaveBranches(epicWorktree, sprintBranchEntries);

      if (!mergeResult.success && mergeResult.firstConflict) {
        run = await updateRun(
          run.id,
          {
            status: 'paused',
            halt_reason: `merge_conflict:${mergeResult.firstConflict.sprintId}`,
            pending_wave: run.pending_wave
              ? { ...run.pending_wave, status: 'failed' as const }
              : undefined,
          },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        const conflictFiles = mergeResult.firstConflict.conflictingFiles.join(', ');
        return err(
          'MERGE_CONFLICT',
          `merge conflict in sprint ${mergeResult.firstConflict.sprintId}: ${conflictFiles}`,
          'sprint worktrees preserved for inspection — resolve manually, then start a fresh run',
        );
      }

      // 11. Close all wave sprints in epic worktree
      for (const sprintId of mergeResult.merged) {
        const reviewId = reviewIdMap.get(sprintId) ?? '';
        await closeAfterMerge(sprintId, reviewId, epicWorktree);
      }

      // 12. Registry refresh (once per wave)
      await refreshRegistry(epicWorktree);

      // 13. Advance + release merged sprint worktrees (under wave lock)
      await withWaveLock(run.id, opRoot, async () => {
        for (const completed of waveResult.completed) {
          if (mergeResult.merged.includes(completed.sprint.id as SprintId)) {
            await releaseSprintWorktree(
              epicId,
              completed.sprint.id as SprintId,
              config,
              controlCwd,
            ).catch(() => null);
          }
        }

        const newRecords: RunSprintRecord[] = mergeResult.merged.map((id) => ({
          id: id as SprintId,
          verdict: 'accepted' as const,
          summary_path: join(opRoot, 'runs', run.id, 'summaries', `${id}.md`),
          start_sha: null,
          end_sha: null,
        }));

        run = await updateRun(
          run.id,
          {
            completed_sprints: [...run.completed_sprints, ...newRecords],
            sprint_count: run.sprint_count + mergeResult.merged.length,
            active_sprints: [],
            parallel_workers: run.parallel_workers.map((w) => ({
              ...w,
              status: mergeResult.merged.includes(w.sprint_id) ? ('completed' as const) : w.status,
              ended_at: isoNow(),
            })),
            pending_wave: undefined,
          },
          opRoot,
        );
      });

      process.stderr.write(
        `${pc.green('✓')} [Wave ${wave.index + 1}] ${mergeResult.merged.length} sprint(s) merged\n`,
      );
    }

    // Finalize
    await releaseLane(`epic-${epicId}`, opRoot, run.id);
    const duration = run.ended_at
      ? Math.round((new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 1000)
      : 0;

    return {
      exitCode: EXIT_OK,
      stdout: [
        '',
        `${pc.bold('Run')} ${run.id} ${run.status === 'completed' ? pc.green('completed') : run.status}`,
        `  Epic:    ${run.epic_id}`,
        `  Sprints: ${run.sprint_count}`,
        `  Halt:    ${run.halt_reason ?? 'none'}`,
        `  Time:    ${duration}s`,
        '',
      ].join('\n'),
      stderr: '',
    };
  } catch (e) {
    await updateRun(run.id, { status: 'failed', ended_at: isoNow() }, opRoot).catch(() => null);
    await releaseLane(`epic-${epicId}`, opRoot, run.id).catch(() => null);
    return runtimeErr(e);
  }
}

// — resume —

async function resumeRun(
  runId: string,
  opRoot: string,
  controlCwd: string,
  opts: RunCommandOptions,
): Promise<CommandResult> {
  let run: Run;
  try {
    run = await loadRun(runId, opRoot);
  } catch {
    return err('RUN_NOT_FOUND', `run ${runId} not found`);
  }

  if (!['paused', 'failed'].includes(run.status)) {
    return err(
      'INVALID_RUN_STATUS',
      `run ${runId} status is ${run.status} — only paused or failed runs can be resumed`,
    );
  }

  const executionCwd = run.worktree;
  const runner = getRunner(run.agent, opts.experimental);

  if (run.halt_reason === 'awaiting_review') {
    // re-claim lane if needed (use epic-scoped key consistent with initial claim)
    const resumeClaimKey = `epic-${run.epic_id}`;
    if (!(await isLaneClaimed(resumeClaimKey, opRoot))) {
      await claimLane(resumeClaimKey, run.id, run.epic_id, executionCwd, run.branch, opRoot);
    }

    // load current sprint
    const projectOutcome = await loadProject({ cwd: executionCwd });
    if (!projectOutcome.ok) return configError();

    const sprint = run.current_sprint ? projectOutcome.graph.sprints.get(run.current_sprint) : null;
    if (!sprint) {
      return err('SPRINT_NOT_FOUND', `current sprint ${run.current_sprint ?? '?'} not found`);
    }

    if (!sprint.review_id) {
      return err(
        'REVIEW_MISSING',
        `sprint ${sprint.id} has no review_id — run rk review ${sprint.id} first`,
      );
    }

    const review = projectOutcome.graph.reviews.get(sprint.review_id);
    if (!review) {
      return err('REVIEW_NOT_FOUND', `review ${sprint.review_id} not found`);
    }
    if (review.verdict !== 'accepted') {
      return err(
        'REVIEW_NOT_ACCEPTED',
        `review ${sprint.review_id} verdict is ${review.verdict}`,
        `rk review-verdict ${sprint.review_id} accepted`,
      );
    }

    // close sprint
    const closeResult = await runCloseCommand(sprint.id, {
      cwd: executionCwd,
      dryRun: false,
      json: false,
    });
    if (closeResult.stdout) process.stdout.write(closeResult.stdout);
    if (closeResult.stderr) process.stderr.write(closeResult.stderr);
    if (closeResult.exitCode !== EXIT_OK) {
      return closeResult;
    }

    // write summary + advance
    const closedOutcome = await loadProject({ cwd: executionCwd });
    const closedSprint = closedOutcome.ok ? closedOutcome.graph.sprints.get(sprint.id) : null;

    const summaryPath = join(opRoot, 'runs', run.id, 'summaries', `${sprint.id}.md`);
    const record: RunSprintRecord = {
      id: sprint.id,
      verdict: 'accepted',
      summary_path: summaryPath,
      start_sha: closedSprint?.base_sha ?? sprint.base_sha ?? null,
      end_sha: closedSprint?.end_sha ?? null,
    };

    await refreshRegistry(executionCwd);
    run = await updateRun(
      run.id,
      {
        status: 'running',
        halt_reason: null,
        completed_sprints: [...run.completed_sprints, record],
        sprint_count: run.sprint_count + 1,
        current_sprint: null,
      },
      opRoot,
    );

    process.stdout.write(`${pc.green('✓')} Sprint ${sprint.id} closed via resume\n`);

    // check if we should continue the loop
    if (run.limit !== null && run.sprint_count >= run.limit) {
      run = await updateRun(
        run.id,
        { status: 'completed', halt_reason: 'limit_reached', ended_at: isoNow() },
        opRoot,
      );
      await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
      return {
        exitCode: EXIT_OK,
        stdout: `\nRun ${run.id} completed (limit reached after ${run.sprint_count} sprint(s))\n`,
        stderr: '',
      };
    }

    // load config for continuation
    const continuationOutcome = await loadProject({ cwd: executionCwd });
    if (!continuationOutcome.ok) return configError();

    // Route back to the appropriate loop
    const strategy = run.execution_strategy ?? 'sequential';
    if (strategy === 'parallel') {
      return executeParallelRunLoop(
        run,
        opRoot,
        controlCwd,
        executionCwd,
        continuationOutcome.config,
        opts,
        runner,
      );
    }
    return executeRunLoop(
      run,
      opRoot,
      controlCwd,
      executionCwd,
      continuationOutcome.config,
      opts,
      runner,
    );
  }

  // Parallel resume: awaiting_reviews (wave)
  if (run.halt_reason === 'awaiting_reviews' && run.execution_strategy === 'parallel') {
    const resumeClaimKey = `epic-${run.epic_id}`;
    if (!(await isLaneClaimed(resumeClaimKey, opRoot))) {
      await claimLane(resumeClaimKey, run.id, run.epic_id, executionCwd, run.branch, opRoot);
    }

    const pendingWave = run.pending_wave;
    if (!pendingWave || !pendingWave.awaiting_reviews || !pendingWave.branches) {
      return err(
        'CORRUPT_STATE',
        'pending_wave missing awaiting_reviews or branches',
        'run rk runs to see run state',
      );
    }

    // Check all reviews are accepted
    const projectOutcome = await loadProject({ cwd: executionCwd });
    if (!projectOutcome.ok) return configError();

    for (const reviewId of pendingWave.awaiting_reviews) {
      const review = projectOutcome.graph.reviews.get(reviewId);
      if (!review) {
        return err('REVIEW_NOT_FOUND', `review ${reviewId} not found`);
      }
      if (review.verdict !== 'accepted') {
        return err(
          'REVIEW_NOT_ACCEPTED',
          `review ${reviewId} verdict is ${review.verdict}`,
          `rk review-verdict ${reviewId} accepted`,
        );
      }
    }

    // Merge + close + advance
    const sprintBranchEntries = Object.entries(pendingWave.branches).map(([sprintId, branch]) => ({
      sprintId: sprintId as SprintId,
      branch,
      worktree: join(executionCwd, sprintId), // approximate — actual path from worktrees.json
    }));

    const mergeResult = await withWaveLock(run.id, opRoot, async () => {
      run = await updateRun(
        run.id,
        { pending_wave: { ...pendingWave, status: 'merging' as const } },
        opRoot,
      );
      return mergeWaveBranches(executionCwd, sprintBranchEntries);
    });

    if (!mergeResult.success && mergeResult.firstConflict) {
      run = await updateRun(
        run.id,
        {
          halt_reason: `merge_conflict:${mergeResult.firstConflict.sprintId}`,
          pending_wave: { ...pendingWave, status: 'failed' as const },
        },
        opRoot,
      );
      return err(
        'MERGE_CONFLICT',
        `merge conflict in sprint ${mergeResult.firstConflict.sprintId}`,
        'sprint worktrees preserved for inspection — resolve manually, then start a fresh run',
      );
    }

    for (const sprintId of mergeResult.merged) {
      const reviewId =
        pendingWave.awaiting_reviews.find(
          (r) => projectOutcome.graph.reviews.get(r)?.sprint_id === sprintId,
        ) ?? '';
      await closeAfterMerge(sprintId, reviewId, executionCwd);
    }

    await refreshRegistry(executionCwd);

    const continuationOutcome2 = await loadProject({ cwd: executionCwd });
    if (!continuationOutcome2.ok) return configError();

    const newRecords: RunSprintRecord[] = mergeResult.merged.map((id) => ({
      id: id as SprintId,
      verdict: 'accepted' as const,
      summary_path: join(opRoot, 'runs', run.id, 'summaries', `${id}.md`),
      start_sha: null,
      end_sha: null,
    }));

    for (const sprintId of mergeResult.merged) {
      await releaseSprintWorktree(
        run.epic_id,
        sprintId as SprintId,
        continuationOutcome2.config,
        controlCwd,
      ).catch(() => null);
    }

    run = await updateRun(
      run.id,
      {
        status: 'running',
        halt_reason: null,
        completed_sprints: [...run.completed_sprints, ...newRecords],
        sprint_count: run.sprint_count + mergeResult.merged.length,
        active_sprints: [],
        parallel_workers: run.parallel_workers.map((worker) => ({
          ...worker,
          status: mergeResult.merged.includes(worker.sprint_id)
            ? ('completed' as const)
            : worker.status,
          ended_at: mergeResult.merged.includes(worker.sprint_id) ? isoNow() : worker.ended_at,
        })),
        pending_wave: undefined,
      },
      opRoot,
    );

    process.stdout.write(
      `${pc.green('✓')} Wave ${pendingWave.index + 1} merged — ${mergeResult.merged.length} sprint(s) closed\n`,
    );

    return executeParallelRunLoop(
      run,
      opRoot,
      controlCwd,
      executionCwd,
      continuationOutcome2.config,
      opts,
      runner,
    );
  }

  return err(
    'RESUME_UNSUPPORTED',
    `resume for halt_reason "${run.halt_reason ?? 'unknown'}" not yet implemented`,
    `run rk runs to see run state`,
  );
}

// — helpers —

function err(_code: string, message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${lines.join('\n')}\n` };
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}

function runtimeErr(e: unknown): CommandResult {
  if (e instanceof RepoKernelError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${message}\n` };
}

async function getCurrentBranch(cwd: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}
