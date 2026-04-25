import { join, resolve } from 'node:path';
import {
  type Config,
  loadProject,
  meetsThreshold,
  RepoKernelError,
  type Run,
  type RunSprintRecord,
  runValidators,
} from '@repokernel/core';
import pc from 'picocolors';
import { getRunner } from '../agents/index.js';
import type { SprintRunResult } from '../agents/types.js';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { isWorktreeCheckout, operationalRoot } from '../lifecycle/controlPaths.js';
import { claimLane, isLaneClaimed, releaseLane } from '../lifecycle/laneState.js';
import { withLock } from '../lifecycle/locks.js';
import { refreshRegistry } from '../lifecycle/registry.js';
import { allocateRun, listRuns, loadRun, updateRun } from '../lifecycle/runState.js';
import {
  generateSprintPacket,
  loadPrevSummaries,
  writeSprintPacket,
  writeSummary,
} from '../lifecycle/sprintPacket.js';
import { acquireWorktree, worktreeBranch, worktreePath } from '../lifecycle/worktree.js';
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

    // dry run — preview chain
    if (opts.dryRun) {
      const { chain, ineligible, gate } = buildChain(
        outcome,
        lane,
        opts.limit ?? 99,
        config.chaining.sameEpicOnly,
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

    // — acquire worktree + lane —
    let executionCwd = controlCwd;
    let worktreeInfo: { path: string; branch: string; reused: boolean } | null = null;

    if (opts.worktree && config.worktrees.autoAcquire) {
      worktreeInfo = await withLock(`worktree-${opts.epicId}`, opRoot, () =>
        acquireWorktree(opts.epicId as `E-${string}`, config, controlCwd),
      );
      executionCwd = worktreeInfo.path;
    }

    const branch = opts.worktree
      ? worktreeBranch(opts.epicId as `E-${string}`, config)
      : await getCurrentBranch(controlCwd);

    // lane claim check
    if (await isLaneClaimed(laneClaimKey, opRoot)) {
      const msg = `epic ${opts.epicId} already has an active lane claim`;
      if (worktreeInfo) {
        process.stderr.write(`warning: could not claim lane — ${msg}\n`);
      }
      return err('LANE_CLAIMED', msg, 'wait for other run to finish or release the lane');
    }

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
      },
      opRoot,
    );

    await claimLane(laneClaimKey, run.id, run.epic_id, executionCwd, branch, opRoot);

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

    return executeRunLoop(run, opRoot, controlCwd, executionCwd, outcome.config, opts);
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
  opts: RunCommandOptions,
): Promise<CommandResult> {
  let run = initialRun;
  const runner = getRunner(run.agent, opts.experimental);

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
      );

      if (gate) {
        const haltReason = `gate:${gate.id}:${gate.gate ?? 'unknown'}`;
        run = await updateRun(
          run.id,
          { status: 'paused', halt_reason: haltReason, ended_at: isoNow() },
          opRoot,
        );
        await releaseLane(`epic-${run.epic_id}`, opRoot);
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
        await releaseLane(`epic-${run.epic_id}`, opRoot);
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
        await releaseLane(`epic-${run.epic_id}`, opRoot);
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
        await releaseLane(`epic-${run.epic_id}`, opRoot);
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
            `  2. ${pc.dim(`rk review verdict ${reviewId} accepted`)}`,
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
        await releaseLane(`epic-${run.epic_id}`, opRoot);
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
        await releaseLane(`epic-${run.epic_id}`, opRoot);
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
    await releaseLane(`epic-${run.epic_id}`, opRoot);
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
    await releaseLane(`epic-${run.epic_id}`, opRoot).catch(() => null);
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
        `rk review verdict ${sprint.review_id} accepted`,
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
      await releaseLane(`epic-${run.epic_id}`, opRoot);
      return {
        exitCode: EXIT_OK,
        stdout: `\nRun ${run.id} completed (limit reached after ${run.sprint_count} sprint(s))\n`,
        stderr: '',
      };
    }

    // load config for continuation
    const continuationOutcome = await loadProject({ cwd: executionCwd });
    if (!continuationOutcome.ok) return configError();

    return executeRunLoop(run, opRoot, controlCwd, executionCwd, continuationOutcome.config, opts);
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
  throw e;
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
