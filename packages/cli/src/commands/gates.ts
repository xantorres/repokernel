import { resolve } from 'node:path';
import {
  loadProject,
  meetsThreshold,
  RepoKernelError,
  runValidators,
  type TargetValidationMode,
  validateForTarget,
} from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitBriefJson, formatBriefText, type GatesBriefJson } from '../format/brief.js';
import { emitJson, jsonError, jsonOk } from '../format/json.js';
import type { SprintBlocker } from '../lifecycle/diffClassifier.js';
import {
  appendReviewEvidence,
  buildCommandEvidence,
  type EvidenceInput,
} from '../lifecycle/reviewEvidence.js';
import { runPreCloseSprintGates, type SprintGateStep } from '../lifecycle/sprintGates.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import { runRegistryCommand } from './registry.js';
import type { CommandResult } from './validate.js';

export interface GatesCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly brief?: boolean;
  readonly profile?: 'focused' | 'sprint' | 'epic' | 'release';
  readonly explain?: boolean;
  /**
   * `close` (default) reports only findings in the target sprint's frame of
   * reference (its own files, its review, its queue slot, its epic). A
   * queued downstream dependent waiting for this sprint to ship does not
   * gate the gate. `global` returns the unfiltered finding set — same as
   * `rk validate --fail-on P0,P1`. Use when investigating registry hygiene.
   */
  readonly targetScope?: TargetValidationMode;
}

type GateStep = SprintGateStep;

export async function runGatesCommand(
  sprintId: string,
  opts: GatesCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const mode: TargetValidationMode = opts.targetScope ?? 'close';
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();
    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) {
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `sprint not found: ${sprintId}\n` };
    }
    const profile = opts.profile ?? 'sprint';
    if (opts.explain === true) return explainGates(sprintId, profile, opts.json);

    const steps: GateStep[] = [];
    const evidence: EvidenceInput[] = [];
    const blockers: SprintBlocker[] = [];
    const warnings: SprintBlocker[] = [];
    const evidenceTarget = sprint.review_id ? sprintId : null;
    const reviewFile = sprint.review_id
      ? outcome.graph.reviews.get(sprint.review_id)?.file
      : undefined;

    const recordStep = (
      label: string,
      command: string | undefined,
      exitCode: number | null,
      summary: string,
      status?: 'passed' | 'failed' | 'skipped',
    ) => {
      const finalStatus =
        status ?? (exitCode === 0 ? 'passed' : exitCode === null ? 'skipped' : 'failed');
      steps.push({ label, status: finalStatus, exitCode, summary });
      evidence.push({
        label,
        ...(command !== undefined ? { command } : {}),
        exitCode,
        status: finalStatus,
        summary,
      });
    };

    const preClose = await runPreCloseSprintGates({
      cwd,
      config: outcome.config,
      sprint,
      ...(reviewFile !== undefined ? { reviewFile } : {}),
      configuredChecks: profile === 'focused' ? 'skip' : 'run',
      recordEvidence: false,
      profile,
    });
    steps.push(...preClose.steps);
    blockers.push(...preClose.blockers);
    warnings.push(...preClose.warnings);
    for (const step of preClose.steps) {
      const command = gateStepCommand(step, sprint.base_sha, outcome.config.automation.checksCmd);
      evidence.push({
        label: step.label,
        ...(command !== undefined ? { command } : {}),
        exitCode: step.exitCode,
        status: step.status,
        summary: step.summary,
      });
    }
    if (preClose.failed) {
      await appendEvidence(cwd, evidenceTarget, evidence);
      return finish(
        sprintId,
        sprint,
        steps,
        opts.json,
        opts.brief === true,
        EXIT_BLOCKED,
        blockers,
        warnings,
      );
    }

    // Target-scoped validate: run the validator pass against the loaded
    // project, then filter the findings to those that gate this sprint's
    // transition (mode='close') or keep all of them (mode='global'). In
    // close mode, a queued downstream dependent waiting on this sprint to
    // ship is NOT a blocker — that's the whole point of the gate.
    const allFindings = runValidators({
      parsed: outcome.parsed,
      graph: outcome.graph,
      config: outcome.config,
      parseFindings: outcome.parsed.findings,
    });
    const validationMode = profile === 'release' ? 'global' : mode;
    const scopedFindings = validateForTarget(allFindings, sprintId, outcome.graph, validationMode);
    const blocking = scopedFindings.filter((f) => meetsThreshold(f.severity, 'P1'));
    const validateExit = blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK;
    recordStep(
      'validate',
      validationMode === 'global'
        ? 'rk validate --fail-on P0,P1 --json'
        : `rk validate --fail-on P0,P1 --target-scope close ${sprintId}`,
      validateExit,
      validateExit === 0
        ? validationMode === 'global'
          ? 'validation passed (global)'
          : `validation passed (${blocking.length === 0 ? 'scoped to ' : ''}${sprintId})`
        : `validation failed: ${blocking.length} blocking finding(s) in scope=${validationMode}`,
    );
    if (validateExit !== 0) {
      await appendEvidence(cwd, evidenceTarget, evidence);
      return finish(
        sprintId,
        sprint,
        steps,
        opts.json,
        opts.brief === true,
        validateExit,
        blockers,
        warnings,
      );
    }

    const registry = await runRegistryCommand({
      cwd,
      write: false,
      check: true,
      explain: true,
      json: true,
    });
    recordStep(
      'registry-check',
      'rk registry --check --explain --json',
      registry.exitCode,
      registry.exitCode === 0 ? 'registry has no drift' : 'registry drift detected',
    );
    if (registry.exitCode !== 0) {
      await appendEvidence(cwd, evidenceTarget, evidence);
      return finish(
        sprintId,
        sprint,
        steps,
        opts.json,
        opts.brief === true,
        registry.exitCode,
        blockers,
        warnings,
      );
    }

    await appendEvidence(cwd, evidenceTarget, evidence);
    return finish(
      sprintId,
      sprint,
      steps,
      opts.json,
      opts.brief === true,
      EXIT_OK,
      blockers,
      warnings,
    );
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function explainGates(
  sprintId: string,
  profile: NonNullable<GatesCommandOptions['profile']>,
  json: boolean,
): CommandResult {
  const steps = [
    { label: 'configured-checks', status: profile === 'focused' ? 'skipped' : 'planned' },
    { label: 'diff-paths', status: 'planned' },
    { label: 'validate', status: 'planned' },
    { label: 'registry-check', status: 'planned' },
  ];
  if (json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson(jsonOk({ sprint_id: sprintId, profile, explain: true, steps })),
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: `Gates ${sprintId} (${profile})\n\n${steps.map((step) => `${step.status.padEnd(7)} ${step.label}`).join('\n')}\n`,
    stderr: '',
  };
}

