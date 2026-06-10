import { join, resolve } from 'node:path';
import {
  buildExecutionWaves,
  buildSatisfiedSprints,
  type Config,
  type EpicId,
  effectiveReviewer,
  effectiveReviewRequired,
  HALT_REASONS,
  loadProject,
  meetsThreshold,
  type ParallelWorker,
  type PendingWave,
  RepoKernelError,
  ReviewIdSchema,
  type Run,
  type RunSprintRecord,
  resolveReviewerGate,
  runValidators,
  type SprintId,
  SprintIdSchema,
} from '@repokernel/core';
import pc from 'picocolors';
import { getRunner } from '../agents/index.js';
import type { AgentRunner, SprintRunResult } from '../agents/types.js';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { installOwnerAbortHandler } from '../lifecycle/abortHandler.js';
import { checkpointAutonomousSprint } from '../lifecycle/checkpoint.js';
import { isWorktreeCheckout, operationalRoot } from '../lifecycle/controlPaths.js';
import { getDirtyFiles, stagePathsAndCommit } from '../lifecycle/git.js';
import { claimLane, getLaneState, isLaneClaimed, releaseLane } from '../lifecycle/laneState.js';
import { withLock, withWaveLock } from '../lifecycle/locks.js';
import { mergeWaveBranches } from '../lifecycle/merge.js';
import { mutateReviewFrontmatter } from '../lifecycle/mutate.js';
import {
  closeAfterMerge,
  type ParallelWorkerInput,
  runWaveParallel,
} from '../lifecycle/parallelRunner.js';
import { detectPathConflicts } from '../lifecycle/pathConflict.js';
import { allocateReviewIds } from '../lifecycle/reviewAlloc.js';
import { allocateRun, listRuns, loadRun, updateRun } from '../lifecycle/runState.js';
import {
  generateSprintPacket,
  loadPrevSummaries,
  writeSprintPacket,
  writeSummary,
} from '../lifecycle/sprintPacket.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import {
  acquireSprintWorktree,
  acquireWorktree,
  releaseSprintWorktree,
  releaseWorktree,
  worktreeBranch,
  worktreePath,
} from '../lifecycle/worktree.js';
import { isoNow } from '../templates/time.js';
import { buildChain } from './chain.js';
import { runCloseCommand, runReviewCommand, runStartCommand } from './lifecycle.js';
import { runReviewSprintCommand } from './reviewSprint.js';
import { type EpicPreflightResult, epicPreflight, renderPreflight } from './runPreflight.js';
import type { CommandResult } from './validate.js';

