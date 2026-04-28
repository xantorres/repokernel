import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Config, EpicIdSchema, SprintIdSchema } from '@repokernel/core';
import matter from 'gray-matter';
import { yamlScalar } from '../../templates/yaml.js';
import { writeTaskAlias } from './taskAlias.js';
import { nextTaskId, taskAliasPath } from './taskId.js';
import type { TaskAlias, TaskId, TaskInput } from './types.js';

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
export async function synthesizeTaskState(
  cwd: string,
  config: Config,
  input: TaskInput,
): Promise<SynthesizeResult> {
  const lane = config.policies.defaultLane;
  const epicsDir = resolve(cwd, config.paths.epics);
  const sprintsDir = resolve(cwd, config.paths.sprints);
  const queuesDir = resolve(cwd, config.paths.queues);

  await Promise.all([
    mkdir(epicsDir, { recursive: true }),
    mkdir(sprintsDir, { recursive: true }),
    mkdir(queuesDir, { recursive: true }),
  ]);

  const taskId = await nextTaskId(cwd, config);
  const epicId = await nextSequentialId(epicsDir, 'E');
  const sprintId = await nextSequentialId(sprintsDir, 'S');

  // Validate the IDs satisfy the canonical schemas — defensive: the regexes
  // we share with create.ts must agree with the schema regexes here.
  EpicIdSchema.parse(epicId);
  SprintIdSchema.parse(sprintId);

  const title = deriveTitle(input.body);

  const epicFile = join(epicsDir, `${epicId}.md`);
  const sprintFile = join(sprintsDir, `${sprintId}.md`);

  if (existsSync(epicFile) || existsSync(sprintFile)) {
    throw new Error(`fastpath collision: ${epicId} or ${sprintId} already exists on disk`);
  }

  await writeFile(epicFile, renderEpic({ id: epicId, title, sprintId, taskId }), {
    encoding: 'utf8',
    flag: 'wx',
  });

  await writeFile(
    sprintFile,
    renderSprint({
      id: sprintId,
      title,
      epicId,
      lane,
      body: input.body,
      acceptanceCriteria: input.acceptanceCriteria,
      constraints: input.constraints,
      taskId,
      source: input.source,
    }),
    { encoding: 'utf8', flag: 'wx' },
  );

  const queueFile = await ensureQueueAndAppend(queuesDir, lane, sprintId);

  const alias: TaskAlias = {
    id: taskId,
    epic_id: epicId,
    sprint_id: sprintId,
    source: input.source,
    title,
    created_at: new Date().toISOString(),
    closed_at: null,
    status: 'active',
  };
  await writeTaskAlias(cwd, config, alias);
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
}): string {
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
  readonly taskId: TaskId;
  readonly source: string;
}): string {
  const acceptanceBlock =
    input.acceptanceCriteria.length === 0
      ? '- [ ] Tests pass\n- [ ] Implementation matches the task description'
      : input.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n');

  const constraintsBlock =
    input.constraints.length === 0
      ? '_(none specified)_'
      : input.constraints.map((c) => `- ${c}`).join('\n');

  const extras: Record<string, unknown> = {
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
allowed_paths: []
denied_paths: []
generated_paths: []
review_required: true
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
): Promise<string> {
  const queueFile = join(queuesDir, `${lane}.md`);

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
    await writeFile(queueFile, initial, { encoding: 'utf8', flag: 'wx' });
    return queueFile;
  }

  const raw = await readFile(queueFile, 'utf8');
  const parsed = matter(raw);
  const slots: unknown[] = Array.isArray(parsed.data.slots) ? parsed.data.slots : [];

  // Compute next slot id + order, mirroring computeNextSlot from queue.ts
  const slotRe = /^Q-(\d+)$/;
  let maxNum = 0;
  let maxOrder = -1;
  for (const slot of slots) {
    if (typeof slot !== 'object' || slot === null) continue;
    const obj = slot as Record<string, unknown>;
    if (typeof obj.id === 'string') {
      const m = slotRe.exec(obj.id);
      if (m?.[1] !== undefined) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    if (typeof obj.order === 'number') {
      maxOrder = Math.max(maxOrder, obj.order);
    }
  }

  const nextSlot = {
    id: `Q-${String(maxNum + 1).padStart(3, '0')}`,
    sprint_id: sprintId,
    order: maxOrder + 1,
  };

  const newSlots = [...slots, nextSlot];
  const newData = { ...parsed.data, slots: newSlots };
  await writeFile(queueFile, matter.stringify(parsed.content, newData), 'utf8');
  return queueFile;
}
