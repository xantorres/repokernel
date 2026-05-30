import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type ImportPlan, ImportPlanSchema, loadProject } from '@repokernel/core';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { formatId, readOrSeedCounter, writeNext } from '../lifecycle/counters.js';
import { ambientJournalAtomicCreate } from '../lifecycle/journal.js';
import { withLockRetrying } from '../lifecycle/locks.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import { epicTemplate, sprintTemplate } from './create.js';
import type { CommandResult } from './validate.js';

export interface ImportCommandOptions {
  readonly cwd: string;
  readonly file: string;
  readonly dryRun?: boolean;
  readonly skipExisting?: boolean;
  readonly json?: boolean;
}

type PlanEpic = ImportPlan['epics'][number];
type PlanSprint = PlanEpic['sprints'][number];

interface BuiltSprint {
  readonly id: string;
  readonly epicId: string;
  readonly title: string;
  readonly content: string;
}

interface BuiltEpic {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly sprints: BuiltSprint[];
}

const SPRINT_ID_RE = /^S-\d+$/;

export async function runImportCommand(opts: ImportCommandOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  // 1. Read + parse + schema-validate the plan.
  let rawText: string;
  try {
    rawText = await readFile(resolve(cwd, opts.file), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return usage(`import file not found: ${opts.file}`);
    }
    throw cause;
  }
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawText, { strict: true, maxAliasCount: 100 });
  } catch (cause) {
    return usage(`could not parse ${opts.file} as YAML: ${(cause as Error).message}`);
  }
  const parsed = ImportPlanSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return usage(`invalid import plan: ${detail}`);
  }
  const plan = parsed.data;

  const dupError = collectAliasErrors(plan);
  if (dupError) return blocked(dupError);

  // 2. Load the project for skip-existing matching and existing-id resolution.
  const outcome = await loadProject({ cwd });
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
    };
  }
  const { graph, config } = outcome;

  const epicTitleToId = new Map<string, string>();
  for (const epic of graph.epics.values()) epicTitleToId.set(epic.title, epic.id);
  const sprintTitleToId = new Map<string, string>();
  for (const sprint of graph.sprints.values()) sprintTitleToId.set(sprint.title, sprint.id);

  // 3. Skip epics whose title already exists (--skip-existing). Their sprint
  // aliases are mapped to the existing sprints by title so depends_on resolves.
  const aliasToId = new Map<string, string>();
  const epicsToCreate: PlanEpic[] = [];
  const skippedEpics: string[] = [];
  for (const epic of plan.epics) {
    const existing = opts.skipExisting ? epicTitleToId.get(epic.title) : undefined;
    if (existing !== undefined) {
      skippedEpics.push(epic.alias);
      for (const sprint of epic.sprints) {
        const sid = sprintTitleToId.get(sprint.title);
        if (sid !== undefined) aliasToId.set(sprint.alias, sid);
      }
      continue;
    }
    epicsToCreate.push(epic);
  }

  if (epicsToCreate.length === 0) {
    return ok(
      opts.json
        ? jsonEnvelope({
            created_epics: [],
            created_sprints: [],
            skipped_epics: skippedEpics,
            dry_run: opts.dryRun === true,
          })
        : 'Nothing to import — every epic already exists (--skip-existing).\n',
    );
  }

  // 4. Validate every depends_on before touching disk: it must point at a sprint
  // created in this plan, a skipped sprint that exists, or an existing S-NNN.
  const createdSprintAliases = new Set<string>();
  for (const epic of epicsToCreate) for (const s of epic.sprints) createdSprintAliases.add(s.alias);
  const depError = validateDependencies(epicsToCreate, createdSprintAliases, aliasToId, graph);
  if (depError) return blocked(depError);

  const epicsDir = join(cwd, config.paths.epics);
  const sprintsDir = join(cwd, config.paths.sprints);
  const skipSprintIds = new Set<string>(config.policies.skippedSprintIds);

  // 5a. Dry run: peek the counters (no reservation, no writes) and report.
  if (opts.dryRun) {
    const opRoot = await operationalRootBestEffort(cwd);
    const epicStart = await readOrSeedCounter(opRoot, 'epic', epicsDir);
    const sprintStart = await readOrSeedCounter(opRoot, 'sprint', sprintsDir);
    const built = build(
      epicsToCreate,
      epicStart,
      sprintStart,
      epicsDir,
      sprintsDir,
      skipSprintIds,
      new Map(aliasToId),
    ).built;
    return ok(renderDryRun(built, skippedEpics, opts.json === true));
  }

  // 5b. Real run: allocate + write under the id locks (so concurrent single
  // creates cannot collide), then refresh the registry exactly once.
  let built: BuiltEpic[] = [];
  await withLifecycleScope({ cwd, command: 'import', args: { file: opts.file } }, async (tx) => {
    await withLockRetrying('epic-id', tx.opRoot, async () => {
      await withLockRetrying('sprint-id', tx.opRoot, async () => {
        const epicStart = await readOrSeedCounter(tx.opRoot, 'epic', epicsDir);
        const sprintStart = await readOrSeedCounter(tx.opRoot, 'sprint', sprintsDir);
        const result = build(
          epicsToCreate,
          epicStart,
          sprintStart,
          epicsDir,
          sprintsDir,
          skipSprintIds,
          new Map(aliasToId),
        );
        built = result.built;
        await mkdir(epicsDir, { recursive: true });
        await mkdir(sprintsDir, { recursive: true });
        for (const epic of built) {
          for (const sprint of epic.sprints) {
            await ambientJournalAtomicCreate(join(sprintsDir, `${sprint.id}.md`), sprint.content);
          }
          await ambientJournalAtomicCreate(join(epicsDir, `${epic.id}.md`), epic.content);
        }
        await writeNext(tx.opRoot, 'epic', result.epicNext);
        await writeNext(tx.opRoot, 'sprint', result.sprintNext);
      });
    });
    await tx.refreshRegistry();
  });

  const createdSprints = built.flatMap((e) => e.sprints);
  return ok(
    opts.json
      ? jsonEnvelope({
          created_epics: built.map((e) => e.id),
          created_sprints: createdSprints.map((s) => s.id),
          skipped_epics: skippedEpics,
          dry_run: false,
        })
      : renderResult(built, createdSprints.length, skippedEpics),
  );
}

