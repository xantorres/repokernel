import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { type Config, loadConfig } from '@repokernel/core';
import matter from 'gray-matter';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { isoNow } from '../templates/time.js';
import { yamlArray } from '../templates/yaml.js';
import type { CommandResult } from './validate.js';

export interface CreateEpicOptions {
  readonly cwd: string;
}

export interface CreateSprintOptions {
  readonly cwd: string;
  readonly epic: string;
  readonly lane: string;
  readonly status: string;
  readonly after?: string;
}

export interface CreateQueueOptions {
  readonly cwd: string;
  readonly lane: string;
}

export interface CreateReviewOptions {
  readonly cwd: string;
  readonly sprint: string;
  readonly reviewer: string;
}

const ALLOWED_CREATE_STATUSES = new Set(['planned', 'pending']);

export async function runCreateEpicCommand(
  title: string,
  opts: CreateEpicOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const cfg = await getConfig(cwd);
  if (!cfg.ok) return cfg.error;

  const { config } = cfg;
  const epicsDir = join(cwd, config.paths.epics);
  await mkdir(epicsDir, { recursive: true });

  const id = await nextId(epicsDir, 'E');
  const outPath = join(epicsDir, `${id}.md`);

  if (existsSync(outPath)) {
    return fileExistsError(rel(cwd, outPath));
  }

  const content = epicTemplate(id, title);
  await writeFile(outPath, content, { flag: 'wx' });

  return ok(formatResult('epic', { ID: id, Title: title, File: rel(cwd, outPath) }, []));
}

export async function runCreateSprintCommand(
  title: string,
  opts: CreateSprintOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const cfg = await getConfig(cwd);
  if (!cfg.ok) return cfg.error;

  const { config } = cfg;

  if (!ALLOWED_CREATE_STATUSES.has(opts.status)) {
    return err(`status must be planned or pending at create time (got: ${opts.status})`);
  }

  const epicsDir = join(cwd, config.paths.epics);
  const sprintsDir = join(cwd, config.paths.sprints);

  const epicFile = await findEntityFile(epicsDir, opts.epic);
  if (!epicFile) {
    return err(`epic ${opts.epic} not found`);
  }

  if (opts.after !== undefined) {
    const dep = await findEntityFile(sprintsDir, opts.after);
    if (!dep) {
      return err(`dependency sprint ${opts.after} not found`);
    }
  }

  await mkdir(sprintsDir, { recursive: true });

  const id = await nextId(sprintsDir, 'S');
  const outPath = join(sprintsDir, `${id}.md`);

  if (existsSync(outPath)) {
    return fileExistsError(rel(cwd, outPath));
  }

  const content = sprintTemplate({
    id,
    title,
    epicId: opts.epic,
    status: opts.status,
    lane: opts.lane,
    dependsOn: opts.after ? [opts.after] : [],
  });

  await writeFile(outPath, content, { flag: 'wx' });
  await appendSprintToEpic(epicFile, id);

  return ok(
    formatResult('sprint', { ID: id, Title: title, Epic: opts.epic, File: rel(cwd, outPath) }, [
      `${rel(cwd, epicFile)}  (appended ${id} to sprints)`,
    ]),
  );
}

export async function runCreateQueueCommand(opts: CreateQueueOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const cfg = await getConfig(cwd);
  if (!cfg.ok) return cfg.error;

  const { config } = cfg;
  const queuesDir = join(cwd, config.paths.queues);
  await mkdir(queuesDir, { recursive: true });

  const outPath = join(queuesDir, `${opts.lane}.md`);

  if (existsSync(outPath)) {
    return fileExistsError(rel(cwd, outPath));
  }

  const content = queueTemplate(opts.lane);
  await writeFile(outPath, content, { flag: 'wx' });

  return ok(formatResult('queue', { Lane: opts.lane, File: rel(cwd, outPath) }, []));
}

export async function runCreateReviewCommand(opts: CreateReviewOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const cfg = await getConfig(cwd);
  if (!cfg.ok) return cfg.error;

  const { config } = cfg;
  const sprintsDir = join(cwd, config.paths.sprints);
  const reviewsDir = join(cwd, config.paths.reviews);

  const sprintFile = await findEntityFile(sprintsDir, opts.sprint);
  if (!sprintFile) {
    return err(`sprint ${opts.sprint} not found`);
  }

  const sprintFm = await readFrontmatter(sprintFile);
  if (sprintFm.review_id !== null && sprintFm.review_id !== undefined) {
    return err(`sprint ${opts.sprint} already has review ${String(sprintFm.review_id)}`);
  }

  await mkdir(reviewsDir, { recursive: true });

  const id = await nextId(reviewsDir, 'R');
  const outPath = join(reviewsDir, `${id}.md`);

  if (existsSync(outPath)) {
    return fileExistsError(rel(cwd, outPath));
  }

  const content = reviewTemplate(id, opts.sprint, opts.reviewer);
  await writeFile(outPath, content, { flag: 'wx' });
  await setSprintReviewId(sprintFile, id);

  return ok(
    formatResult(
      'review',
      { ID: id, Sprint: opts.sprint, Reviewer: opts.reviewer, File: rel(cwd, outPath) },
      [`${rel(cwd, sprintFile)}  (set review_id: ${id})`],
    ),
  );
}

