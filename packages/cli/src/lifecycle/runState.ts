import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Registry,
  RepoKernelError,
  type Run,
  RunSchema,
  type TeamStatus,
  type TeamStatusRun,
  type TeamStatusSprint,
} from '@repokernel/core';
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

// ---------------------------------------------------------------------------
// Team status snapshot
// ---------------------------------------------------------------------------
// Composes a single TeamStatus snapshot from the run state files plus the
// already-generated registry. The intent is to keep `runState` the source of
// truth for runtime data while the registry is the source of truth for
// declared project state — a TeamStatus reconciles the two without
// re-reading entity files.

export interface TeamStatusInput {
  readonly opRoot: string;
  readonly registry: Registry;
  readonly now?: () => Date;
  /**
   * Optional filter — when set, only one sprint is returned (still all
   * runs that touched it). The shape stays the same so consumers don't
   * need a separate code path for "single sprint" mode.
   */
  readonly sprintId?: string;
}

const ESTIMATED_RUN_DURATION_MS = 60 * 60 * 1000; // 1h placeholder ETA window

function activeSprintIds(run: Run): readonly string[] {
  if (run.active_sprints.length > 0) return run.active_sprints;
  return run.current_sprint ? [run.current_sprint] : [];
}

function progressString(run: Run): string {
  const total = run.limit ?? Math.max(run.sprint_count + run.completed_sprints.length, 1);
  if (total === 0) return '0%';
  const pct = Math.min(100, Math.round((run.completed_sprints.length / total) * 100));
  return `${pct}%`;
}

function computeRunEta(run: Run, now: Date): string | null {
  if (run.status === 'completed' || run.status === 'aborted' || run.status === 'failed') {
    return run.ended_at;
  }
  const startedMs = Date.parse(run.started_at);
  if (Number.isNaN(startedMs)) return null;
  const elapsed = now.getTime() - startedMs;
  const completed = run.completed_sprints.length;
  const remaining =
    run.limit !== null && run.limit > completed
      ? run.limit - completed
      : Math.max(activeSprintIds(run).length, 1);
  const perSprint = completed > 0 ? elapsed / completed : ESTIMATED_RUN_DURATION_MS;
  const eta = now.getTime() + perSprint * remaining;
  return new Date(eta).toISOString();
}

function summarizeRunStates(run: Run, registry: Registry): TeamStatusRun['states'] {
  const states = { ready: 0, active: 0, review: 0, merging: 0 };
  const sprintIds = new Set([
    ...run.active_sprints,
    ...(run.current_sprint ? [run.current_sprint] : []),
  ]);
  for (const id of sprintIds) {
    const sprint = registry.sprints.find((s) => s.id === id);
    if (!sprint) continue;
    if (sprint.status === 'queued' || sprint.status === 'pending') states.ready++;
    if (sprint.status === 'active') states.active++;
    if (sprint.status === 'review') states.review++;
  }
  if (run.pending_wave?.status === 'merging') states.merging = 1;
  return states;
}

function computeRegistryHealth(registry: Registry): {
  ready_to_merge: boolean;
  health: 'OK' | 'BLOCKED' | 'DEGRADED';
} {
  if (registry.health.blocked) {
    return { ready_to_merge: false, health: 'BLOCKED' };
  }
  if (registry.health.findingCounts.P1 > 0) {
    return { ready_to_merge: false, health: 'DEGRADED' };
  }
  return { ready_to_merge: true, health: 'OK' };
}

function bottleneckLines(registry: Registry, runs: readonly Run[]): string[] {
  const lines: string[] = [];
  const inflightRunsByEpic = new Map<string, number>();
  for (const run of runs) {
    if (run.status !== 'running') continue;
    inflightRunsByEpic.set(run.epic_id, (inflightRunsByEpic.get(run.epic_id) ?? 0) + 1);
  }
  for (const sprint of registry.sprints) {
    if (sprint.status === 'review') {
      lines.push(`${sprint.id}: awaiting_review`);
    } else if (sprint.blocked_by.length > 0) {
      lines.push(`${sprint.id}: blocked_by ${sprint.blocked_by.join(',')}`);
    }
  }
  return lines;
}