// — build (id allocation + content) —

interface BuildResult {
  readonly built: BuiltEpic[];
  readonly epicNext: number;
  readonly sprintNext: number;
}

function build(
  epics: readonly PlanEpic[],
  epicStart: number,
  sprintStart: number,
  epicsDir: string,
  sprintsDir: string,
  skipSprintIds: ReadonlySet<string>,
  aliasToId: Map<string, string>,
): BuildResult {
  // First pass: assign all ids so forward depends_on references resolve.
  let epicNum = epicStart;
  let sprintNum = sprintStart;
  const epicIds = new Map<string, string>();
  for (const epic of epics) {
    const next = nextFreeId('epic', epicNum, epicsDir, new Set());
    epicNum = next.next;
    epicIds.set(epic.alias, next.id);
  }
  for (const epic of epics) {
    for (const sprint of epic.sprints) {
      const next = nextFreeId('sprint', sprintNum, sprintsDir, skipSprintIds);
      sprintNum = next.next;
      aliasToId.set(sprint.alias, next.id);
    }
  }

  // Second pass: build file content with resolved ids.
  const built: BuiltEpic[] = epics.map((epic) => {
    const epicId = epicIds.get(epic.alias) as string;
    const sprints: BuiltSprint[] = epic.sprints.map((spec) => {
      const id = aliasToId.get(spec.alias) as string;
      const dependsOn = (spec.depends_on ?? []).map((dep) => aliasToId.get(dep) ?? dep);
      return { id, epicId, title: spec.title, content: sprintContent(id, epicId, spec, dependsOn) };
    });
    return {
      id: epicId,
      title: epic.title,
      content: epicContent(
        epicId,
        epic,
        sprints.map((s) => s.id),
      ),
      sprints,
    };
  });

  return { built, epicNext: epicNum, sprintNext: sprintNum };
}

function nextFreeId(
  kind: 'epic' | 'sprint',
  start: number,
  entityDir: string,
  skip: ReadonlySet<string>,
): { id: string; next: number } {
  let n = start;
  while (true) {
    const id = formatId(kind, n);
    n++;
    if (!skip.has(id) && !existsSync(join(entityDir, `${id}.md`))) return { id, next: n };
  }
}

