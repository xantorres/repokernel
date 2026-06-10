import { resolve } from 'node:path';
import type { Epic, EpicStatus, ReviewVerdict, Sprint, SprintStatus } from '@repokernel/core';
import {
  loadProject,
  RepoKernelError,
  SPRINT_STATUSES,
  TERMINAL_EPIC_STATUSES,
} from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import {
  colorEpicStatus,
  colorReviewVerdict,
  colorSprintStatus,
  progressBar,
} from '../format/progress.js';
import { renderTable, truncate } from '../format/table.js';
import type { CommandResult } from './validate.js';

export interface LsEpicsOptions {
  readonly cwd: string;
  readonly status?: EpicStatus;
  /** Filter epics whose status is not in `TERMINAL_EPIC_STATUSES`. Mutually
   *  exclusive with `status`. Optional for ergonomic callers (tests, library
   *  consumers); the CLI registration always passes an explicit boolean. */
  readonly unshipped?: boolean;
  readonly json: boolean;
}

export interface LsSprintsOptions {
  readonly cwd: string;
  readonly epic?: string;
  readonly status?: SprintStatus;
  readonly lane?: string;
  readonly withDeps: boolean;
  readonly json: boolean;
  /**
   * If set, return only the N most recent sprints. Sorted by `closed_at` desc,
   * falling back to `started_at` desc, then to id. Applied after `--epic` /
   * `--status` / `--lane` filters.
   */
  readonly last?: number;
}

export interface LsReviewsOptions {
  readonly cwd: string;
  readonly sprint?: string;
  readonly verdict?: ReviewVerdict;
  readonly json: boolean;
}

export interface LsLanesOptions {
  readonly cwd: string;
  readonly json: boolean;
}

// — epics —

