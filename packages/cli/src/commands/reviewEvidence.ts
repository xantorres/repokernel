import { CommandEvidenceSchema, RepoKernelError } from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import {
  appendReviewEvidence,
  buildCommandEvidence,
  type EvidenceInput,
  executeCommandEvidence,
  resolveReviewEvidenceTarget,
} from '../lifecycle/reviewEvidence.js';
import type { CommandResult } from './validate.js';

export interface ReviewEvidenceCommandOptions {
  readonly cwd: string;
  readonly label: string;
  readonly command: string;
  readonly exitCode?: number;
  readonly summary?: string;
  readonly timeoutSeconds?: number;
  readonly json: boolean;
}

export async function runReviewEvidenceCommand(
  targetId: string,
  opts: ReviewEvidenceCommandOptions,
): Promise<CommandResult> {
  if (opts.exitCode !== undefined && !Number.isInteger(opts.exitCode)) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: '--exit-code must be an integer\n',
    };
  }
  if (opts.label.trim().length === 0) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: '--label must not be blank\n' };
  }
  if (opts.command.trim().length === 0) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: '--command must not be blank\n' };
  }

  try {
    await resolveReviewEvidenceTarget(opts.cwd, targetId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { exitCode: EXIT_USAGE, stdout: '', stderr: `${message}\n` };
  }

  const evidence =
    opts.exitCode === undefined
      ? await executeCommandEvidence({
          cwd: opts.cwd,
          label: opts.label,
          command: opts.command,
          timeoutSeconds: opts.timeoutSeconds ?? 300,
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
        })
      : buildCommandEvidence({
          label: opts.label,
          command: opts.command,
          exitCode: opts.exitCode,
          source: 'imported',
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
        } satisfies EvidenceInput);
  const parsed = CommandEvidenceSchema.safeParse(evidence);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'evidence';
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: `invalid command evidence ${field}: ${issue?.message ?? 'invalid value'}\n`,
    };
  }

  try {
    const appended = await appendReviewEvidence(opts.cwd, targetId, parsed.data);
    if (opts.json) {
      return { exitCode: EXIT_OK, stdout: emitJson(appended), stderr: '' };
    }
    return {
      exitCode: EXIT_OK,
      stdout: `Recorded evidence ${opts.label} on ${appended.reviewId}\n  ${appended.file}\n`,
      stderr: '',
    };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}
