import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Config, EpicIdSchema, LaneNameSchema, SprintIdSchema } from '@repokernel/core';
import { atomicCreateText, atomicWriteText } from '../../lifecycle/atomicWrite.js';
import { operationalRootBestEffort } from '../../lifecycle/controlPaths.js';
import { withLockRetrying } from '../../lifecycle/locks.js';
import { yamlArray, yamlScalar } from '../../templates/yaml.js';
import { appendSlotToQueue } from '../queue.js';
import { nextTaskId, taskAliasPath } from './taskId.js';
import type { TaskAlias, TaskId, TaskInput, TaskTrackerMetadata } from './types.js';

export interface SynthesizeResult {
  readonly taskId: TaskId;
  readonly epicId: string;
  readonly sprintId: string;
  readonly title: string;
  /** Absolute paths to all files written by synthesis. Useful for auto-commit. */
  readonly writtenFiles: readonly string[];
  readonly epicFile: string;
  readonly sprintFile: string;
  readonly queueFile: string;
  readonly aliasFile: string;
}

/**
 * Synthesize an epic+sprint pair on disk so an existing `runRunCommand`
 * invocation can pick the work up exactly like a hand-authored sprint.
 *
 * Flow:
 *   1. Allocate next T-NNN (scan-based)
 *   2. Allocate next E-NNN, S-NNN by extending the existing scan pattern
 *   3. Write epic .md (status: active, sprints: [S-NNN])
 *   4. Write sprint .md (status: queued, lane: defaultLane)
 *   5. Ensure queue file exists for the lane (create if missing)
 *   6. Append sprint slot to queue
 *   7. Persist the alias `tasks/T-NNN.json`
 *
 * The synthesized epic and sprint conform to existing schemas; the only fastpath
 * marker is `extras.task_id` (and `extras.task_*` siblings) for audit.
 */
export interface SynthesizeOptions {
  /**
   * When false, the synthesized sprint is rendered with `review_required: false`
   * on the first write — no post-synthesis mutation required. Used by `rk
   * hotfix`, which by design bypasses the review pipeline.
   */
  readonly reviewRequired?: boolean;
  /**
   * Lane to place the synthesized sprint on. Defaults to
   * `config.policies.defaultLane` to preserve historical behavior. Callers
   * resolve `--lane auto`/named placement before synthesis and pass the result
   * here.
   */
  readonly lane?: string;
  /**
   * Extra key/value pairs merged into the sprint's `extras` block for audit
   * (e.g. `forked_from`, `parent_base_sha`). Reserved keys (`task_id`,
   * `task_source`, `fastpath`) always win over these.
   */
  readonly extraExtras?: Readonly<Record<string, unknown>>;
}