export interface RunCommandOptions {
  readonly cwd: string;
  readonly epicId?: string;
  readonly resume?: string;
  readonly lane?: string;
  readonly agent?: string;
  readonly mode: 'assisted' | 'autonomous';
  readonly limit?: number;
  readonly worktree: boolean;
  readonly dryRun: boolean;
  /** Read-only pre-flight surface: render checks, exit non-zero on any failure. */
  readonly preflight?: boolean;
  /** Force sequential execution even if epic declares parallel. Narrows only. */
  readonly sequential?: boolean;
  /** Accepted silently when epic is parallel; error when epic is sequential. */
  readonly parallel?: boolean;
  /** Max concurrent sprints per wave (clamped to epic.parallel_limit). */
  readonly concurrency?: number;
  /** Allow overlapping allowed_paths across parallel sprints (requires config allowOverlapFlag). */
  readonly allowOverlap?: boolean;
  /**
   * Invoked from the task fastpath. Suppresses the sprint/run plumbing
   * next-step block (review-verdict/resume in sprint+run language) so the
   * fastpath can print a single task-language next step instead.
   */
  readonly fastpath?: boolean;
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
        ['add to repokernel.config.yaml:', 'automation:', '  allowAutonomousClose: true'].join(
          '\n  ',
        ),
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
    // F4: only reject explicitly-passed unknown lanes. When the lane comes from
    // policies.defaultLane, fall through to the existing "0 runnable sprints"
    // path — that's more useful for fresh projects where no queue exists yet.
    if (opts.lane !== undefined) {
      const authoritativeLanes = new Set<string>([
        ...graph.laneFiles.map((l) => l.name),
        ...graph.queuesByLane.keys(),
      ]);
      if (!authoritativeLanes.has(lane)) {
        const known = [...authoritativeLanes].sort().join(', ') || '<none>';
        return err(
          'UNKNOWN_LANE',
          `lane "${lane}" has no lane file and no queue`,
          `known lanes: ${known}`,
        );
      }
    }
    const agentName = opts.agent ?? config.automation.defaultAgent;
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
        `resume with: ${resumeCommand(activeRun, controlCwd)}`,
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
        ['add to repokernel.config.yaml:', 'parallel:', '  allowOverlapFlag: true'].join('\n  '),
      );
    }
    if (opts.allowOverlap) {
      process.stderr.write(
        '\nWARNING: --allow-overlap is active.\nParallel execution may cause merge conflicts or unsafe file ownership.\n\n',
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

    // Pre-flight inversion: one cheap, strictly read-only pass before any
    // worktree, run record, or lane claim is created. Probes trust, runnable
    // sprints, lane/queue placement, dependencies, and path scope.
    const preflight = await epicPreflight({
      cwd: controlCwd,
      epicId: opts.epicId as EpicId,
      lane,
      agentName,
      strategy: effectiveStrategy,
      config,
      outcome,
    });

    // dry run / preflight — preview execution plan, write nothing
    if (opts.dryRun || opts.preflight) {
      const lines = [
        `dry-run: rk run ${opts.epicId}`,
        '',
        `  Epic:     ${epic.id} — ${epic.title}`,
        `  Lane:     ${lane}`,
        `  Agent:    ${agentName}`,
        `  Mode:     ${opts.mode}`,
        `  Strategy: ${effectiveStrategy}`,
        opts.worktree
          ? `  Worktree: ${worktreePath(opts.epicId as `E-${string}`, config, controlCwd)}`
          : '  Worktree: disabled (--no-worktree)',
        `  Branch:   ${worktreeBranch(opts.epicId as `E-${string}`, config)}`,
        '',
      ];

      if (effectiveStrategy === 'parallel') {
        const shipped = new Set<SprintId>();
        for (const sprint of graph.sprints.values()) {
          if (['shipped', 'cancelled'].includes(sprint.status)) {
            shipped.add(sprint.id);
          }
        }
        const epicParallelLimit = epic.parallel_limit ?? config.parallel.maxConcurrentSprints;
        const effectiveDryLimit = Math.min(
          epicParallelLimit,
          config.parallel.maxConcurrentSprints,
          opts.concurrency ?? Infinity,
          opts.limit ?? Infinity,
        );
        const waves = buildExecutionWaves(
          graph,
          opts.epicId as `E-${string}`,
          shipped,
          effectiveDryLimit,
          { lane },
        );
        lines.push(`Wave preview (limit: ${opts.limit ?? 'none'}):`);
        if (waves.length === 0) {
          lines.push('  (no runnable waves)');
        } else {
          for (const wave of waves) {
            const tag = wave.canParallelize ? 'parallel' : 'sequential';
            lines.push(`  Wave ${wave.index + 1} [${tag}]:`);
            for (const s of wave.sprints) {
              lines.push(`    ${s.id} — ${s.title}`);
            }
          }
        }
      } else {
        const { chain, ineligible, gate } = buildChain(
          outcome,
          lane,
          opts.limit ?? 99,
          config.chaining.sameEpicOnly,
          opts.epicId as `E-${string}`,
        );
        lines.push(`Chain preview (limit: ${opts.limit ?? 'none'}):`);
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
      }
      lines.push('', ...renderPreflight(preflight), '', 'No files written.');
      // --dry-run is informational (always exit 0); --preflight is a CI gate
      // that fails when any check failed.
      const previewExit = opts.preflight && preflight.blocking ? EXIT_BLOCKED : EXIT_OK;
      return { exitCode: previewExit, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }

    // Refuse before acquiring any resource when a pre-flight check failed.
    if (preflight.blocking) {
      return preflightBlockedError(preflight);
    }

    const runner = getRunner(agentName, config.agents);

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
        agent: agentName,
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
        owner_pid: process.pid,
        abort_requested: false,
      },
      opRoot,
    );

    // Claim lane — the claimLane lock re-checks atomically inside.
    // If this throws, mark the run as aborted so rk runs shows it correctly.
    try {
      await claimLane(laneClaimKey, run.id, run.epic_id, executionCwd, branch, opRoot);
    } catch (e) {
      await updateRun(
        run.id,
        {
          status: 'aborted',
          halt_reason: null,
          ended_at: isoNow(),
          abort_requested: false,
        },
        opRoot,
      ).catch(() => null);
      // Release worktree acquired above — no agent ran so tree is clean; force avoids dirty check.
      if (opts.worktree && config.worktrees.autoAcquire) {
        await releaseWorktree(opts.epicId as EpicId, config, controlCwd, true).catch(() => null);
      }
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
      // The parallel path does not run the reviewer-gate pipeline (no `rk review`
      // gate, no review-sprint). If a gate is configured and any epic sprint
      // requires review, refuse upfront instead of dead-ending at close — those
      // sprints must ship via sequential `rk run` or be gated + closed manually.
      if (resolveReviewerGate(outcome.config.automation) !== null) {
        const gated = [...outcome.graph.sprints.values()].find(
          (s) =>
            s.epic_id === opts.epicId &&
            !['shipped', 'cancelled'].includes(s.status) &&
            effectiveReviewRequired(s, outcome.config),
        );
        if (gated) {
          return err(
            'PARALLEL_GATE_UNSUPPORTED',
            `epic ${opts.epicId} configures a reviewer gate and ${gated.id} requires review, but parallel runs do not execute the reviewer gate`,
            `run sequentially (omit --parallel / set execution_strategy: sequential), or gate + close each sprint manually with rk review-gate`,
          );
        }
      }
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
  config: Config,
  opts: RunCommandOptions,
  runner: AgentRunner,
): Promise<CommandResult> {
  let run = initialRun;

  // Register a SIGTERM/SIGINT handler so an owner-side abort kills the active
  // agent child before the owner exits. Lane release and run-state finalization
  // are performed by `runRunAbortCommand` BEFORE SIGTERM is sent, so this only
  // needs to handle process-tree teardown.
  const uninstallAbort = installOwnerAbortHandler();

  try {
    while (true) {
      run = await assertRunNotAborted(run, opRoot);
      // check limit
      if (run.limit !== null && run.sprint_count >= run.limit) {
        run = await updateRun(
          run.id,
          { status: 'paused', halt_reason: HALT_REASONS.LIMIT_REACHED },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        process.stdout.write(
          [
            '',
            `Run ${run.id} paused — limit of ${run.limit} sprint(s) reached`,
            `  Resume with: ${resumeCommand(run, controlCwd)}`,
            '',
          ].join('\n'),
        );
        return { exitCode: EXIT_OK, stdout: '', stderr: '' };
      }

      // a. resolve next sprint
      const projectOutcome = await loadProject({ cwd: executionCwd });
      if (!projectOutcome.ok) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: HALT_REASONS.CONFIG_ERROR, ended_at: isoNow() },
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
            'Resolve the gate, then resume:',
            `  rk gate resolve ${gate.gate ?? '<gate-name>'}`,
            `  ${resumeCommand(run, controlCwd)}`,
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
        const haltReason = allDone ? HALT_REASONS.EPIC_COMPLETED : HALT_REASONS.NO_RUNNABLE_SPRINT;
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
          { status: 'failed', halt_reason: HALT_REASONS.EPIC_NOT_FOUND, ended_at: isoNow() },
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
      // worktree: false — the run loop already owns the execution worktree;
      // an explicit `never` keeps rk run's behavior independent of env
      // detection and removes any double-acquire risk.
      const startResult = await runStartCommand(sprint.id, {
        cwd: executionCwd,
        force: false,
        enqueue: false,
        dryRun: false,
        json: false,
        worktree: false,
      });
      if (startResult.stdout) process.stdout.write(startResult.stdout);
      if (startResult.stderr) process.stderr.write(startResult.stderr);
      if (startResult.exitCode !== EXIT_OK) {
        run = await updateRun(
          run.id,
          {
            status: 'failed',
            halt_reason: `${HALT_REASONS.AGENT_FAILED}:${sprint.id}`,
            ended_at: isoNow(),
          },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return startResult;
      }

      run = await updateRun(run.id, { current_sprint: sprint.id }, opRoot);

      // d. invoke agent
      const registryPath = join(executionCwd, projectOutcome.config.paths.registry);
      // Snapshot dirty files before agent runs. runStartCommand writes sprint metadata
      // and refreshes the registry without committing, so those will appear dirty.
      // We only care if the agent itself introduces NEW uncommitted files.
      const dirtyBeforeAgent = new Set(await getDirtyFiles(executionCwd));
      let agentResult: SprintRunResult;
      try {
        run = await assertRunNotAborted(run, opRoot);
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
      run = await assertRunNotAborted(run, opRoot);

      if (run.mode === 'autonomous') {
        const checkpoint = await checkpointAutonomousSprint({
          cwd: executionCwd,
          sprintId: sprint.id,
          allowedPaths: sprint.allowed_paths,
          generatedPaths: sprint.generated_paths,
        });
        if (checkpoint !== null) {
          run = await updateRun(run.id, { checkpoint_sha: checkpoint.sha }, opRoot);
        }
      }

      // e. post-agent validation — check clean tree (mirrors parallel worker contract).
      // Flag only files that became dirty DURING the agent run (new uncommitted changes).
      if (agentResult.status === 'completed') {
        const dirtyAfterAgent = await getDirtyFiles(executionCwd);
        const newDirty = dirtyAfterAgent.filter((f) => !dirtyBeforeAgent.has(f));
        if (newDirty.length > 0) {
          agentResult = {
            ...agentResult,
            status: 'failed',
            summary: 'working tree has uncommitted changes after agent run',
          };
        }
      }

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
          `inspect: rk run inspect ${run.id}`,
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
          {
            status: 'paused',
            halt_reason: HALT_REASONS.AWAITING_REVIEW,
            current_sprint: sprint.id,
          },
          opRoot,
        );

        // The fastpath prints its own single task-language next step; the
        // sprint/run plumbing block here would be a second, competing one.
        if (!opts.fastpath) {
          process.stdout.write(
            [
              '',
              `${pc.bold('Run paused')} — awaiting review`,
              `  Sprint: ${sprint.id}`,
              `  Review: ${reviewId}`,
              '',
              `Next steps:`,
              `  1. Review the sprint changes`,
              `  2. ${pc.dim(reviewVerdictCommand(run, reviewId))}`,
              `  3. ${pc.dim(resumeCommand(run, controlCwd))}`,
              '',
            ].join('\n'),
          );
        }

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
            halt_reason: HALT_REASONS.REVIEW_NOT_ACCEPTED,
            completed_sprints: [...run.completed_sprints, record],
            current_sprint: null,
          },
          opRoot,
        );
        return err(
          'REVIEW_NOT_ACCEPTED',
          `autonomous mode: agent review verdict was ${agentResult.review?.verdict ?? 'missing'}`,
          `resume with manual review: ${resumeCommand(run, controlCwd)}`,
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
          {
            status: 'failed',
            halt_reason: `${HALT_REASONS.REVIEW_FAILED}:${sprint.id}`,
            ended_at: isoNow(),
          },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return reviewResult;
      }

      // Built-in review lane. `rk review` runs the reviewer gate (when one is
      // configured), which records ONLY its signed snapshot and leaves
      // review.verdict pending. Evaluate the built-in rules so the composed
      // close gate (snapshot + review.verdict) can pass, then commit the verdict
      // so the tree is clean for runCloseCommand.
      const evalResult = await runReviewSprintCommand(sprint.id, {
        cwd: executionCwd,
        dryRun: false,
        json: false,
      });
      if (evalResult.exitCode !== EXIT_OK) {
        run = await updateRun(
          run.id,
          {
            status: 'failed',
            halt_reason: `${HALT_REASONS.REVIEW_FAILED}:${sprint.id}`,
            ended_at: isoNow(),
          },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return evalResult;
      }
      const evalOutcome = await loadProject({ cwd: executionCwd });
      const evalReview = evalOutcome.ok
        ? evalOutcome.graph.reviews.get(evalOutcome.graph.sprints.get(sprint.id)?.review_id ?? '')
        : undefined;
      if (evalReview?.file) {
        await stagePathsAndCommit(
          executionCwd,
          [join(executionCwd, evalReview.file), join(executionCwd, config.paths.registry)],
          `chore(rk): record review verdict for ${sprint.id}`,
        );
      }
      // `review-sprint` exits 0 even when it records changes_requested/rejected.
      // Halt as a REVIEW failure (not a downstream CLOSE failure) so run state
      // names the real cause.
      if (evalReview && evalReview.verdict !== 'accepted') {
        run = await updateRun(
          run.id,
          {
            status: 'failed',
            halt_reason: `${HALT_REASONS.REVIEW_FAILED}:${sprint.id}`,
            ended_at: isoNow(),
          },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot, run.id);
        return err(
          'REVIEW_NOT_ACCEPTED',
          `autonomous mode: built-in review verdict for ${sprint.id} was ${evalReview.verdict}`,
          `address the findings and re-run, or review ${sprint.id} manually`,
        );
      }

      // runReviewCommand + the verdict commit above leave a clean tree for
      // runCloseCommand (which requires one) below.
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
          {
            status: 'failed',
            halt_reason: `${HALT_REASONS.CLOSE_FAILED}:${sprint.id}`,
            ended_at: isoNow(),
          },
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
        start_sha: closedSprint?.base_sha ?? null,
        end_sha: closedSprint?.end_sha ?? null,
      };

      // runCloseCommand auto-commits its close-side `.repokernel/` mutations,
      // leaving a clean tree for the next iteration and a fully-recorded repo.
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
      exitCode: exitCodeForHalt(run.halt_reason),
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
    if (e instanceof RunAbortRequestedError) {
      return finalizeAbortedRun(run, opRoot);
    }
    await updateRun(run.id, { status: 'failed', ended_at: isoNow() }, opRoot).catch(() => null);
    await releaseLane(`epic-${run.epic_id}`, opRoot, run.id).catch(() => null);
    // Self-clean the acquired epic worktree so an unexpected throw never
    // leaves an orphan behind. Best-effort and non-fatal — it must never
    // mask the original error.
    if (opts.worktree && config.worktrees.autoAcquire) {
      await releaseWorktree(run.epic_id, config, controlCwd, true).catch(() => null);
    }
    return runtimeErr(e);
  } finally {
    uninstallAbort();
  }
}

// — parallel run loop —

async function executeParallelRunLoop(
  initialRun: Run,
  opRoot: string,
  controlCwd: string,
  epicWorktree: string,
  config: Config,
  opts: RunCommandOptions,
  runner: AgentRunner,
): Promise<CommandResult> {
  let run = initialRun;
  const epicId = run.epic_id;

  // Same SIGTERM/SIGINT teardown as the sequential loop — protects parallel
  // workers' agent process trees from orphaning on owner-side abort.
  const uninstallAbort = installOwnerAbortHandler();

  try {
    while (true) {
      run = await assertRunNotAborted(run, opRoot);
      // Reload project from epic worktree each iteration to get fresh state
      const projectOutcome = await loadProject({ cwd: epicWorktree });
      if (!projectOutcome.ok) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: HALT_REASONS.CONFIG_ERROR, ended_at: isoNow() },
          opRoot,
        );
        return configError();
      }

      const { graph, config } = projectOutcome;
      const epic = graph.epics.get(epicId);
      if (!epic) {
        run = await updateRun(
          run.id,
          { status: 'failed', halt_reason: HALT_REASONS.EPIC_NOT_FOUND, ended_at: isoNow() },
          opRoot,
        );
        return err('EPIC_NOT_FOUND', `epic ${epicId} not found`);
      }

      // Check run limit
      if (run.limit !== null && run.sprint_count >= run.limit) {
        run = await updateRun(
          run.id,
          { status: 'paused', halt_reason: HALT_REASONS.LIMIT_REACHED },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        process.stdout.write(
          [
            '',
            `Run ${run.id} paused — limit of ${run.limit} sprint(s) reached`,
            `  Resume with: ${resumeCommand(run, controlCwd)}`,
            '',
          ].join('\n'),
        );
        return { exitCode: EXIT_OK, stdout: '', stderr: '' };
      }

      // Build shipped set from current graph state (authoritative after each wave close).
      // Canonical rule (see core/graph/readiness.ts): only `shipped` upstream
      // satisfies a downstream dep. Cancelled upstream is a soft block — the
      // downstream sprint stays unrunnable until a human cancels or re-targets it.
      const shipped = buildSatisfiedSprints(graph.sprints.values()) as Set<SprintId>;

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
        if (allDone) {
          run = await updateRun(
            run.id,
            { status: 'completed', halt_reason: HALT_REASONS.EPIC_COMPLETED, ended_at: isoNow() },
            opRoot,
          );
          await releaseLane(`epic-${epicId}`, opRoot, run.id);
          break;
        }
        // Check if remaining sprints are all blocked by a gate
        const gatedSprints = epicSprints.filter(
          (s) => !['shipped', 'cancelled'].includes(s.status) && s.gate,
        );
        if (gatedSprints.length > 0) {
          const gateName = gatedSprints[0]!.gate!;
          const haltReason = `gate_blocked:${gateName}`;
          run = await updateRun(
            run.id,
            { status: 'paused', halt_reason: haltReason, ended_at: isoNow() },
            opRoot,
          );
          await releaseLane(`epic-${epicId}`, opRoot, run.id);
          return {
            exitCode: EXIT_OK,
            stdout: [
              '',
              `Run ${run.id} halted at gate`,
              `  Gate: ${gateName}`,
              '',
              'Resolve the gate, then resume:',
              `  rk gate resolve ${gateName}`,
              `  ${resumeCommand(run, controlCwd)}`,
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        run = await updateRun(
          run.id,
          { status: 'completed', halt_reason: HALT_REASONS.NO_RUNNABLE_SPRINT, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        break;
      }

      const wave = waves[0]!;
      const totalWaves = waves.length; // waves from current iteration only; indicates remaining

      // 1. Path conflict preflight (skip when --allow-overlap is set)

      // Sprints without allowed_paths have unconstrained scope and cannot safely run in parallel.
      const unscopedSprints = wave.sprints.filter((s) => s.allowed_paths.length === 0);
      if (unscopedSprints.length > 0) {
        const ids = unscopedSprints.map((s) => s.id).join(', ');
        run = await updateRun(
          run.id,
          { status: 'paused', halt_reason: HALT_REASONS.UNSCOPED_PARALLEL_SPRINT },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        return err(
          'UNSCOPED_PARALLEL_SPRINT',
          `sprint(s) ${ids} have no allowed_paths — scope-unconstrained sprints cannot run in parallel`,
          'add an allowed_paths list to each sprint frontmatter, or switch the epic to sequential execution',
        );
      }

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
        run = await updateRun(
          run.id,
          { status: 'paused', halt_reason: HALT_REASONS.PATH_CONFLICT },
          opRoot,
        );
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
          wave.sprints.map((s) => s.id),
          reviewsDir,
          opRoot,
          effectiveReviewer(config.automation),
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
            sprint.id,
            epicWorktree,
            config,
            controlCwd,
          );
          sprintEntries.push({
            sprint,
            worktree: sprintInfo.path,
            branch: sprintInfo.branch,
            reviewId: reviewIdMap.get(sprint.id)?.reviewId ?? `R-???`,
          });
        }

        // Update run state
        const workers: ParallelWorker[] = sprintEntries.map((e) => ({
          sprint_id: e.sprint.id,
          worktree: e.worktree,
          branch: e.branch,
          status: 'running' as const,
          started_at: isoNow(),
        }));

        const pendingWave: PendingWave = {
          index: wave.index,
          status: 'running',
          sprint_ids: wave.sprints.map((s) => s.id),
          branches: Object.fromEntries(sprintEntries.map((e) => [e.sprint.id, e.branch])),
        };

        run = await updateRun(
          run.id,
          {
            wave_index: wave.index,
            active_sprints: wave.sprints.map((s) => s.id),
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

      run = await assertRunNotAborted(run, opRoot);
      const waveResult = await runWaveParallel(workerInputs, {
        globalCap: config.parallel.maxConcurrentSprints,
        capByState: config.parallel.maxConcurrentSprintsByState,
      });
      run = await assertRunNotAborted(run, opRoot);

      // 7. Handle worker failures
      if (waveResult.failed.length > 0) {
        const failedIds = waveResult.failed.map((f) => f.sprint.id).join(', ');
        run = await updateRun(
          run.id,
          {
            status: 'failed',
            halt_reason: `${HALT_REASONS.AGENT_FAILED}:${failedIds}`,
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
        const awaitingReviews = waveResult.completed.map((c) => ReviewIdSchema.parse(c.reviewId));
        const pendingWave: PendingWave = {
          index: wave.index,
          status: 'awaiting_reviews',
          sprint_ids: wave.sprints.map((s) => s.id),
          awaiting_reviews: awaitingReviews,
          branches: Object.fromEntries(waveResult.completed.map((c) => [c.sprint.id, c.branch])),
        };
        run = await updateRun(
          run.id,
          {
            status: 'paused',
            halt_reason: HALT_REASONS.AWAITING_REVIEWS,
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
            `Next steps:`,
            ...waveResult.completed.map(
              (c, i) => `  ${i + 1}. ${pc.dim(reviewVerdictCommand(run, c.reviewId))}`,
            ),
            `  ${waveResult.completed.length + 1}. ${pc.dim(resumeCommand(run, controlCwd))}`,
            '',
            `Run ${run.id} paused — awaiting_reviews`,
            '',
          ].join('\n'),
        );

        return { exitCode: EXIT_OK, stdout: '', stderr: '' };
      }

      // 9. Autonomous: auto-accept reviews (agent provided self-review)
      const notAccepted = waveResult.completed.find(
        (completed) => !completed.result.review || completed.result.review.verdict !== 'accepted',
      );
      if (notAccepted) {
        run = await updateRun(
          run.id,
          {
            status: 'failed',
            halt_reason: `${HALT_REASONS.REVIEW_NOT_ACCEPTED}:${notAccepted.sprint.id}`,
            active_sprints: [],
            ended_at: isoNow(),
          },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        return err(
          'REVIEW_NOT_ACCEPTED',
          `autonomous mode: agent review verdict for ${notAccepted.sprint.id} was ${notAccepted.result.review?.verdict ?? 'missing'}`,
          'inspect sprint worktree and rerun after review is corrected',
        );
      }
      await withLifecycleScope(
        { cwd: epicWorktree, command: 'run-parallel-review-writes', args: { runId: run.id } },
        async () => {
          for (const completed of waveResult.completed) {
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
        },
      );

      // 10. Merge (under wave lock — marks pending_wave.status = merging)
      const sprintBranchEntries = waveResult.completed.map((c) => ({
        sprintId: c.sprint.id,
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

      run = await assertRunNotAborted(run, opRoot);
      const mergeResult = await mergeWaveBranches(epicWorktree, sprintBranchEntries);

      if (!mergeResult.success && mergeResult.firstConflict) {
        run = await updateRun(
          run.id,
          {
            status: 'paused',
            halt_reason: `${HALT_REASONS.MERGE_CONFLICT}:${mergeResult.firstConflict.sprintId}`,
            pending_wave: run.pending_wave
              ? { ...run.pending_wave, status: 'failed' as const }
              : undefined,
          },
          opRoot,
        );
        await releaseLane(`epic-${epicId}`, opRoot, run.id);
        // Release worktrees of sprints already merged — only the conflicted sprint stays preserved.
        for (const mergedId of mergeResult.merged) {
          await releaseSprintWorktree(epicId, mergedId, config, controlCwd).catch(() => null);
        }
        const conflictFiles = mergeResult.firstConflict.conflictingFiles.join(', ');
        const mergedLabel =
          mergeResult.merged.length > 0
            ? `merged: [${mergeResult.merged.join(', ')}] (worktrees released); `
            : '';
        return err(
          'MERGE_CONFLICT',
          `merge conflict in sprint ${mergeResult.firstConflict.sprintId}: ${conflictFiles}`,
          `${mergedLabel}conflicted: ${mergeResult.firstConflict.sprintId} (worktree preserved)\n  resolve manually, then start a fresh run`,
        );
      }

      // 11. Close all wave sprints in epic worktree
      const closeTouched = new Set<string>();
      await withLifecycleScope(
        {
          cwd: epicWorktree,
          command: 'run-parallel-wave-close',
          args: { runId: run.id, waveIndex: wave.index },
        },
        async (tx) => {
          for (const sprintId of mergeResult.merged) {
            const reviewId = reviewIdMap.get(sprintId)?.reviewId ?? '';
            for (const path of await closeAfterMerge(sprintId, reviewId, epicWorktree)) {
              closeTouched.add(path);
            }
          }
          // Refresh and commit close metadata so next-wave worktrees branch from committed state.
          await tx.refreshRegistry();
        },
      );
      closeTouched.add(config.paths.registry);
      run = await assertRunNotAborted(run, opRoot);
      await stagePathsAndCommit(
        epicWorktree,
        [...closeTouched],
        `rk: close wave ${wave.index} (${mergeResult.merged.join(', ')})`,
      );
      const postCloseOutcome = await loadProject({ cwd: epicWorktree });
      if (!postCloseOutcome.ok) return configError();

      // 12. Advance + release merged sprint worktrees (under wave lock)
      await withWaveLock(run.id, opRoot, async () => {
        for (const completed of waveResult.completed) {
          if (mergeResult.merged.includes(completed.sprint.id)) {
            await releaseSprintWorktree(epicId, completed.sprint.id, config, controlCwd).catch(
              () => null,
            );
          }
        }

        const newRecords: RunSprintRecord[] = mergeResult.merged.map((id) => ({
          id,
          verdict: 'accepted' as const,
          summary_path: join(opRoot, 'runs', run.id, 'summaries', `${id}.md`),
          start_sha: postCloseOutcome.graph.sprints.get(id)?.base_sha ?? null,
          end_sha: postCloseOutcome.graph.sprints.get(id)?.end_sha ?? null,
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
      exitCode: exitCodeForHalt(run.halt_reason),
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
    if (e instanceof RunAbortRequestedError) {
      return finalizeAbortedRun(run, opRoot);
    }
    await updateRun(run.id, { status: 'failed', ended_at: isoNow() }, opRoot).catch(() => null);
    await releaseLane(`epic-${epicId}`, opRoot, run.id).catch(() => null);
    // Self-clean acquired worktrees so an unexpected throw never leaves an
    // orphan behind. Best-effort and non-fatal — must not mask the original
    // error. Sprint worktrees first, then the epic worktree they branch from.
    if (opts.worktree && config.worktrees.autoAcquire) {
      for (const sprintId of run.active_sprints) {
        await releaseSprintWorktree(epicId, sprintId, config, controlCwd).catch(() => null);
      }
      await releaseWorktree(epicId, config, controlCwd, true).catch(() => null);
    }
    return runtimeErr(e);
  } finally {
    uninstallAbort();
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

  // completion states — run ended normally, nothing to resume
  if (
    run.halt_reason === HALT_REASONS.EPIC_COMPLETED ||
    run.halt_reason === HALT_REASONS.NO_RUNNABLE_SPRINT
  ) {
    return err(
      'RUN_TERMINAL',
      `run ${runId} already completed (halt_reason: ${run.halt_reason})`,
      `start a fresh run: rk run ${run.epic_id}`,
    );
  }

  // unrecoverable failure states — user must fix root cause and start fresh
  if (
    run.halt_reason === HALT_REASONS.CONFIG_ERROR ||
    run.halt_reason === HALT_REASONS.EPIC_NOT_FOUND ||
    run.halt_reason === HALT_REASONS.PATH_CONFLICT ||
    run.halt_reason === HALT_REASONS.UNSCOPED_PARALLEL_SPRINT
  ) {
    return err(
      'RUN_TERMINAL',
      `run ${runId} ended in an unrecoverable state (halt_reason: ${run.halt_reason})`,
      `inspect: rk run inspect ${runId}\n  fix the issue, then start a fresh run: rk run ${run.epic_id}`,
    );
  }

  // user aborted — nothing to resume
  if (run.halt_reason === HALT_REASONS.USER_ABORT) {
    return err(
      'RUN_ABORTED',
      `run ${runId} was aborted by user`,
      `start a fresh run: rk run ${run.epic_id}`,
    );
  }

  const executionCwd = run.worktree;
  const initOutcome = await loadProject({ cwd: controlCwd });
  const agentDefs = initOutcome.ok ? initOutcome.config.agents : {};
  const runner = getRunner(run.agent, agentDefs);

  if (run.halt_reason === HALT_REASONS.AWAITING_REVIEW) {
    // re-claim lane if needed (use epic-scoped key consistent with initial claim)
    const claimError = await ensureRunOwnsEpicClaim(run, opRoot);
    if (claimError) return claimError;

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
        reviewVerdictCommand(run, sprint.review_id),
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
    // runCloseCommand auto-commits its close-side `.repokernel/` mutations.

    const summaryPath = join(opRoot, 'runs', run.id, 'summaries', `${sprint.id}.md`);
    const record: RunSprintRecord = {
      id: sprint.id,
      verdict: 'accepted',
      summary_path: summaryPath,
      start_sha: closedSprint?.base_sha ?? sprint.base_sha ?? null,
      end_sha: closedSprint?.end_sha ?? null,
    };

    run = await updateRun(
      run.id,
      {
        status: 'running',
        halt_reason: null,
        owner_pid: process.pid,
        abort_requested: false,
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
        { status: 'completed', halt_reason: HALT_REASONS.LIMIT_REACHED, ended_at: isoNow() },
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
  if (run.halt_reason === HALT_REASONS.AWAITING_REVIEWS && run.execution_strategy === 'parallel') {
    const claimError = await ensureRunOwnsEpicClaim(run, opRoot);
    if (claimError) return claimError;

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
          reviewVerdictCommand(run, reviewId),
        );
      }
    }

    // Merge + close + advance
    const sprintBranchEntries = Object.entries(pendingWave.branches).map(([sprintId, branch]) => ({
      sprintId: SprintIdSchema.parse(sprintId),
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
          halt_reason: `${HALT_REASONS.MERGE_CONFLICT}:${mergeResult.firstConflict.sprintId}`,
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

    const closeTouched = new Set<string>();
    await withLifecycleScope(
      {
        cwd: executionCwd,
        command: 'run-parallel-wave-close',
        args: { runId: run.id, waveIndex: pendingWave.index, resume: true },
      },
      async (tx) => {
        for (const sprintId of mergeResult.merged) {
          const reviewId =
            (pendingWave.awaiting_reviews ?? []).find(
              (r) => projectOutcome.graph.reviews.get(r)?.sprint_id === sprintId,
            ) ?? '';
          for (const path of await closeAfterMerge(sprintId, reviewId, executionCwd)) {
            closeTouched.add(path);
          }
        }
        await tx.refreshRegistry();
      },
    );
    closeTouched.add(projectOutcome.config.paths.registry);
    await stagePathsAndCommit(
      executionCwd,
      [...closeTouched],
      `rk: close wave ${pendingWave.index} (${mergeResult.merged.join(', ')})`,
    );

    const continuationOutcome2 = await loadProject({ cwd: executionCwd });
    if (!continuationOutcome2.ok) return configError();

    const newRecords: RunSprintRecord[] = mergeResult.merged.map((id) => ({
      id,
      verdict: 'accepted' as const,
      summary_path: join(opRoot, 'runs', run.id, 'summaries', `${id}.md`),
      start_sha: continuationOutcome2.graph.sprints.get(id)?.base_sha ?? null,
      end_sha: continuationOutcome2.graph.sprints.get(id)?.end_sha ?? null,
    }));

    for (const sprintId of mergeResult.merged) {
      await releaseSprintWorktree(
        run.epic_id,
        sprintId,
        continuationOutcome2.config,
        controlCwd,
      ).catch(() => null);
    }

    run = await updateRun(
      run.id,
      {
        status: 'running',
        halt_reason: null,
        owner_pid: process.pid,
        abort_requested: false,
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

  // limit_reached: continue the appropriate run loop with no limit change
  if (run.halt_reason === HALT_REASONS.LIMIT_REACHED) {
    const claimError = await ensureRunOwnsEpicClaim(run, opRoot);
    if (claimError) return claimError;
    run = await updateRun(
      run.id,
      { status: 'running', halt_reason: null, owner_pid: process.pid, abort_requested: false },
      opRoot,
    );
    const continuationOutcome = await loadProject({ cwd: executionCwd });
    if (!continuationOutcome.ok) return configError();
    if (run.execution_strategy === 'parallel') {
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

  // merge_conflict: preserved worktrees — tell user where to look
  if (run.halt_reason?.startsWith(`${HALT_REASONS.MERGE_CONFLICT}:`)) {
    const conflictSprint = run.halt_reason.slice(`${HALT_REASONS.MERGE_CONFLICT}:`.length);
    const worktreesJsonPath = join(opRoot, 'worktrees.json');
    let worktreeHint = `sprint worktree for ${conflictSprint}`;
    try {
      const { readFile: rf } = await import('node:fs/promises');
      const wt = JSON.parse(await rf(worktreesJsonPath, 'utf8')) as {
        worktrees: Array<{ sprintId?: string; path: string }>;
      };
      const entry = wt.worktrees.find((w) => w.sprintId === conflictSprint);
      if (entry) worktreeHint = entry.path;
    } catch {
      // fall through to generic hint
    }
    return err(
      'MERGE_CONFLICT',
      `run ${runId} is paused due to merge conflict in ${conflictSprint}`,
      `inspect worktree: ${worktreeHint}\n  resolve conflict, then start a fresh run`,
    );
  }

  // gate: / gate_blocked: — re-enter run loop after gate resolved
  if (run.halt_reason?.startsWith('gate:') || run.halt_reason?.startsWith('gate_blocked:')) {
    const claimError = await ensureRunOwnsEpicClaim(run, opRoot);
    if (claimError) return claimError;
    run = await updateRun(
      run.id,
      { status: 'running', halt_reason: null, owner_pid: process.pid, abort_requested: false },
      opRoot,
    );
    const continuationOutcome = await loadProject({ cwd: executionCwd });
    if (!continuationOutcome.ok) return configError();
    if (run.execution_strategy === 'parallel') {
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

  // agent_failed / agent_skipped: non-resumable — show summary
  if (run.halt_reason?.startsWith('agent_') || run.halt_reason?.startsWith('review_')) {
    return err(
      'RUN_FAILED',
      `run ${runId} failed: ${run.halt_reason}`,
      `inspect: rk run inspect ${runId}\n  fix the issue, then start a fresh run`,
    );
  }

  // defensive fallback — should not be reachable in normal operation
  return err(
    'RESUME_UNSUPPORTED',
    `run ${runId} cannot be resumed (halt_reason: "${run.halt_reason ?? 'unknown'}", status: ${run.status})`,
    `inspect: rk run inspect ${runId}`,
  );
}

// — helpers —

class RunAbortRequestedError extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} was aborted`);
  }
}

async function assertRunNotAborted(run: Run, opRoot: string): Promise<Run> {
  const latest = await loadRun(run.id, opRoot);
  if (
    latest.abort_requested ||
    latest.status === 'aborted' ||
    latest.halt_reason === HALT_REASONS.USER_ABORT
  ) {
    throw new RunAbortRequestedError(run.id);
  }
  return latest;
}

async function finalizeAbortedRun(run: Run, opRoot: string): Promise<CommandResult> {
  await updateRun(
    run.id,
    {
      status: 'aborted',
      halt_reason: HALT_REASONS.USER_ABORT,
      ended_at: isoNow(),
      current_sprint: null,
      active_sprints: [],
      abort_requested: true,
    },
    opRoot,
  ).catch(() => null);
  await releaseLane(`epic-${run.epic_id}`, opRoot, run.id).catch(() => null);
  return { exitCode: EXIT_OK, stdout: `Run ${run.id} aborted.\n`, stderr: '' };
}

async function ensureRunOwnsEpicClaim(run: Run, opRoot: string): Promise<CommandResult | null> {
  const claimKey = `epic-${run.epic_id}`;
  const state = await getLaneState(claimKey, opRoot);
  if (!state) {
    await claimLane(claimKey, run.id, run.epic_id, run.worktree, run.branch, opRoot);
    return null;
  }
  if (state.run_id !== run.id) {
    return err(
      'LANE_CLAIMED',
      `epic ${run.epic_id} is claimed by run ${state.run_id}`,
      `wait for ${state.run_id} to finish or abort it before resuming ${run.id}`,
    );
  }
  return null;
}

function signalOwnerProcess(run: Run): void {
  if (!run.owner_pid || run.owner_pid === process.pid) return;
  try {
    process.kill(run.owner_pid, 'SIGTERM');
  } catch {
    // The owner may already have exited after observing abort_requested.
  }
}

function err(_code: string, message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${lines.join('\n')}\n` };
}

/** Maps the first failed pre-flight check to a stable error code + hint. */
function preflightBlockedError(preflight: EpicPreflightResult): CommandResult {
  const failed = preflight.checks.filter((c) => c.status === 'fail');
  const first = failed[0];
  const codeById: Record<string, string> = {
    'epic-status': 'INVALID_EPIC_STATUS',
    'runnable-sprints': 'NO_RUNNABLE_SPRINT',
    trust: 'TRUST_DENIED',
    'queue-position': 'NOT_HEAD_OF_QUEUE',
    'path-scope-coverage': 'UNSCOPED_SPRINT',
  };
  const code = first ? (codeById[first.id] ?? 'PREFLIGHT_FAILED') : 'PREFLIGHT_FAILED';
  const message = first ? `pre-flight failed: ${first.detail}` : 'pre-flight failed';
  const others = failed.slice(1);
  const hint =
    others.length > 0
      ? `also failing: ${others.map((c) => c.id).join(', ')} — run rk run --preflight ${preflight.epicId}`
      : `run rk run --preflight ${preflight.epicId} for the full report`;
  return err(code, message, hint);
}

/**
 * Exit code for a completed run, keyed on its halt reason. A run that ended
 * because nothing could run (NO_RUNNABLE_SPRINT) exits non-zero; every other
 * terminal/paused reason — EPIC_COMPLETED, LIMIT_REACHED, gate, AWAITING_REVIEW
 * — is a legitimate exit 0.
 */
function exitCodeForHalt(haltReason: string | null): number {
  return haltReason === HALT_REASONS.NO_RUNNABLE_SPRINT ? EXIT_BLOCKED : EXIT_OK;
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
  const { git } = await import('../lifecycle/gitExec.js');
  try {
    const { stdout } = await git(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

// — run subcommands —

export interface RunInspectOptions {
  readonly cwd: string;
  readonly json: boolean;
}

function haltNextStep(run: Run, controlCwd: string): string {
  const r = run.halt_reason ?? '';
  if (r === HALT_REASONS.AWAITING_REVIEW) {
    return `${reviewVerdictCommand(run, '<review-id>')}\n  ${resumeCommand(run, controlCwd)}`;
  }
  if (r === HALT_REASONS.AWAITING_REVIEWS) {
    const reviewIds = run.pending_wave?.awaiting_reviews ?? [];
    const cmds = reviewIds.map((id) => reviewVerdictCommand(run, id)).join('\n  ');
    return `${cmds}\n  ${resumeCommand(run, controlCwd)}`;
  }
  if (r === HALT_REASONS.LIMIT_REACHED) {
    return resumeCommand(run, controlCwd);
  }
  if (r.startsWith(`${HALT_REASONS.MERGE_CONFLICT}:`)) {
    return `resolve conflict in sprint ${r.slice(`${HALT_REASONS.MERGE_CONFLICT}:`.length)}, then start a fresh run`;
  }
  if (r.startsWith('agent_') || r.startsWith('review_')) {
    return `rk run inspect ${run.id} (check logs), then start a fresh run`;
  }
  if (r === HALT_REASONS.NO_RUNNABLE_SPRINT) {
    return 'all runnable sprints are done; add or unblock sprints, then rk run again';
  }
  if (r === HALT_REASONS.EPIC_COMPLETED) {
    return 'epic is complete';
  }
  if (r === HALT_REASONS.PATH_CONFLICT) {
    return 'resolve overlapping allowed_paths across sprints, then rk run again';
  }
  if (run.status === 'running') return 'run is active';
  return `rk run inspect ${run.id}`;
}

export async function runRunInspectCommand(
  runId: string,
  opts: RunInspectOptions,
): Promise<CommandResult> {
  const controlCwd = resolve(opts.cwd);
  try {
    const opRoot = await operationalRoot(controlCwd);
    let run: Run;
    try {
      run = await loadRun(runId, opRoot);
    } catch {
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `run ${runId} not found\n` };
    }

    if (opts.json) {
      return { exitCode: EXIT_OK, stdout: `${JSON.stringify(run, null, 2)}\n`, stderr: '' };
    }

    const statusColor =
      run.status === 'running'
        ? pc.green(run.status)
        : run.status === 'completed'
          ? pc.dim(run.status)
          : run.status === 'paused'
            ? pc.yellow(run.status)
            : pc.red(run.status);

    const lines: string[] = [
      '',
      `${pc.bold('Run')} ${run.id}`,
      `  Epic:     ${run.epic_id}`,
      `  Agent:    ${run.agent}`,
      `  Mode:     ${run.mode}`,
      `  Status:   ${statusColor}`,
      `  Sprints:  ${run.sprint_count}`,
      `  Started:  ${run.started_at.slice(0, 19).replace('T', ' ')}`,
    ];
    if (run.ended_at) lines.push(`  Ended:    ${run.ended_at.slice(0, 19).replace('T', ' ')}`);
    if (run.halt_reason) lines.push(`  Halt:     ${run.halt_reason}`);
    if (run.checkpoint_sha) lines.push(`  Checkpoint: ${run.checkpoint_sha.slice(0, 12)}`);

    if (run.completed_sprints.length > 0) {
      lines.push('', 'Completed sprints:');
      for (const s of run.completed_sprints) {
        lines.push(`  ${s.id}  verdict=${s.verdict}`);
      }
    }

    if (run.active_sprints.length > 0) {
      lines.push('', `Active: ${run.active_sprints.join(', ')}`);
    }

    if (run.pending_wave) {
      const pw = run.pending_wave;
      lines.push('', `Pending wave ${pw.index + 1}: ${pw.status}`);
      if (pw.awaiting_reviews?.length) {
        lines.push(`  Awaiting reviews: ${pw.awaiting_reviews.join(', ')}`);
      }
    }

    const next = haltNextStep(run, controlCwd);
    if (next) {
      lines.push('', `Next:`, `  ${next}`);
    }

    lines.push('');
    return { exitCode: EXIT_OK, stdout: lines.join('\n'), stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

function reviewVerdictCommand(run: Run, reviewId: string): string {
  return `rk review-verdict ${reviewId} accepted${cwdFlag(run.worktree)}`;
}

function resumeCommand(run: Run, controlCwd: string): string {
  return `rk run --resume ${run.id}${cwdFlag(controlCwd)}`;
}

function cwdFlag(cwd: string): string {
  return ` --cwd ${shellQuote(cwd)}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface RunLogsOptions {
  readonly cwd: string;
  readonly sprintId?: string;
  readonly tail?: number;
  readonly summary?: boolean;
}

export async function runRunLogsCommand(
  runId: string,
  opts: RunLogsOptions,
): Promise<CommandResult> {
  const controlCwd = resolve(opts.cwd);
  try {
    const opRoot = await operationalRoot(controlCwd);
    const { readFile: rf, readdir: rd } = await import('node:fs/promises');
    const logsDir = join(opRoot, 'runs', runId, 'logs');
    const summariesDir = join(opRoot, 'runs', runId, 'summaries');

    if (opts.summary === true) {
      return await formatRunSummaries({
        runId,
        summariesDir,
        readFile: rf,
        readdir: rd,
        ...(opts.sprintId !== undefined ? { sprintId: opts.sprintId } : {}),
      });
    }

    if (opts.sprintId) {
      const agentLog = join(logsDir, `${opts.sprintId}.agent.log`);
      const lifecycleLog = join(logsDir, `${opts.sprintId}.lifecycle.log`);
      const [agent, lifecycle] = await Promise.all([
        rf(agentLog, 'utf8').catch(() => '(empty)'),
        rf(lifecycleLog, 'utf8').catch(() => '(empty)'),
      ]);
      const out = [
        `=== ${opts.sprintId} agent log ===`,
        formatLogContent(agent, opts.tail),
        `=== ${opts.sprintId} lifecycle log ===`,
        formatLogContent(lifecycle, opts.tail),
        '',
      ].join('\n');
      return { exitCode: EXIT_OK, stdout: out, stderr: '' };
    }

    let files: string[];
    try {
      files = await rd(logsDir);
    } catch {
      return { exitCode: EXIT_OK, stdout: `(no logs for ${runId})\n`, stderr: '' };
    }

    if (files.length === 0) {
      return { exitCode: EXIT_OK, stdout: `(no logs for ${runId})\n`, stderr: '' };
    }

    if (opts.tail !== undefined) {
      const lines = ['', `Log tails for ${runId} (${opts.tail} lines):`, ''];
      for (const f of files.sort()) {
        const content = await rf(join(logsDir, f), 'utf8').catch(() => '(empty)');
        lines.push(`=== ${f} ===`, formatLogContent(content, opts.tail));
      }
      lines.push('');
      return { exitCode: EXIT_OK, stdout: lines.join('\n'), stderr: '' };
    }

    let summaryFiles: string[] = [];
    try {
      summaryFiles = await rd(summariesDir);
    } catch {
      // no summaries
    }

    const lines = ['', `Logs for ${runId}:`, ''];
    for (const f of files.sort()) {
      lines.push(`  ${logsDir}/${f}`);
    }
    if (summaryFiles.length > 0) {
      lines.push('', 'Summaries:');
      for (const f of summaryFiles.sort()) {
        lines.push(`  ${summariesDir}/${f}`);
      }
    }
    lines.push('');
    return { exitCode: EXIT_OK, stdout: lines.join('\n'), stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

async function formatRunSummaries(input: {
  readonly runId: string;
  readonly sprintId?: string;
  readonly summariesDir: string;
  readonly readFile: (path: string, encoding: 'utf8') => Promise<string>;
  readonly readdir: (path: string) => Promise<string[]>;
}): Promise<CommandResult> {
  const files =
    input.sprintId !== undefined
      ? [`${input.sprintId}.md`]
      : await input.readdir(input.summariesDir).catch(() => []);
  const sorted = files.filter((f) => f.endsWith('.md')).sort();
  if (sorted.length === 0) {
    return { exitCode: EXIT_OK, stdout: `(no summaries for ${input.runId})\n`, stderr: '' };
  }

  const lines = ['', `Summaries for ${input.runId}:`, ''];
  for (const f of sorted) {
    const content = await input.readFile(join(input.summariesDir, f), 'utf8').catch(() => null);
    if (content === null) continue;
    lines.push(`=== ${f} ===`, content.trimEnd(), '');
  }
  if (lines.length === 3) {
    return { exitCode: EXIT_OK, stdout: `(no summaries for ${input.runId})\n`, stderr: '' };
  }
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function formatLogContent(content: string, tail?: number): string {
  if (tail === undefined) return content;
  const lines = content.trimEnd().split(/\r?\n/);
  return `${lines.slice(-tail).join('\n')}\n`;
}

export async function runRunAbortCommand(
  runId: string,
  opts: { readonly cwd: string },
): Promise<CommandResult> {
  const controlCwd = resolve(opts.cwd);
  try {
    const opRoot = await operationalRoot(controlCwd);
    let run: Run;
    try {
      run = await loadRun(runId, opRoot);
    } catch {
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `run ${runId} not found\n` };
    }

    if (['completed', 'aborted'].includes(run.status)) {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr: `run ${runId} is already ${run.status}\n`,
      };
    }

    try {
      await updateRun(
        runId,
        {
          status: 'aborted',
          halt_reason: HALT_REASONS.USER_ABORT,
          ended_at: isoNow(),
          abort_requested: true,
          current_sprint: null,
          active_sprints: [],
        },
        opRoot,
      );
    } finally {
      await releaseLane(`epic-${run.epic_id}`, opRoot, runId).catch(() => null);
      signalOwnerProcess(run);
    }

    return { exitCode: EXIT_OK, stdout: `Run ${runId} aborted.\n`, stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}
