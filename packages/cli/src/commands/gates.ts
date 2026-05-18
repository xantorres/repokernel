import { resolve } from 'node:path';
import { loadProject, RepoKernelError } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import {
  appendReviewEvidence,
  buildCommandEvidence,
  type EvidenceInput,
} from '../lifecycle/reviewEvidence.js';
import { runPreCloseSprintGates, type SprintGateStep } from '../lifecycle/sprintGates.js';
import { withLifecycleTransaction } from '../lifecycle/transaction.js';
import { runRegistryCommand } from './registry.js';
import { type CommandResult, runValidateCommand } from './validate.js';

export interface GatesCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
}

type GateStep = SprintGateStep;

export async function runGatesCommand(
  sprintId: string,
  opts: GatesCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();
    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) {
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `sprint not found: ${sprintId}\n` };
    }

    const steps: GateStep[] = [];
    const evidence: EvidenceInput[] = [];
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
      configuredChecks: 'run',
      recordEvidence: false,
    });
    steps.push(...preClose.steps);
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
      return finish(sprintId, sprint, steps, opts.json, EXIT_BLOCKED);
    }

    const validate = await runValidateCommand({ cwd, json: true, failOn: 'P1' });
    recordStep(
      'validate',
      'rk validate --fail-on P0,P1 --json',
      validate.exitCode,
      validate.exitCode === 0 ? 'validation passed' : 'validation failed',
    );
    if (validate.exitCode !== 0) {
      await appendEvidence(cwd, evidenceTarget, evidence);
      return finish(sprintId, sprint, steps, opts.json, validate.exitCode);
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
      return finish(sprintId, sprint, steps, opts.json, registry.exitCode);
    }

    await appendEvidence(cwd, evidenceTarget, evidence);
    return finish(sprintId, sprint, steps, opts.json, EXIT_OK);
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
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
  await withLifecycleTransaction(
    { cwd, command: 'gates', args: { sprintId: targetId } },
    async () => {
      for (const input of evidence) {
        await appendReviewEvidence(cwd, targetId, buildCommandEvidence(input));
      }
    },
  );
}

function finish(
  sprintId: string,
  sprint: { allowed_paths: readonly string[]; denied_paths: readonly string[] },
  steps: readonly GateStep[],
  json: boolean,
  exitCode: number,
): CommandResult {
  if (json) return { exitCode, stdout: emitJson({ sprintId, steps }), stderr: '' };
  const lines = [
    `Gates ${sprintId}`,
    '',
    `allowed_paths: ${formatPaths(sprint.allowed_paths)}`,
    `denied_paths: ${formatPaths(sprint.denied_paths)}`,
    '',
    ...steps.map((s) => `${s.status.padEnd(7)} ${s.label} — ${s.summary}`),
  ];
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