function gateStepCommand(
  step: GateStep,
  baseSha: string | undefined,
  checksCmd: string | undefined,
): string | undefined {
  if (step.label === 'configured-checks') return checksCmd;
  if (step.label === 'diff-paths' && baseSha) return `git diff --name-only ${baseSha}`;
  return undefined;
}

async function appendEvidence(
  cwd: string,
  targetId: string | null,
  evidence: readonly EvidenceInput[],
): Promise<void> {
  if (!targetId || evidence.length === 0) return;
  await withLifecycleScope({ cwd, command: 'gates', args: { sprintId: targetId } }, async () => {
    for (const input of evidence) {
      await appendReviewEvidence(cwd, targetId, buildCommandEvidence(input));
    }
  });
}

function finish(
  sprintId: string,
  sprint: { allowed_paths: readonly string[]; denied_paths: readonly string[] },
  steps: readonly GateStep[],
  json: boolean,
  brief: boolean,
  exitCode: number,
  blockers: readonly SprintBlocker[] = [],
  warnings: readonly SprintBlocker[] = [],
): CommandResult {
  const failedSteps = steps.filter((step) => step.status === 'failed');
  const nextActions = [...new Set(blockers.flatMap((blocker) => blocker.next_actions))];
  const payload: GatesBriefJson = {
    schemaVersion: 1,
    brief: true,
    command: 'gates',
    ok: exitCode === 0,
    sprintId,
    steps: steps.map((step) => ({
      label: step.label,
      status: step.status,
      exitCode: step.exitCode,
    })),
    failed: failedSteps.length,
  };
  if (brief) {
    return {
      exitCode,
      stdout: json ? emitBriefJson(payload) : formatBriefText(payload),
      stderr: '',
    };
  }
  if (json) {
    return {
      exitCode,
      stdout: emitJson(
        exitCode === 0
          ? jsonOk({ sprint_id: sprintId, steps, blockers, warnings }, { warnings })
          : jsonError('GATES_FAILED', `gates failed for ${sprintId}`, {
              details: { sprint_id: sprintId, steps, blockers, warnings },
              warnings,
              nextActions,
            }),
      ),
      stderr: '',
    };
  }
  const lines = [
    `Gates ${sprintId}`,
    '',
    `allowed_paths: ${formatPaths(sprint.allowed_paths)}`,
    `denied_paths: ${formatPaths(sprint.denied_paths)}`,
    '',
    ...steps.map((s) => `${s.status.padEnd(7)} ${s.label} — ${s.summary}`),
  ];
  if (blockers.length > 0) {
    lines.push('', 'Blockers:');
    for (const blocker of blockers) {
      lines.push(`  ${blocker.category}: ${blocker.paths.join(', ')}`);
    }
  }
  if (warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of warnings) {
      lines.push(`  ${warning.category}: ${warning.paths.join(', ')}`);
    }
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function formatPaths(paths: readonly string[]): string {
  return paths.length === 0 ? '(none)' : paths.join(', ');
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}
