import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { type Config, loadConfig } from '@repokernel/core';
import matter from 'gray-matter';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { type CounterKind, formatId, readOrSeedCounter, writeNext } from '../lifecycle/counters.js';
import { withLockRetrying } from '../lifecycle/locks.js';
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
  readonly skipIds?: readonly string[];
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
  const { id, outPath } = await allocateAndWrite(opRoot, 'epic', epicsDir, (allocatedId) =>
    epicTemplate(allocatedId, title),
  );

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
    // Reject any line that is exactly `---` — gray-matter would treat such a
    // line as a frontmatter delimiter on the next parse, corrupting the
    // file. The check covers prefix + mid-body so a body that "looks
    // markdown-y" but accidentally contains a thematic break written as
    // `---` is caught before we write it.
    const hasDelimiterLine = raw.split('\n').some((line) => line.trim() === '---');
    if (hasDelimiterLine) {
      return err('--body-file must not contain a `---` delimiter line (rk owns frontmatter)');
    }
    body = raw.endsWith('\n') ? raw : `${raw}\n`;
  }

  await mkdir(sprintsDir, { recursive: true });

  // Skip-list: reserved IDs the allocator must pass over. Pulled from
  // policies.skippedSprintIds (config-resident, e.g. retired ID gaps) and
  // optionally extended via --skip-ids (one-shot CLI override).
  const skipIds = new Set<string>([...config.policies.skippedSprintIds, ...(opts.skipIds ?? [])]);

  // --skip-ids values must be valid S-NNN sprint IDs. Config values are
  // already schema-validated; this guards the CLI surface.
  for (const sid of opts.skipIds ?? []) {
    if (!/^S-\d+$/.test(sid)) {
      return err(`--skip-ids value must match S-NNN (got: ${sid})`);
    }
  }

  const opRoot = await operationalRootBestEffort(cwd);
  const { id, outPath } = await allocateAndWrite(
    opRoot,
    'sprint',
    sprintsDir,
    (allocatedId) =>
      sprintTemplate({
        id: allocatedId,
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
      }),
    skipIds.size > 0 ? skipIds : undefined,
  );
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
  const { id, outPath } = await allocateAndWrite(opRoot, 'review', reviewsDir, (allocatedId) =>
    reviewTemplate(allocatedId, opts.sprint, opts.reviewer),
  );
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
 * Allocate a fresh entity ID and create the entity file atomically.
 *
 * The counter lives at <opRoot>/counters/<kind>s.json and is shared across
 * all git worktrees of the same repository (via git-common-dir), so
 * concurrent worktree agents see the same counter even when each works in
 * its own working-tree-local sprints/epics/reviews/ directory.
 *
 * Both the counter advance AND the `wx` create-or-fail open run inside the
 * same lock, so a stray pre-existing file (out-of-band manual create) makes
 * the counter advance to the next free slot rather than racing the caller.
 * Without this, two concurrent `rk create sprint` invocations could both
 * allocate the same ID, both pass an externalized existsSync check, and one
 * would lose at the writeFile call.
 */
async function allocateAndWrite(
  opRoot: string,
  kind: CounterKind,
  entityDir: string,
  contentBuilder: (id: string) => string | Promise<string>,
  skipIds?: ReadonlySet<string>,
): Promise<{ id: string; outPath: string }> {
  return withLockRetrying(`${kind}-id`, opRoot, async () => {
    let next = await readOrSeedCounter(opRoot, kind, entityDir);
    while (true) {
      const id = formatId(kind, next);
      // Reserved IDs are passed over without touching the filesystem.
      // The counter still advances so future allocations don't revisit them.
      if (skipIds?.has(id)) {
        next++;
        continue;
      }
      const outPath = join(entityDir, `${id}.md`);
      const content = await contentBuilder(id);
      try {
        const fd = await open(outPath, 'wx');
        await fd.writeFile(content, 'utf8');
        await fd.close();
        await writeNext(opRoot, kind, next + 1);
        return { id, outPath };
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'EEXIST') throw cause;
        next++;
      }
    }
  });
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
