import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { type Config, loadConfig } from '@repokernel/core';
import matter from 'gray-matter';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { allocateOneId, type CounterKind } from '../lifecycle/counters.js';
import { isoNow } from '../templates/time.js';
import { yamlArray, yamlScalar } from '../templates/yaml.js';
import type { CommandResult } from './validate.js';

export interface CreateEpicOptions {
  readonly cwd: string;
}

export interface CreateSprintOptions {
  readonly cwd: string;
  readonly epic: string;
  readonly lane: string;
  readonly status: string;
  readonly after?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly adrLinks?: readonly string[];
  readonly targetDate?: string;
  readonly bodyFile?: string;
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

  const opRoot = await operationalRootBestEffort(cwd);
  const id = await allocateUnique(opRoot, 'epic', epicsDir);
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

  if (opts.targetDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.targetDate)) {
    return err(`--target-date must be yyyy-mm-dd (got: ${opts.targetDate})`);
  }

  const epicsDir = join(cwd, config.paths.epics);
  const sprintsDir = join(cwd, config.paths.sprints);

  const epicFile = await findEntityFile(epicsDir, opts.epic);
  if (!epicFile) {
    return err(`epic ${opts.epic} not found`);
  }

  const dependsOn = opts.after ?? [];
  const seenDeps = new Set<string>();
  for (const dep of dependsOn) {
    if (seenDeps.has(dep)) {
      return err(`duplicate --after value: ${dep}`);
    }
    seenDeps.add(dep);
    const depFile = await findEntityFile(sprintsDir, dep);
    if (!depFile) {
      return err(`dependency sprint ${dep} not found`);
    }
  }

  let body: string | undefined;
  if (opts.bodyFile !== undefined) {
    const bodyPath = resolve(cwd, opts.bodyFile);
    let raw: string;
    try {
      raw = await readFile(bodyPath, 'utf8');
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return err(`--body-file not found: ${opts.bodyFile}`);
      }
      throw cause;
    }
    if (raw.startsWith('---')) {
      return err('--body-file must not contain a frontmatter delimiter (rk owns frontmatter)');
    }
    body = raw.endsWith('\n') ? raw : `${raw}\n`;
  }

  await mkdir(sprintsDir, { recursive: true });

  const opRoot = await operationalRootBestEffort(cwd);
  const id = await allocateUnique(opRoot, 'sprint', sprintsDir);
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
    dependsOn,
    allowedPaths: opts.allowedPaths ?? [],
    deniedPaths: opts.deniedPaths ?? [],
    adrLinks: opts.adrLinks ?? [],
    ...(opts.targetDate !== undefined ? { targetDate: opts.targetDate } : {}),
    ...(body !== undefined ? { body } : {}),
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

  const opRoot = await operationalRootBestEffort(cwd);
  const id = await allocateUnique(opRoot, 'review', reviewsDir);
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

/**
 * Allocate a fresh entity ID under the appropriate counter lock and return it.
 *
 * The counter lives at <opRoot>/counters/<kind>s.json and is shared across all
 * git worktrees of the same repository, so concurrent worktree agents do not
 * see each other's working-tree-local entity files but DO share the counter.
 *
 * The wx open in the caller still protects against name collisions caused by
 * out-of-band file creation. If the caller's wx open hits EEXIST it should
 * call this helper again to advance to the next free slot.
 */
async function allocateUnique(
  opRoot: string,
  kind: CounterKind,
  entityDir: string,
): Promise<string> {
  // Loop only on EEXIST so manually-created files transparently advance the
  // counter rather than producing collisions on the next create call.
  while (true) {
    const id = await allocateOneId(opRoot, kind, entityDir);
    if (!existsSync(join(entityDir, `${id}.md`))) return id;
  }
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
  readonly allowedPaths: readonly string[];
  readonly deniedPaths: readonly string[];
  readonly adrLinks: readonly string[];
  readonly targetDate?: string;
  readonly body?: string;
}): string {
  const targetDateLine = input.targetDate !== undefined ? yamlScalar(input.targetDate) : 'null';
  const body =
    input.body ??
    `# ${input.id}: ${input.title}

## Objective


## Scope in

-

## Scope out

-

## Acceptance criteria

- [ ] Tests pass
- [ ]

## Dependencies


## Notes
<!-- append-only, dated -->
`;
  return `---
id: ${input.id}
title: ${JSON.stringify(input.title)}
epic_id: ${yamlScalar(input.epicId)}
status: ${input.status}
lane: ${yamlScalar(input.lane)}
depends_on: ${yamlArray(input.dependsOn)}
blocked_by: []
allowed_paths: ${yamlArray(input.allowedPaths)}
denied_paths: ${yamlArray(input.deniedPaths)}
generated_paths: []
review_required: true
review_id: null
started_at: null
closed_at: null
base_sha: null
end_sha: null
target_date: ${targetDateLine}
adr_links: ${yamlArray(input.adrLinks)}
---

${body}`;
}

function queueTemplate(lane: string): string {
  return `---
lane: ${yamlScalar(lane)}
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
reviewer: ${yamlScalar(reviewer)}
findings: []
created_at: ${isoNow()}
---

# ${id}: Review ${sprintId}

## Findings

### CRITICAL (0)

### HIGH (0)

### MEDIUM (0)

### LOW (0)

## Open issues

## Retrospective
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
  lines.push('', `Next: ${pc.dim('rk validate --fail-on P0,P1')}`);
  return `${lines.join('\n')}\n`;
}

function ok(stdout: string): CommandResult {
  return { exitCode: EXIT_OK, stdout, stderr: '' };
}

function err(message: string): CommandResult {
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `error: ${message}\n` };
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