// — helpers —

async function nextId(dir: string, prefix: string): Promise<string> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const re = new RegExp(`^${prefix}-(\\d+)(?:-.+)?\\.md$`);
  const nums = files.flatMap((f) => {
    const m = re.exec(f);
    return m?.[1] !== undefined ? [parseInt(m[1], 10)] : [];
  });
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

async function findEntityFile(dir: string, id: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const re = new RegExp(`^${id}(?:-.+)?\\.md$`);
  const match = files.find((f) => re.test(f));
  return match ? join(dir, match) : null;
}

async function readFrontmatter(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

async function appendSprintToEpic(epicFile: string, sprintId: string): Promise<void> {
  const raw = await readFile(epicFile, 'utf8');
  const parsed = matter(raw);
  const sprints: string[] = Array.isArray(parsed.data.sprints) ? parsed.data.sprints : [];
  if (!sprints.includes(sprintId)) {
    parsed.data.sprints = [...sprints, sprintId];
    await writeFile(epicFile, matter.stringify(parsed.content, parsed.data), 'utf8');
  }
}

async function setSprintReviewId(sprintFile: string, reviewId: string): Promise<void> {
  const raw = await readFile(sprintFile, 'utf8');
  const parsed = matter(raw);
  parsed.data.review_id = reviewId;
  await writeFile(sprintFile, matter.stringify(parsed.content, parsed.data), 'utf8');
}

// — templates —

function epicTemplate(id: string, title: string): string {
  return `---
id: ${id}
title: ${JSON.stringify(title)}
status: planned
adr_links: []
sprints: []
---

# ${id}: ${title}
`;
}

function sprintTemplate(input: {
  readonly id: string;
  readonly title: string;
  readonly epicId: string;
  readonly status: string;
  readonly lane: string;
  readonly dependsOn: readonly string[];
}): string {
  return `---
id: ${input.id}
title: ${JSON.stringify(input.title)}
epic_id: ${input.epicId}
status: ${input.status}
lane: ${input.lane}
depends_on: ${yamlArray(input.dependsOn)}
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
---

# ${input.id}: ${input.title}

## Objective

## Acceptance Criteria

- [ ] AC-001:

## Non-goals

## Notes
`;
}

function queueTemplate(lane: string): string {
  return `---
lane: ${lane}
slots: []
---

# ${lane} queue
`;
}

function reviewTemplate(id: string, sprintId: string, reviewer: string): string {
  return `---
id: ${id}
sprint_id: ${sprintId}
verdict: pending
reviewer: ${reviewer}
findings: []
created_at: ${isoNow()}
---

# ${id}: Review ${sprintId}
`;
}

// — output —

function formatResult(
  type: string,
  fields: Record<string, string>,
  updated: readonly string[],
): string {
  const keyWidth = Math.max(...Object.keys(fields).map((k) => k.length));
  const lines: string[] = [`Created ${type}`, ''];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`  ${pc.bold(k.padEnd(keyWidth))}  ${v}`);
  }
  if (updated.length > 0) {
    lines.push('', 'Updated:');
    for (const u of updated) lines.push(`  ${u}`);
  }
  lines.push('', `Next: ${pc.dim('rk validate')}`);
  return `${lines.join('\n')}\n`;
}

function ok(stdout: string): CommandResult {
  return { exitCode: EXIT_OK, stdout, stderr: '' };
}

function err(message: string): CommandResult {
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${message}\n` };
}

function fileExistsError(path: string): CommandResult {
  return err(`file already exists: ${path}`);
}

function rel(cwd: string, abs: string): string {
  return relative(cwd, abs);
}

type ConfigOk = { ok: true; config: Config };
type ConfigErr = { ok: false; error: CommandResult };

async function getConfig(cwd: string): Promise<ConfigOk | ConfigErr> {
  const result = await loadConfig({ cwd });
  if (!result.ok) {
    return {
      ok: false,
      error: {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found; run repokernel init first\n',
      },
    };
  }
  return { ok: true, config: result.config };
}