export async function synthesizeTaskState(
  cwd: string,
  config: Config,
  input: TaskInput,
  opts: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  // Defensive: the lane becomes a `<lane>.md` path under queues/. Reject any
  // value that could escape that directory even if a caller skipped validation.
  const lane = LaneNameSchema.parse(opts.lane ?? config.policies.defaultLane);
  const epicsDir = resolve(cwd, config.paths.epics);
  const sprintsDir = resolve(cwd, config.paths.sprints);
  const queuesDir = resolve(cwd, config.paths.queues);

  await Promise.all([
    mkdir(epicsDir, { recursive: true }),
    mkdir(sprintsDir, { recursive: true }),
    mkdir(queuesDir, { recursive: true }),
  ]);

  const opRoot = await operationalRootBestEffort(cwd);

  // Allocate ids + write epic, sprint, and task-alias inside a single
  // fastpath-create lock. Two concurrent synthesizers would otherwise both
  // compute the same T-NNN/E-NNN/S-NNN by scanning a stale directory; one
  // would lose the race at link()/wx with EEXIST. Loops retry on EEXIST so
  // a stray pre-existing file (out-of-band manual create) advances to the
  // next free slot. The alias write is inside the lock so the T-NNN it
  // depends on is observable to the next synthesizer's scan before it
  // computes its own taskId.
  const MAX_ID_RETRIES = 50;
  const allocated = await withLockRetrying(
    'fastpath-create',
    opRoot,
    async (): Promise<{
      taskId: TaskId;
      epicId: string;
      sprintId: string;
      title: string;
      epicFile: string;
      sprintFile: string;
    }> => {
      const title = deriveTitle(input.body);

      // Allocate ids + write fully-formed content for each artifact under
      // a single lock. No placeholder writes — each `atomicCreateText`
      // commits real content, so a kill between two writes leaves at
      // most a fully-valid earlier artifact (the next synthesize's scan
      // sees it and advances). Each loop is bounded at MAX_ID_RETRIES so
      // a poisoned filesystem cannot spin forever holding the lock.
      let epicId: string;
      let epicFile: string;
      // Pick a tentative taskId early so we can stamp it into the epic
      // body; we resolve the real (collision-free) taskId after sprint
      // allocation by scanning again.
      const tentativeTaskId = await nextTaskId(cwd, config);
      for (let attempt = 0; ; attempt++) {
        if (attempt >= MAX_ID_RETRIES) {
          throw new Error(
            `fastpath: could not allocate E-id after ${MAX_ID_RETRIES} attempts; check ${epicsDir} for orphans`,
          );
        }
        epicId = await nextSequentialId(epicsDir, 'E');
        EpicIdSchema.parse(epicId);
        epicFile = join(epicsDir, `${epicId}.md`);
        try {
          await atomicCreateText(
            epicFile,
            renderEpic({
              id: epicId,
              title,
              sprintId: '',
              taskId: tentativeTaskId,
              ...(input.tracker !== undefined ? { tracker: input.tracker } : {}),
            }),
          );
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'EEXIST') throw cause;
        }
      }

      let sprintId: string;
      let sprintFile: string;
      for (let attempt = 0; ; attempt++) {
        if (attempt >= MAX_ID_RETRIES) {
          throw new Error(
            `fastpath: could not allocate S-id after ${MAX_ID_RETRIES} attempts; check ${sprintsDir} for orphans`,
          );
        }
        sprintId = await nextSequentialId(sprintsDir, 'S');
        SprintIdSchema.parse(sprintId);
        sprintFile = join(sprintsDir, `${sprintId}.md`);
        try {
          await atomicCreateText(
            sprintFile,
            renderSprint({
              id: sprintId,
              title,
              epicId,
              lane,
              body: input.body,
              acceptanceCriteria: input.acceptanceCriteria,
              constraints: input.constraints,
              allowedPaths: input.allowedPaths ?? [],
              deniedPaths: input.deniedPaths ?? [],
              taskId: tentativeTaskId,
              source: input.source,
              ...(opts.reviewRequired === false ? { reviewRequired: false } : {}),
              ...(opts.extraExtras !== undefined ? { extraExtras: opts.extraExtras } : {}),
            }),
          );
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'EEXIST') throw cause;
        }
      }

      // Patch the epic body so it points at the actual sprintId. Atomic
      // in-place replace.
      await atomicWriteText(
        epicFile,
        renderEpic({
          id: epicId,
          title,
          sprintId,
          taskId: tentativeTaskId,
          ...(input.tracker !== undefined ? { tracker: input.tracker } : {}),
        }),
      );

      // Now allocate + write the alias atomically using create-or-EEXIST
      // semantics. The alias content is fully-formed at write time — no
      // placeholder leak (PR4 finding 2). Bounded loop in case a
      // non-fastpath caller raced us to a T-NNN slot.
      let taskId: TaskId = tentativeTaskId;
      let aliasFile: string = taskAliasPath(cwd, config, taskId);
      for (let attempt = 0; ; attempt++) {
        if (attempt >= MAX_ID_RETRIES) {
          throw new Error(`fastpath: could not allocate T-id after ${MAX_ID_RETRIES} attempts`);
        }
        const alias: TaskAlias = {
          id: taskId,
          epic_id: epicId,
          sprint_id: sprintId,
          source: input.source,
          title,
          created_at: new Date().toISOString(),
          closed_at: null,
          status: 'active',
          ...(input.tracker !== undefined ? { tracker: input.tracker } : {}),
        };
        try {
          await atomicCreateText(aliasFile, `${JSON.stringify(alias, null, 2)}\n`);
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'EEXIST') throw cause;
          taskId = await nextTaskId(cwd, config);
          aliasFile = taskAliasPath(cwd, config, taskId);
        }
      }

      return { taskId, epicId, sprintId, title, epicFile, sprintFile };
    },
    { deadlineMs: 10_000 },
  );

  const { taskId, epicId, sprintId, title, epicFile, sprintFile } = allocated;
  const queueFile = await ensureQueueAndAppend(queuesDir, lane, sprintId, opRoot);
  const aliasFile = taskAliasPath(cwd, config, taskId);

  return {
    taskId,
    epicId,
    sprintId,
    title,
    writtenFiles: [epicFile, sprintFile, queueFile, aliasFile],
    epicFile,
    sprintFile,
    queueFile,
    aliasFile,
  };
}

/** Sequential ID matching create.ts: scan dir for `${prefix}-N(.md)`, max+1. */
async function nextSequentialId(dir: string, prefix: 'E' | 'S'): Promise<string> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const re = new RegExp(`^${prefix}-(\\d+)(?:-.+)?\\.md$`);
  const nums = files.flatMap((f) => {
    const m = re.exec(f);
    return m?.[1] !== undefined ? [parseInt(m[1], 10)] : [];
  });
  const n = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

function deriveTitle(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return 'Untitled task';
  // Cap at ~80 chars for readability in epic/sprint titles.
  const trimmed = firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}…` : firstLine;
  return trimmed;
}

function renderEpic(input: {
  readonly id: string;
  readonly title: string;
  readonly sprintId: string;
  readonly taskId: TaskId;
  readonly tracker?: TaskTrackerMetadata;
}): string {
  // Every tracker scalar routes through yamlScalar so that YAML-edge-case
  // strings ("null", "true", "yes", a leading "*") are quoted consistently.
  // Direct JSON.stringify happens to be safe today but the inconsistency
  // sets a maintenance trap for future contributors.
  const trackerExtras =
    input.tracker === undefined
      ? ''
      : `  external_id: ${yamlScalar(input.tracker.id)}
  tracker_source: ${yamlScalar(input.tracker.source)}
  tracker_url: ${yamlScalar(input.tracker.url)}
  tracker_labels:${yamlNestedArray(input.tracker.labels, '  ')}
  tracker_assignee: ${yamlScalar(input.tracker.assignee)}
