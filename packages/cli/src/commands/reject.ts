import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, type RejectionScope, RepoKernelError } from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { withJournal } from '../lifecycle/journal.js';
import { appendRejection } from '../lifecycle/rejections.js';
import { getTrackerAdapter, parseTrackerRef } from '../trackers/index.js';
import type { CommandResult } from './validate.js';

const execFileAsync = promisify(execFile);

export interface RejectCommandOptions {
  readonly cwd: string;
  readonly pattern: string;
  readonly reason: string;
  readonly scope: RejectionScope;
  readonly ref?: string;
  readonly close?: boolean;
  readonly json?: boolean;
}

interface RejectJsonEnvelope {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly action: 'created' | 'duplicate';
  readonly id: string;
  readonly pattern: string;
  readonly scope: RejectionScope;
  readonly source_issue?: string;
  readonly tracker?: {
    readonly attempted: boolean;
    readonly ok: boolean;
    readonly reason?: string;
    readonly detail?: string;
  };
}

export async function runRejectCommand(opts: RejectCommandOptions): Promise<CommandResult> {
  if (opts.close === true && opts.ref === undefined) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: 'error: --close requires --ref\n' };
  }

  let configResult: Awaited<ReturnType<typeof loadConfig>>;
  try {
    configResult = await loadConfig({ cwd: opts.cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return repoKernelErrorToResult(cause);
    }
    throw cause;
  }
  if (!configResult.ok) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `project config is invalid; run \`rk validate\`\n`,
    };
  }
  const { config } = configResult;

  if (opts.ref !== undefined) {
    try {
      parseTrackerRef(opts.ref, '--ref');
    } catch (cause) {
      if (cause instanceof RepoKernelError) {
        return repoKernelErrorToResult(cause);
      }
      throw cause;
    }
  }

  const createdBy = await resolveCreatedBy(opts.cwd);

  const opRoot = await operationalRootBestEffort(opts.cwd);
  let outcome: Awaited<ReturnType<typeof appendRejection>>;
  try {
    outcome = await withJournal(
      opRoot,
      'reject',
      { pattern: opts.pattern, scope: opts.scope },
      () =>
        appendRejection(opts.cwd, config, {
          pattern: opts.pattern,
          reason: opts.reason,
          scope: opts.scope,
          ...(opts.ref !== undefined ? { source_issue: opts.ref } : {}),
          created_by: createdBy,
        }),
    );
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return repoKernelErrorToResult(cause);
    }
    throw cause;
  }

  const action: RejectJsonEnvelope['action'] = outcome.duplicate ? 'duplicate' : 'created';
  const id = outcome.duplicate ? outcome.existing.id : outcome.added.id;

  let trackerInfo: RejectJsonEnvelope['tracker'];
  if (opts.ref !== undefined && opts.close === true) {
    const parsed = parseTrackerRef(opts.ref, '--ref');
    const adapter = getTrackerAdapter(parsed.source);
    if (typeof adapter.transition !== 'function') {
      trackerInfo = { attempted: true, ok: false, reason: 'not_implemented' };
    } else if (typeof adapter.comment !== 'function') {
      trackerInfo = { attempted: true, ok: false, reason: 'comment_not_implemented' };
    } else {
      // Transition before comment: the close is the operative action, the
      // comment is only context. If the close fails we skip the comment, so a
      // failed `--close` never leaves an "out of scope" note on an issue that
      // is still open.
      const writeOutcome = await adapter.transition(parsed.ref, 'close');
      if (!writeOutcome.ok) {
        trackerInfo = { attempted: true, ok: false, reason: writeOutcome.reason };
      } else {
        const commentOutcome = await adapter.comment(
          parsed.ref,
          trackerCloseComment(opts.reason, id, opts.scope),
        );
        trackerInfo = commentOutcome.ok
          ? {
              attempted: true,
              ok: true,
              ...(writeOutcome.detail ? { detail: writeOutcome.detail } : {}),
            }
          : { attempted: true, ok: false, reason: `comment_${commentOutcome.reason}` };
      }
    }
  } else {
    trackerInfo = { attempted: false, ok: false };
  }

  const trackerFailed = trackerInfo.attempted && !trackerInfo.ok;
  const exitCode = trackerFailed ? EXIT_RUNTIME : EXIT_OK;

  if (opts.json === true) {
    const envelope: RejectJsonEnvelope = {
      schemaVersion: 1,
      ok: !trackerFailed,
      action,
      id,
      pattern: opts.pattern,
      scope: opts.scope,
      ...(opts.ref !== undefined ? { source_issue: opts.ref } : {}),
      ...(trackerInfo ? { tracker: trackerInfo } : {}),
    };
    return { exitCode, stdout: `${emitJson(envelope)}\n`, stderr: '' };
  }

  const lines: string[] = [];
  if (action === 'created') {
    lines.push(`Recorded rejection ${id} for pattern \`${opts.pattern}\` (scope: ${opts.scope}).`);
  } else {
    lines.push(
      `Rejection already exists for pattern \`${opts.pattern}\` (scope: ${opts.scope}) — id ${id}.`,
    );
  }
  if (trackerInfo?.attempted) {
    if (trackerInfo.ok) {
      lines.push(`Closed tracker issue ${opts.ref} (${trackerInfo.detail ?? 'closed'}).`);
    } else {
      lines.push(`Failed to close tracker issue ${opts.ref}: ${trackerInfo.reason ?? 'unknown'}.`);
    }
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

async function resolveCreatedBy(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'config', '--get', 'user.email']);
    const email = stdout.trim();
    if (email.length > 0) return email;
  } catch {
    // fall through — git may be missing or unconfigured.
  }
  return process.env.USER ?? 'unknown';
}

function repoKernelErrorToResult(cause: RepoKernelError): CommandResult {
  return {
    exitCode: cause.kind === 'CONFIG_INVALID' ? EXIT_USAGE : EXIT_RUNTIME,
    stdout: '',
    stderr: `error: ${cause.message}\n`,
  };
}

function trackerCloseComment(reason: string, rejectionId: string, scope: RejectionScope): string {
  return [
    'RepoKernel recorded this issue as out of scope.',
    '',
    `Reason: ${reason}`,
    '',
    `Rejection: ${rejectionId}`,
    `Scope: ${scope}`,
  ].join('\n');
}