export async function getTeamStatus(input: TeamStatusInput): Promise<TeamStatus> {
  const now = (input.now ?? (() => new Date()))();
  const { runs } = await listRunsWithCorruption(input.opRoot);

  const teamRuns: TeamStatusRun[] = runs.map((run) => ({
    run_id: run.id,
    epic_id: run.epic_id,
    status: run.status,
    active_sprints: activeSprintIds(run).length,
    states: summarizeRunStates(run, input.registry),
    started_at: run.started_at,
    ended_at: run.ended_at,
    eta: computeRunEta(run, now),
  }));

  const sprintToRunId = new Map<string, string>();
  for (const run of runs) {
    for (const id of activeSprintIds(run)) {
      // First-writer-wins: deterministic if multiple runs claim the same id
      // (which is itself a registry conflict surfaced elsewhere).
      if (!sprintToRunId.has(id)) sprintToRunId.set(id, run.id);
    }
  }
  const runById = new Map(runs.map((r) => [r.id, r] as const));

  let sprintList = input.registry.sprints;
  if (input.sprintId) {
    sprintList = sprintList.filter((s) => s.id === input.sprintId);
  }

  const teamSprints: TeamStatusSprint[] = sprintList.map((sprint) => {
    const runId = sprintToRunId.get(sprint.id) ?? null;
    const run = runId ? (runById.get(runId) ?? null) : null;
    return {
      id: sprint.id,
      title: sprint.title,
      status: sprint.status,
      agent: run?.agent ?? null,
      lane: sprint.lane,
      run_id: runId,
      progress: run ? progressString(run) : null,
      started_at: sprint.started_at,
      eta: run ? computeRunEta(run, now) : null,
    };
  });

  const registryHealth = computeRegistryHealth(input.registry);
  const filesChanged =
    input.registry.health.findingCounts.P0 +
    input.registry.health.findingCounts.P1 +
    input.registry.health.findingCounts.P2;

  return {
    timestamp: now.toISOString(),
    runs: teamRuns,
    sprints: teamSprints,
    registry: {
      files_changed: filesChanged,
      conflicts: input.registry.health.findingCounts.P0,
      ...registryHealth,
    },
    bottlenecks: bottleneckLines(input.registry, runs),
  };
}

// ---------------------------------------------------------------------------
// Atomic sprint claims
// ---------------------------------------------------------------------------
// `claimed_by_run_id` lives in sprint frontmatter and acts as an exclusive
// lock keyed on a run id. The dispatch layer must call `claimSprint` before
// spawning an agent and `releaseSprint` after the worker exits.
//
// The check-and-set is performed inside the lifecycle lock to prevent two
// concurrent runs from observing `claimed_by_run_id: null`, both writing
// their own id, and both proceeding. We import gray-matter lazily here to
// avoid a top-of-file cycle with the mutate helper that already does the
// frontmatter dance for other fields.

export type SprintClaimOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'already_claimed'; readonly heldBy: string }
  | { readonly ok: false; readonly reason: 'sprint_not_found' | 'unreadable' };

export async function claimSprint(args: {
  readonly file: string;
  readonly runId: string;
  readonly opRoot: string;
  readonly sprintId: string;
}): Promise<SprintClaimOutcome> {
  return withLock(`sprint-claim-${args.sprintId}`, args.opRoot, async () => {
    const { readFile } = await import('node:fs/promises');
    const matterModule = (await import('gray-matter')).default;
    let raw: string;
    try {
      raw = await readFile(args.file, 'utf8');
    } catch {
      return { ok: false, reason: 'sprint_not_found' as const };
    }
    const parsed = matterModule(raw);
    const data = parsed.data as Record<string, unknown>;
    const current = data.claimed_by_run_id;
    if (typeof current === 'string' && current.length > 0 && current !== args.runId) {
      return { ok: false, reason: 'already_claimed' as const, heldBy: current };
    }
    const next = { ...data, claimed_by_run_id: args.runId };
    await atomicWriteText(args.file, matterModule.stringify(parsed.content, next));
    return { ok: true as const };
  });
}

export async function releaseSprint(args: {
  readonly file: string;
  readonly opRoot: string;
  readonly sprintId: string;
}): Promise<void> {
  await withLock(`sprint-claim-${args.sprintId}`, args.opRoot, async () => {
    const { readFile } = await import('node:fs/promises');
    const matterModule = (await import('gray-matter')).default;
    let raw: string;
    try {
      raw = await readFile(args.file, 'utf8');
    } catch {
      return;
    }
    const parsed = matterModule(raw);
    const data = parsed.data as Record<string, unknown>;
    if (data.claimed_by_run_id === undefined) return;
    const { claimed_by_run_id: _drop, ...rest } = data;
    await atomicWriteText(args.file, matterModule.stringify(parsed.content, rest));
  });
}

// ---------------------------------------------------------------------------
// Per-state concurrency caps
// ---------------------------------------------------------------------------
// Deterministic cap resolution given a global cap, an optional per-state
// override, and a sprint state. Pure function — kept here so that both the
// parallelRunner and any external scheduler use the exact same arithmetic.

export function effectiveConcurrencyCap(args: {
  readonly globalCap: number;
  readonly byState: Readonly<Record<string, number | undefined>>;
  readonly state: string;
}): number {
  const stateCap = args.byState[args.state];
  if (typeof stateCap === 'number' && stateCap > 0) {
    return Math.max(1, Math.min(args.globalCap, stateCap));
  }
  return args.globalCap;
}

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------
// `WorkerActivity` snapshots the most recent timestamp of bytes-from-agent
// for a given worker. The parallelRunner pushes updates whenever stdout or
// stderr fire and consults this map on its 30s tick to identify stalled
// agents.

export interface WorkerActivity {
  readonly sprintId: string;
  readonly lastActivityAt: number; // epoch ms
  readonly pid?: number;
}

export function detectStalledWorkers(
  workers: readonly WorkerActivity[],
  now: number,
  thresholdMs: number,
): readonly WorkerActivity[] {
  if (thresholdMs <= 0) return [];
  return workers.filter((w) => now - w.lastActivityAt > thresholdMs);
}
