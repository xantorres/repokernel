import { resolve } from 'node:path';
import { loadProject, type PrMetadata, RepoKernelError, type Sprint } from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { isHttpUrl } from '../integrations/_shared/url.js';
import {
  extractGithubNumber,
  ghPrComment,
  ghPrEditBody,
  ghPrView,
  inferProvider,
  readPrMetadata,
  renderPrBody,
  writePrMetadata,
} from '../integrations/github/index.js';
import { operationalRoot } from '../lifecycle/controlPaths.js';
import type { CommandResult } from './validate.js';

interface PrCommonOptions {
  readonly cwd: string;
  readonly sprintId: string;
  readonly json: boolean;
}

async function loadSprint(
  opts: PrCommonOptions,
): Promise<{ sprint: Sprint; file: string; opRoot: string } | CommandResult> {
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
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: `sprint ${opts.sprintId} not found\n` };
  }
  const opRoot = await operationalRoot(cwd);
  return { sprint, file: resolve(cwd, sprint.file), opRoot };
}

function jsonOk(opts: { json: boolean }, data: unknown): CommandResult {
  return {
    exitCode: EXIT_OK,
    stdout: opts.json ? `${JSON.stringify(data, null, 2)}\n` : '',
    stderr: '',
  };
}

export interface PrBodyOptions extends PrCommonOptions {
  readonly write: boolean;
  readonly agentSummary?: string;
}

export async function runPrBodyCommand(opts: PrBodyOptions): Promise<CommandResult> {
  const loaded = await loadSprint(opts);
  if (!('sprint' in loaded)) return loaded;
  const body = renderPrBody({
    sprint: loaded.sprint,
    ...(opts.agentSummary !== undefined ? { agentSummary: opts.agentSummary } : {}),
  });
  if (opts.write) {
    const meta = await readPrMetadata(loaded.file);
    if (!meta) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: `${opts.sprintId}: no PR linked — run \`rk pr link\` first\n`,
      };
    }
    if (meta.provider !== 'github') {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: `pr body update only supported for GitHub provider\n`,
      };
    }
    const result = await ghPrEditBody(meta.url, body);
    if (!result.ok) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: `pr body update failed: ${result.reason}\n`,
      };
    }
    return jsonOk(opts, { ok: true, body });
  }
  if (opts.json) return jsonOk(opts, { body });
  return { exitCode: EXIT_OK, stdout: body, stderr: '' };
}

export interface PrLinkOptions extends PrCommonOptions {
  readonly prUrl: string;
}

export async function runPrLinkCommand(opts: PrLinkOptions): Promise<CommandResult> {
  if (!isHttpUrl(opts.prUrl)) {
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: 'invalid PR URL\n' };
  }
  const loaded = await loadSprint(opts);
  if (!('sprint' in loaded)) return loaded;
  const inference = inferProvider(opts.prUrl);
  if (inference.kind === 'unknown') {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `unsupported PR host '${inference.hostname}' (recognised: github, gitlab, bitbucket)\n`,
    };
  }
  const number = extractGithubNumber(opts.prUrl);
  const meta: PrMetadata = {
    provider: inference.provider,
    url: opts.prUrl,
    last_sync_at: new Date().toISOString(),
    ...(number !== undefined ? { number } : {}),
  };
  await writePrMetadata(loaded.file, meta, loaded.opRoot);
  if (opts.json) return jsonOk(opts, { sprint_id: opts.sprintId, pr: meta });
  return {
    exitCode: EXIT_OK,
    stdout: `${opts.sprintId}: linked PR ${opts.prUrl}\n`,
    stderr: '',
  };
}

export type PrStatusOptions = PrCommonOptions;

export async function runPrStatusCommand(opts: PrStatusOptions): Promise<CommandResult> {
  const loaded = await loadSprint(opts);
  if (!('sprint' in loaded)) return loaded;
  const meta = await readPrMetadata(loaded.file);
  if (!meta) {
    if (opts.json) return jsonOk(opts, { sprint_id: opts.sprintId, pr: null });
    return { exitCode: EXIT_OK, stdout: `${opts.sprintId}: no PR linked\n`, stderr: '' };
  }
  if (opts.json) return jsonOk(opts, { sprint_id: opts.sprintId, pr: meta });
  return {
    exitCode: EXIT_OK,
    stdout:
      `${opts.sprintId}\n` +
      `  url:    ${meta.url}\n` +
      `  status: ${meta.status ?? '—'}\n` +
      `  number: ${meta.number ?? '—'}\n` +
      `  synced: ${meta.last_sync_at ?? '—'}\n`,
    stderr: '',
  };
}

export type PrSyncOptions = PrCommonOptions;

export async function runPrSyncCommand(opts: PrSyncOptions): Promise<CommandResult> {
  const loaded = await loadSprint(opts);
  if (!('sprint' in loaded)) return loaded;
  const meta = await readPrMetadata(loaded.file);
  if (!meta) {
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: 'no PR linked\n' };
  }
  if (meta.provider !== 'github') {
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: 'sync only supported for GitHub\n' };
  }
  const result = await ghPrView(meta.url);
  if (!result.ok) {
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: `pr sync failed: ${result.reason}\n` };
  }
  const updated: PrMetadata = {
    ...meta,
    status: result.value.status,
    last_sync_at: new Date().toISOString(),
  };
  await writePrMetadata(loaded.file, updated, loaded.opRoot);
  if (opts.json) return jsonOk(opts, { ok: true, pr: updated });
  return { exitCode: EXIT_OK, stdout: `pr synced: status=${result.value.status}\n`, stderr: '' };
}

export interface PrCommentOptions extends PrCommonOptions {
  readonly message: string;
}

export async function runPrCommentCommand(opts: PrCommentOptions): Promise<CommandResult> {
  const loaded = await loadSprint(opts);
  if (!('sprint' in loaded)) return loaded;
  const meta = await readPrMetadata(loaded.file);
  if (!meta) {
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: 'no PR linked\n' };
  }
  // The gh client only knows how to talk to GitHub. Reject other providers
  // here so the user gets a deterministic "unsupported provider" message
  // instead of a runtime `gh` failure that depends on network state.
  if (meta.provider !== 'github') {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `pr comment only supported for GitHub provider (linked: ${meta.provider})\n`,
    };
  }
  const result = await ghPrComment(meta.url, opts.message);
  if (!result.ok) {
    return { exitCode: EXIT_FINDINGS, stdout: '', stderr: `pr comment failed: ${result.reason}\n` };
  }
  if (opts.json) return jsonOk(opts, { ok: true });
  return { exitCode: EXIT_OK, stdout: `pr comment posted\n`, stderr: '' };
}