export async function runLsEpicsCommand(opts: LsEpicsOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  if (opts.unshipped && opts.status !== undefined) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: 'error: --unshipped and --status are mutually exclusive\n',
    };
  }

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    let epics = [...outcome.graph.epics.values()];
    if (opts.status !== undefined) {
      epics = epics.filter((e) => e.status === opts.status);
    } else if (opts.unshipped) {
      epics = epics.filter(
        (e) => !(TERMINAL_EPIC_STATUSES as readonly EpicStatus[]).includes(e.status),
      );
    }
    epics.sort((a, b) => a.id.localeCompare(b.id));

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            epics: epics.map((e) => {
              const sprintIds = outcome.graph.sprintsByEpic.get(e.id) ?? [];
              const sprints = sprintIds
                .map((sid) => outcome.graph.sprints.get(sid))
                .filter((s): s is Sprint => s !== undefined);
              const counts = denseSprintCounts(sprints);
              const total = sprints.length;
              const progressPercent = total === 0 ? 0 : Math.round((counts.shipped / total) * 100);
              return {
                id: e.id,
                title: e.title,
                status: e.status,
                gate: e.gate ?? null,
                sprintCounts: counts,
                total,
                progressPercent,
                sprints: sprintIds,
              };
            }),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    if (epics.length === 0) {
      return { exitCode: EXIT_OK, stdout: '(no epics)\n', stderr: '' };
    }

    const rows = epics.map((e) => {
      const sprintIds = outcome.graph.sprintsByEpic.get(e.id) ?? [];
      const sprints = sprintIds
        .map((sid) => outcome.graph.sprints.get(sid))
        .filter((s): s is Sprint => s !== undefined);
      const counts = countSprints(sprints);
      const total = sprints.length;
      return {
        id: e.id,
        status: colorEpicStatus(e.status),
        progress: progressBar(counts.shipped, total),
        title: truncate(e.title, 50),
      };
    });

    const out = renderTable(rows, [
      { key: 'id', header: 'ID' },
      { key: 'status', header: 'STATUS' },
      { key: 'progress', header: 'PROGRESS' },
      { key: 'title', header: 'TITLE' },
    ]);

    return { exitCode: EXIT_OK, stdout: `${out}\n`, stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — sprints —

export async function runLsSprintsCommand(opts: LsSprintsOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  if (opts.last !== undefined && (!Number.isInteger(opts.last) || opts.last < 1)) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: 'error: --last must be a positive integer\n',
    };
  }
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    let sprints = [...outcome.graph.sprints.values()];

    if (opts.epic !== undefined) {
      const epicSprints = new Set(outcome.graph.sprintsByEpic.get(opts.epic) ?? []);
      sprints = sprints.filter((s) => epicSprints.has(s.id));
    }
    if (opts.status !== undefined) {
      sprints = sprints.filter((s) => s.status === opts.status);
    }
    if (opts.lane !== undefined) {
      sprints = sprints.filter((s) => s.lane === opts.lane);
    }
    if (opts.last !== undefined) {
      sprints = takeMostRecent(sprints, opts.last);
    } else {
      sprints.sort((a, b) => a.id.localeCompare(b.id));
    }

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            sprints: sprints.map((s) => ({
              id: s.id,
              title: s.title,
              status: s.status,
              lane: s.lane,
              epic_id: s.epic_id,
              depends_on: s.depends_on,
              blocked_by: s.blocked_by,
              started_at: s.started_at ?? null,
              closed_at: s.closed_at ?? null,
            })),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    if (sprints.length === 0) {
      return { exitCode: EXIT_OK, stdout: '(no sprints)\n', stderr: '' };
    }

    const cols = [
      { key: 'id', header: 'ID' },
      { key: 'status', header: 'STATUS' },
      { key: 'lane', header: 'LANE' },
      { key: 'epic', header: 'EPIC' },
      { key: 'title', header: 'TITLE' },
      ...(opts.withDeps ? [{ key: 'deps', header: 'DEPS' }] : []),
    ];

    const rows = sprints.map((s) => ({
      id: s.id,
      status: colorSprintStatus(s.status),
      lane: s.lane,
      epic: s.epic_id,
      title: truncate(s.title, 40),
      ...(opts.withDeps ? { deps: s.depends_on.length > 0 ? s.depends_on.join(', ') : '—' } : {}),
    }));

    const out = renderTable(rows, cols);
    return { exitCode: EXIT_OK, stdout: `${out}\n`, stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — reviews —

export async function runLsReviewsCommand(opts: LsReviewsOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    let reviews = [...outcome.graph.reviews.values()];

    if (opts.sprint !== undefined) {
      reviews = reviews.filter((r) => r.sprint_id === opts.sprint);
    }
    if (opts.verdict !== undefined) {
      reviews = reviews.filter((r) => r.verdict === opts.verdict);
    }
    reviews.sort((a, b) => a.id.localeCompare(b.id));

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            reviews: reviews.map((r) => ({
              id: r.id,
              sprint_id: r.sprint_id,
              verdict: r.verdict,
              reviewer: r.reviewer,
              created_at: r.created_at,
              findings_count: r.findings.length,
            })),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    if (reviews.length === 0) {
      return { exitCode: EXIT_OK, stdout: '(no reviews)\n', stderr: '' };
    }

    const rows = reviews.map((r) => ({
      id: r.id,
      verdict: colorReviewVerdict(r.verdict),
      sprint: r.sprint_id,
      reviewer: r.reviewer,
    }));

    const out = renderTable(rows, [
      { key: 'id', header: 'ID' },
      { key: 'verdict', header: 'VERDICT' },
      { key: 'sprint', header: 'SPRINT' },
      { key: 'reviewer', header: 'REVIEWER' },
    ]);

    return { exitCode: EXIT_OK, stdout: `${out}\n`, stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — lanes list —

export async function runLsLanesCommand(opts: LsLanesOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const laneNames = [...outcome.graph.lanes.keys()].sort();

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            lanes: laneNames.map((name) => {
              const state = outcome.graph.lanes.get(name)!;
              const slots = outcome.graph.queuesByLane.get(name) ?? [];
              const activeSprint = findActiveSprint(outcome.graph.sprints, name);
              const nextSprint = findNextQueued(slots, outcome.graph.sprints);
              return {
                name,
                claimed_by: state.claimed_by ?? null,
                claimed_at: state.claimed_at ?? null,
                queueDepth: slots.length,
                activeSprint: activeSprint?.id ?? null,
                nextSprint: nextSprint?.id ?? null,
              };
            }),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    if (laneNames.length === 0) {
      return { exitCode: EXIT_OK, stdout: '(no lanes)\n', stderr: '' };
    }

    const rows = laneNames.map((name) => {
      const state = outcome.graph.lanes.get(name)!;
      const slots = outcome.graph.queuesByLane.get(name) ?? [];
      const activeSprint = findActiveSprint(outcome.graph.sprints, name);
      const nextSprint = findNextQueued(slots, outcome.graph.sprints);
      return {
        name,
        claim: state.claimed_by ? 'claimed' : 'free',
        claimedBy: state.claimed_by ?? '—',
        depth: `depth: ${slots.length}`,
        active: `active: ${activeSprint?.id ?? 'none'}`,
        next: `next: ${nextSprint?.id ?? 'none'}`,
      };
    });

    const out = renderTable(rows, [
      { key: 'name', header: 'LANE' },
      { key: 'claim', header: 'STATUS' },
      { key: 'claimedBy', header: 'CLAIMED BY' },
      { key: 'depth', header: 'QUEUE' },
      { key: 'active', header: 'ACTIVE' },
      { key: 'next', header: 'NEXT' },
    ]);

    return { exitCode: EXIT_OK, stdout: `${out}\n`, stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — helpers —

function countSprints(sprints: Sprint[]): Record<string, number> & { shipped: number } {
  const counts: Record<string, number> & { shipped: number } = { shipped: 0 };
  for (const s of sprints) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  counts.shipped = counts.shipped ?? 0;
  return counts;
}

/**
 * Dense status histogram — every SprintStatus key is present, zero-filled.
 * Stable shape lets agents read `counts.cancelled` without an `?? 0` guard.
 *
 * Used in `rk ls epics --json` (machine-readable surface). The terminal
 * table view still uses `countSprints` for its sparse map (no UI value in
 * showing zero rows).
 */
function denseSprintCounts(sprints: readonly Sprint[]): Record<SprintStatus, number> {
  const counts = Object.fromEntries(SPRINT_STATUSES.map((s) => [s, 0])) as Record<
    SprintStatus,
    number
  >;
  for (const s of sprints) counts[s.status] += 1;
  return counts;
}

/**
 * Select the N most-recent sprints by activity timestamp.
 *
 * Activity timestamp = `closed_at ?? started_at` — whichever is set, whichever
 * is newer wins regardless of kind. A sprint that started yesterday ranks
 * above a sprint that shipped two days ago, because the user is asking
 * "what's been happening lately?".
 *
 * Tiebreaker: id desc — stable, deterministic. Sprints lacking both
 * timestamps fall to the bottom, then ordered by id desc.
 *
 * For "what just shipped?", combine with `--status shipped`.
 */
function takeMostRecent(sprints: readonly Sprint[], n: number): Sprint[] {
  const sortable = sprints.slice();
  sortable.sort((a, b) => {
    const ak = a.closed_at ?? a.started_at ?? '';
    const bk = b.closed_at ?? b.started_at ?? '';
    if (ak !== bk) return bk.localeCompare(ak);
    return b.id.localeCompare(a.id);
  });
  return sortable.slice(0, n);
}

function findActiveSprint(sprints: ReadonlyMap<string, Sprint>, lane: string): Sprint | undefined {
  for (const s of sprints.values()) {
    if (s.lane === lane && s.status === 'active') return s;
  }
  return undefined;
}

function findNextQueued(
  slots: readonly { sprint_id: string; order: number }[],
  sprints: ReadonlyMap<string, Sprint>,
): Sprint | undefined {
  const sorted = [...slots].sort((a, b) => a.order - b.order);
  for (const slot of sorted) {
    const s = sprints.get(slot.sprint_id);
    if (s && s.status === 'queued') return s;
  }
  return undefined;
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}

function runtimeErr(e: unknown): CommandResult {
  if (e instanceof RepoKernelError)
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
  throw e;
}

// re-export Epic type for consumers
export type { Epic, EpicStatus };
