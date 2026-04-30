import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RepoKernelError, type Run, RunSchema } from '@repokernel/core';
import { atomicCreateText, atomicWriteText } from './atomicWrite.js';
import { runStateRoot } from './controlPaths.js';
import { withLock } from './locks.js';

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

export async function listRuns(opRoot: string): Promise<Run[]> {
  const dir = runStateRoot(opRoot);
  const files = await readdir(dir).catch(() => [] as string[]);
  const runs: Run[] = [];
  for (const f of files) {
    if (!/^RUN-\d+\.json$/.test(f)) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      runs.push(RunSchema.parse(JSON.parse(raw)));
    } catch {
      // skip corrupt run files
    }
  }
  return runs.sort((a, b) => a.id.localeCompare(b.id));
}
