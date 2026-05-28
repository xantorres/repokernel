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
  readonly label?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly summary?: string;
  readonly timeoutSeconds?: number;
  readonly shell?: string;
  readonly supersedeHash?: string;
  readonly supersedeReason?: string;
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
  if (opts.supersedeHash !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(opts.supersedeHash)) {
      return { exitCode: EXIT_USAGE, stdout: '', stderr: '--supersede must be a 64-char hash\n' };
    }
    if (opts.supersedeReason?.trim()) {
      const evidence = buildCommandEvidence({
        label: `supersede:${opts.supersedeHash.slice(0, 12)}`,
        status: 'skipped',
        source: 'imported',
        summary: opts.supersedeReason.trim(),
        supersedes: opts.supersedeHash,
        supersedeReason: opts.supersedeReason.trim(),
      });
      try {
        const appended = await appendReviewEvidence(opts.cwd, targetId, evidence);
        if (opts.json) return { exitCode: EXIT_OK, stdout: emitJson(appended), stderr: '' };
        return {
          exitCode: EXIT_OK,
          stdout: `Superseded evidence ${opts.supersedeHash} on ${appended.reviewId}\n  ${appended.file}\n`,
          stderr: '',
        };
      } catch (cause) {
        if (cause instanceof RepoKernelError) {
          return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
        }
        throw cause;
      }
    }
    return { exitCode: EXIT_USAGE, stdout: '', stderr: '--reason is required with --supersede\n' };
  }

  if (opts.label === undefined || opts.label.trim().length === 0) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: '--label must not be blank\n' };
  }
  if (opts.command === undefined || opts.command.trim().length === 0) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: '--command must not be blank\n' };
  }

  try {
    await resolveReviewEvidenceTarget(opts.cwd, targetId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { exitCode: EXIT_USAGE, stdout: '', stderr: `${message}\n` };
  }

  // `--command` is user-typed CLI input — the operator is explicitly
  // entering the command at their own terminal, exactly like the `override`
  // path of `runConfiguredChecksFromConfig`. It is therefore NOT routed
  // through the `checks_cmd` trust gate (that gate exists for
  // repo-authored `automation.checksCmd`, which the user never typed).
  // `executeCommandEvidence` still spawns through the policy chokepoint, so
  // the env is scrubbed to the allowlist — no secret passthrough.
  const evidence =
    opts.exitCode === undefined
      ? await executeCommandEvidence({
          cwd: opts.cwd,
          label: opts.label,
          command: opts.command,
          timeoutSeconds: opts.timeoutSeconds ?? 300,
          ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
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