function sprintContent(
  id: string,
  epicId: string,
  spec: PlanSprint,
  dependsOn: readonly string[],
): string {
  const base = sprintTemplate({
    id,
    title: spec.title,
    epicId,
    status: spec.status ?? 'planned',
    lane: spec.lane ?? 'main',
    dependsOn,
    allowedPaths: spec.allowed_paths ?? [],
    deniedPaths: spec.denied_paths ?? [],
    adrLinks: spec.adr_links ?? [],
    ...(spec.target_date !== undefined ? { targetDate: spec.target_date } : {}),
    ...(spec.body !== undefined ? { body: spec.body } : {}),
  });
  if (spec.extras === undefined) return base;
  const parsed = matter(base);
  parsed.data.extras = spec.extras;
  return matter.stringify(parsed.content, parsed.data);
}

function epicContent(id: string, spec: PlanEpic, sprintIds: readonly string[]): string {
  const base = epicTemplate(id, spec.title);
  const parsed = matter(base);
  parsed.data.sprints = sprintIds;
  if (spec.extras !== undefined) parsed.data.extras = spec.extras;
  return matter.stringify(parsed.content, parsed.data);
}

// — validation —

function collectAliasErrors(plan: ImportPlan): string | null {
  const epicAliases = new Set<string>();
  const sprintAliases = new Set<string>();
  for (const epic of plan.epics) {
    if (epicAliases.has(epic.alias)) return `duplicate epic alias: ${epic.alias}`;
    epicAliases.add(epic.alias);
    for (const sprint of epic.sprints) {
      if (sprintAliases.has(sprint.alias)) return `duplicate sprint alias: ${sprint.alias}`;
      sprintAliases.add(sprint.alias);
    }
  }
  return null;
}

function validateDependencies(
  epics: readonly PlanEpic[],
  createdAliases: ReadonlySet<string>,
  skippedAliasToId: ReadonlyMap<string, string>,
  graph: { sprints: ReadonlyMap<string, unknown> },
): string | null {
  for (const epic of epics) {
    for (const sprint of epic.sprints) {
      for (const dep of sprint.depends_on ?? []) {
        const resolvable =
          createdAliases.has(dep) ||
          skippedAliasToId.has(dep) ||
          (SPRINT_ID_RE.test(dep) && graph.sprints.has(dep));
        if (!resolvable) {
          return `sprint "${sprint.alias}" depends_on "${dep}", which is neither a plan alias nor an existing sprint id`;
        }
      }
    }
  }
  return null;
}

// — output —

function renderDryRun(epics: BuiltEpic[], skippedEpics: string[], json: boolean): string {
  if (json) {
    return jsonEnvelope({
      created_epics: epics.map((e) => e.id),
      created_sprints: epics.flatMap((e) => e.sprints.map((s) => s.id)),
      skipped_epics: skippedEpics,
      dry_run: true,
    });
  }
  const lines = [
    '',
    'Dry run — no files written. Allocated ids are advisory (a concurrent create may shift them).',
    '',
  ];
  for (const epic of epics) {
    lines.push(`${epic.id}  ${epic.title}`);
    for (const sprint of epic.sprints) lines.push(`  ${sprint.id}  ${sprint.title}`);
  }
  if (skippedEpics.length > 0)
    lines.push('', `Skipped (already exist): ${skippedEpics.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

function renderResult(epics: BuiltEpic[], sprintCount: number, skippedEpics: string[]): string {
  const lines = ['', `Imported ${epics.length} epic(s) and ${sprintCount} sprint(s).`, ''];
  for (const epic of epics) lines.push(`  ${epic.id}  ${epic.title}`);
  if (skippedEpics.length > 0)
    lines.push('', `Skipped (already exist): ${skippedEpics.join(', ')}`);
  lines.push('', 'Next: rk validate --fail-on P0,P1', '');
  return lines.join('\n');
}

interface ImportJsonPayload {
  readonly created_epics: string[];
  readonly created_sprints: string[];
  readonly skipped_epics: string[];
  readonly dry_run: boolean;
}

function jsonEnvelope(payload: ImportJsonPayload): string {
  return `${JSON.stringify({ kind: 'import', ...payload, next_actions: ['rk validate --fail-on P0,P1'] }, null, 2)}\n`;
}

function ok(stdout: string): CommandResult {
  return { exitCode: EXIT_OK, stdout, stderr: '' };
}

function usage(message: string): CommandResult {
  return { exitCode: EXIT_USAGE, stdout: '', stderr: `error: ${message}\n` };
}

function blocked(message: string): CommandResult {
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `error: ${message}\n` };
}