`;
  return `---
id: ${input.id}
title: ${JSON.stringify(input.title)}
status: active
adr_links: []
sprints:
  - ${input.sprintId}
extras:
  task_id: ${JSON.stringify(input.taskId)}
  fastpath: true
${trackerExtras}
---

# ${input.id}: ${input.title}

Synthesized by RepoKernel fastpath for task ${input.taskId}.
`;
}

function renderSprint(input: {
  readonly id: string;
  readonly title: string;
  readonly epicId: string;
  readonly lane: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly deniedPaths: readonly string[];
  readonly taskId: TaskId;
  readonly source: string;
  readonly reviewRequired?: boolean;
  readonly extraExtras?: Readonly<Record<string, unknown>>;
}): string {
  const acceptanceBlock =
    input.acceptanceCriteria.length === 0
      ? '- [ ] Tests pass\n- [ ] Implementation matches the task description'
      : input.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n');

  const constraintsBlock =
    input.constraints.length === 0
      ? '_(none specified)_'
      : input.constraints.map((c) => `- ${c}`).join('\n');
  const deniedPaths = [...new Set([...input.deniedPaths, ...input.constraints])];

  const extras: Record<string, unknown> = {
    ...input.extraExtras,
    task_id: input.taskId,
    task_source: input.source,
    fastpath: true,
  };
  if (input.acceptanceCriteria.length > 0) {
    extras.task_acceptance_criteria = [...input.acceptanceCriteria];
  }
  if (input.constraints.length > 0) {
    extras.task_constraints = [...input.constraints];
  }

  return `---
id: ${input.id}
title: ${JSON.stringify(input.title)}
epic_id: ${yamlScalar(input.epicId)}
status: queued
lane: ${yamlScalar(input.lane)}
depends_on: []
blocked_by: []
${yamlArrayField('allowed_paths', input.allowedPaths)}
${yamlArrayField('denied_paths', deniedPaths)}
generated_paths: []
review_required: ${input.reviewRequired === false ? 'false' : 'true'}
review_id: null
started_at: null
closed_at: null
base_sha: null
end_sha: null
target_date: null
adr_links: []
extras:
${formatYamlObject(extras, '  ')}
---

# ${input.id}: ${input.title}

## Task

${input.body}

## Acceptance criteria

${acceptanceBlock}

## Constraints

${constraintsBlock}

## Notes
<!-- append-only, dated -->
`;
}

function yamlArrayField(key: string, values: readonly string[]): string {
  return values.length === 0 ? `${key}: []` : `${key}:${yamlArray(values)}`;
}

function yamlNestedArray(values: readonly string[], indent: string): string {
  if (values.length === 0) return ' []';
  return `\n${values.map((v) => `${indent}  - ${yamlScalar(v)}`).join('\n')}`;
}

/** Minimal YAML object renderer for the `extras` block. */
function formatYamlObject(obj: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${indent}${k}: []`);
      } else {
        lines.push(`${indent}${k}:`);
        for (const item of v) lines.push(`${indent}  - ${JSON.stringify(item)}`);
      }
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${indent}${k}: ${v}`);
    } else {
      lines.push(`${indent}${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Ensure a queue file exists for the given lane, then append a slot pointing
 * at the synthesized sprint. Mirrors create.ts + queue.ts append behavior.
 *
 * Returns the absolute path of the queue file (created or modified).
 */
async function ensureQueueAndAppend(
  queuesDir: string,
  lane: string,
  sprintId: string,
  opRoot: string,
): Promise<string> {
  const queueFile = join(queuesDir, `${lane}.md`);

  // First-create path: synthesize an initial queue with a single seeded
  // slot, atomically. atomicCreateText publishes via temp+link so a crash
  // mid-write cannot leave a half-published queue file at queueFile.
  if (!existsSync(queueFile)) {
    const initial = `---
lane: ${yamlScalar(lane)}
slots:
  - id: Q-001
    sprint_id: ${sprintId}
    order: 0
---

# ${lane} queue
`;
    try {
      await atomicCreateText(queueFile, initial);
      return queueFile;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') throw cause;
      // Fall through: another writer (concurrent fastpath) just created
      // the queue. Append below under the same shared lock as rk queue add.
    }
  }

  // Reuse the shared locked-append helper so concurrent fastpath
  // synthesizes and `rk queue add` invocations on the same lane serialize
  // through a single per-lane queue lock and never compute conflicting
  // Q-NNN ids or duplicate sprint_ids.
  await appendSlotToQueue(queueFile, sprintId, opRoot, lane);
  return queueFile;
}
