import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RepoKernelError, type Run, RunSchema } from '@repokernel/core';
import { atomicCreateText, atomicWriteText } from './atomicWrite.js';
import { runStateRoot } from './controlPaths.js';
import { withLock } from './locks.js';

export {
  detectStalledWorkers,
  effectiveConcurrencyCap,
  type WorkerActivity,
} from './dispatch.js';
export {
  claimSprint,
  listSprintClaims,
  readSprintClaim,
  releaseSprint,
  type SprintClaimOutcome,
} from './sprintClaim.js';
export type { TeamStatusInput } from './teamStatus.js';
// Re-exports kept for back-compat with existing imports of these symbols
// from `runState`. Production code should depend directly on the modules
// below; the indirection through runState is preserved only so the
// public-import surface does not change in this PR.
export { getTeamStatus } from './teamStatus.js';

function runFile(opRoot: string, id: string): string {
  return join(runStateRoot(opRoot), `${id}.json`);
}

export async function nextRunId(opRoot: string): Promise<string> {
  return withLock('run-id', opRoot, async () => {
    const dir = runStateRoot(opRoot);
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir).catch(() => [] as string[]);
    const nums = files.flatMap((f) => {
      const m = /^RUN-(\d+)\.json$/.exec(f);
      return m?.[1] !== undefined ? [parseInt(m[1], 10)] : [];
    });
    const n = nums.length ? Math.max(...nums) + 1 : 1;
    return `RUN-${String(n).padStart(3, '0')}`;
  });
}

export async function createRun(run: Run, opRoot: string): Promise<Run> {
  const dir = runStateRoot(opRoot);
  await mkdir(dir, { recursive: true });
  const validated = RunSchema.parse(run);
  await atomicWriteText(runFile(opRoot, run.id), JSON.stringify(validated, null, 2));
  return validated;
}

// Atomically allocate a new Run: scan + write under one lock. The exclusive
// open below prevents two concurrent allocations from clobbering the same id.
export async function allocateRun(input: Omit<Run, 'id'>, opRoot: string): Promise<Run> {
  const dir = runStateRoot(opRoot);
  await mkdir(dir, { recursive: true });
  return withLock('run-id', opRoot, async () => {
    const files = await readdir(dir).catch(() => [] as string[]);
    const nums = files.flatMap((f) => {
      const m = /^RUN-(\d+)\.json$/.exec(f);
      return m?.[1] !== undefined ? [parseInt(m[1], 10)] : [];
    });
    const n = nums.length ? Math.max(...nums) + 1 : 1;
    const id = `RUN-${String(n).padStart(3, '0')}` as `RUN-${string}`;
    const run = RunSchema.parse({ ...input, id });

    // First-write semantics for newly allocated id: refuse to overwrite an
    // existing file (defensive — id collision means a stale file or scan
    // race). atomicCreateText writes to a sibling temp first and links to
    // the target only after the write completes; EEXIST throws if the
    // target already exists, which preserves the previous wx-open behavior.
    await atomicCreateText(runFile(opRoot, id), JSON.stringify(run, null, 2));
    return run;
  });
}

export async function loadRun(id: string, opRoot: string): Promise<Run> {
  try {
    const raw = await readFile(runFile(opRoot, id), 'utf8');
    return RunSchema.parse(JSON.parse(raw));
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `run ${id} not found or invalid`, cause);
  }
}

export async function updateRun(
  id: string,
  patch: Partial<Omit<Run, 'id'>>,
  opRoot: string,
): Promise<Run> {
  return withLock(`run-${id}`, opRoot, async () => {
    const current = await loadRun(id, opRoot);
    const updated = RunSchema.parse({ ...current, ...patch });
    await atomicWriteText(runFile(opRoot, id), JSON.stringify(updated, null, 2));
    return updated;
  });
}

export interface CorruptRunFile {
  readonly file: string;
  readonly reason: string;
}

export interface ListRunsResult {
  readonly runs: Run[];
  readonly corrupt: CorruptRunFile[];
}

/**
 * Backwards-compatible run listing — drops corrupt files. Most call sites
 * (table listings, filters) only want healthy runs and would rather skip a
 * broken file than crash the whole command. Diagnostic callers should use
 * `listRunsWithCorruption` to surface the corrupt set explicitly.
 */
export async function listRuns(opRoot: string): Promise<Run[]> {
  const { runs } = await listRunsWithCorruption(opRoot);
  return runs;
}

/**
 * Diagnostic variant of listRuns. Returns both the healthy runs AND the
 * file paths that failed to parse, so `rk doctor` / `rk recover` can
 * report corruption to the operator instead of silently hiding it
 * (the legacy `listRuns` swallow). Used by the recovery flow to decide
 * what to quarantine and rebuild.
 */
export async function listRunsWithCorruption(opRoot: string): Promise<ListRunsResult> {
  const dir = runStateRoot(opRoot);
  const files = await readdir(dir).catch(() => [] as string[]);
  const runs: Run[] = [];
  const corrupt: CorruptRunFile[] = [];
  for (const f of files) {
    if (!/^RUN-\d+\.json$/.test(f)) continue;
    const path = join(dir, f);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (cause) {
      corrupt.push({ file: path, reason: `read failed: ${(cause as Error).message}` });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      corrupt.push({ file: path, reason: `invalid JSON: ${(cause as Error).message}` });
      continue;
    }
    const result = RunSchema.safeParse(parsed);
    if (!result.success) {
      corrupt.push({
        file: path,
        reason: `schema validation failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
      });
      continue;
    }
    runs.push(result.data);
  }
  runs.sort((a, b) => a.id.localeCompare(b.id));
  return { runs, corrupt };
}
