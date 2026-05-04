import { resolve } from 'node:path';
import {
  loadProject,
  RepoKernelError,
  type TrackerMetadata,
  TrackerProviderSchema,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import {
  commentOnTicket,
  linkPrToTicket,
  makeInitialMetadata,
  readTrackerMetadata,
  stampSync,
  type TrackerWriteOutcome,
  transitionTicket,
  writeTrackerMetadata,
} from '../integrations/tracker/index.js';
import type { CommandResult } from './validate.js';

interface TrackerCommonOptions {
  readonly cwd: string;
  readonly sprintId: string;
  readonly json: boolean;
}

async function resolveSprintFile(opts: TrackerCommonOptions): Promise<string | CommandResult> {
  const cwd = resolve(opts.cwd);
  let outcome: Awaited<ReturnType<typeof loadProject>>;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!outcome.ok) {
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: 'project state is invalid\n' };
  }
  const sprint = outcome.parsed.sprints.find((s) => s.id === opts.sprintId);
  if (!sprint) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `sprint ${opts.sprintId} not found\n`,
    };
  }
  return resolve(cwd, sprint.file);
}

function jsonOutput(opts: { json: boolean }, payload: unknown, exitCode = EXIT_OK): CommandResult {
  return {
    exitCode,
    stdout: opts.json ? `${JSON.stringify(payload, null, 2)}\n` : '',
    stderr: '',
  };
}

export interface TrackerStatusOptions extends TrackerCommonOptions {}

export async function runTrackerStatusCommand(opts: TrackerStatusOptions): Promise<CommandResult> {
  const file = await resolveSprintFile(opts);
  if (typeof file !== 'string') return file;
  const meta = await readTrackerMetadata(file);
  if (!meta) {
    if (opts.json) return jsonOutput(opts, { sprint_id: opts.sprintId, tracker: null });
    return {
      exitCode: EXIT_OK,
      stdout: `${opts.sprintId}: no tracker metadata\n`,
      stderr: '',
    };
  }
  if (opts.json) {
    return jsonOutput(opts, { sprint_id: opts.sprintId, tracker: meta });
  }
  return {
    exitCode: EXIT_OK,
    stdout:
      `${opts.sprintId}\n` +
      `  provider: ${meta.provider}\n` +
      `  issue:    ${meta.issue_id}\n` +
      `  url:      ${meta.issue_url ?? '—'}\n` +
      `  synced:   ${meta.synced_fields.join(', ') || '—'} (last: ${meta.sync_at})\n`,
    stderr: '',
  };
}

export interface TrackerLinkOptions extends TrackerCommonOptions {
  readonly provider: string;
  readonly issueId: string;
  readonly issueUrl?: string;
}

export async function runTrackerLinkCommand(opts: TrackerLinkOptions): Promise<CommandResult> {
  const provider = TrackerProviderSchema.safeParse(opts.provider);
  if (!provider.success) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `invalid provider \`${opts.provider}\`\n`,
    };
  }
  const file = await resolveSprintFile(opts);
  if (typeof file !== 'string') return file;
  const meta = makeInitialMetadata({
    provider: provider.data,
    issueId: opts.issueId,
    ...(opts.issueUrl !== undefined ? { issueUrl: opts.issueUrl } : {}),
  });
  await writeTrackerMetadata(file, meta);
  if (opts.json) return jsonOutput(opts, { sprint_id: opts.sprintId, tracker: meta });
  return {
    exitCode: EXIT_OK,
    stdout: `${opts.sprintId}: linked to ${provider.data}:${opts.issueId}\n`,
    stderr: '',
  };
}

export interface TrackerCommentOptions extends TrackerCommonOptions {
  readonly body: string;
}

export async function runTrackerCommentCommand(
  opts: TrackerCommentOptions,
): Promise<CommandResult> {
  const meta = await loadMetadataOrError(opts);
  if ('metadata' in meta) {
    return await postWrite(opts, meta.metadata, meta.file, 'comment', () =>
      commentOnTicket(meta.metadata, opts.body),
    );
  }
  return meta;
}

export interface TrackerLinkPrOptions extends TrackerCommonOptions {
  readonly prUrl: string;
}

export async function runTrackerLinkPrCommand(opts: TrackerLinkPrOptions): Promise<CommandResult> {
  const meta = await loadMetadataOrError(opts);
  if ('metadata' in meta) {
    return await postWrite(opts, meta.metadata, meta.file, 'link_pr', () =>
      linkPrToTicket(meta.metadata, opts.prUrl),
    );
  }
  return meta;
}

export interface TrackerTransitionOptions extends TrackerCommonOptions {
  readonly state: string;
}

export async function runTrackerTransitionCommand(
  opts: TrackerTransitionOptions,
): Promise<CommandResult> {
  const meta = await loadMetadataOrError(opts);
  if ('metadata' in meta) {
    return await postWrite(opts, meta.metadata, meta.file, 'status', () =>
      transitionTicket(meta.metadata, opts.state),
    );
  }
  return meta;
}

async function loadMetadataOrError(
  opts: TrackerCommonOptions,
): Promise<{ metadata: TrackerMetadata; file: string } | CommandResult> {
  const file = await resolveSprintFile(opts);
  if (typeof file !== 'string') return file;
  const meta = await readTrackerMetadata(file);
  if (!meta) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `${opts.sprintId}: no tracker metadata — run \`rk tracker link\` first\n`,
    };
  }
  return { metadata: meta, file };
}

async function postWrite(
  opts: TrackerCommonOptions,
  metadata: TrackerMetadata,
  file: string,
  field: TrackerMetadata['synced_fields'][number],
  call: () => Promise<TrackerWriteOutcome>,
): Promise<CommandResult> {
  const outcome = await call();
  if (!outcome.ok) {
    if (opts.json) return jsonOutput(opts, { ok: false, reason: outcome.reason }, EXIT_FINDINGS);
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `tracker write failed: ${outcome.reason}\n`,
    };
  }
  const updated = stampSync(metadata, field);
  await writeTrackerMetadata(file, updated);
  if (opts.json) return jsonOutput(opts, { ok: true, tracker: updated });
  return {
    exitCode: EXIT_OK,
    stdout: `tracker updated (${field})\n`,
    stderr: '',
  };
}
