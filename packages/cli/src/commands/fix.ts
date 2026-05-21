import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  canonicalJson,
  generateRegistry,
  listMarkdownFiles,
  loadConfig,
  loadProject,
  parseMarkdown,
  RegistrySchema,
  RepoKernelError,
  runValidators,
} from '@repokernel/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { isWorkingTreeClean } from '../lifecycle/git.js';
import { withLockRetrying } from '../lifecycle/locks.js';
import { removeSlotFromQueue } from '../lifecycle/mutate.js';
import {
  findLeakedEpicWorktrees,
  findLeakedSprintWorktrees,
  listWorktrees,
  pruneWorktreeRecordByPath,
  removeLeakedWorktreeIfClean,
} from '../lifecycle/worktree.js';
import { RK_GENERATED_BY } from '../version.js';
import type { CommandResult } from './validate.js';

export interface FixCommandOptions {
  readonly cwd: string;
  readonly preview: boolean;
  readonly apply: boolean;
  readonly yes: boolean;
  readonly json?: boolean;
  readonly baseSha?: string;
  readonly sprint?: string;
  readonly dryRun?: boolean;
}

type SafeFixAction =
  | { readonly kind: 'mkdir'; readonly dir: string }
  | {
      readonly kind: 'regenerate-registry';
      readonly path: string;
      readonly projectCwd: string;
    }
  | { readonly kind: 'create-default-queue'; readonly path: string; readonly lane: string }
  | { readonly kind: 'init'; readonly cwd: string }
  | {
      readonly kind: 'strip-deprecated-config-field';
      readonly configPath: string;
      readonly fieldPath: readonly string[];
    }
  | {
      readonly kind: 'renumber-duplicate-review';
      readonly projectCwd: string;
      readonly duplicateId: string;
      readonly duplicateFile: string;
      readonly reviewsDir: string;
    }
  | {
      readonly kind: 'set-shipped-base-sha';
      readonly projectCwd: string;
      readonly sprintFile: string;
      readonly sprintId: string;
      readonly baseSha: string;
      readonly source: 'run-state' | 'review' | 'flag';
    }
  | {
      readonly kind: 'remove-sprint-from-queue';
      readonly projectCwd: string;
      readonly queueFile: string;
      readonly sprintId: string;
      readonly lane?: string;
      readonly reason: 'shipped' | 'cancelled';
    }
  | {
      readonly kind: 'prune-leaked-worktree-record';
      readonly projectCwd: string;
      readonly worktreePath: string;
    }
  | {
      readonly kind: 'remove-clean-leaked-worktree';
      readonly projectCwd: string;
      readonly worktreePath: string;
    };

interface SafeFix {
  readonly title: string;
  readonly detail: string;
  readonly action?: SafeFixAction;
}

interface FixPreview {
  readonly safeFixes: readonly SafeFix[];
  readonly manualSuggestions: readonly SafeFix[];
}

export async function runFixCommand(opts: FixCommandOptions): Promise<CommandResult> {
  if (opts.apply && opts.preview) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel fix: --preview and --apply are mutually exclusive\n',
    };
  }
  if (opts.dryRun && !opts.apply) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel fix: --dry-run requires --apply\n',
    };
  }
  if (!opts.preview && !opts.apply) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel fix: pass --preview or --apply\n',
    };
  }

  const preview = await collectFixPreview(opts.cwd, {
    ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
    ...(opts.sprint !== undefined ? { sprint: opts.sprint } : {}),
  });

  if (opts.preview) {
    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${emitJson({ schemaVersion: 1, ...preview })}\n`,
        stderr: '',
      };
    }

    const lines = ['Available safe fixes:', ''];
    if (preview.safeFixes.length === 0) {
      lines.push('No safe mechanical fixes found.');
    } else {
      preview.safeFixes.forEach((fix, index) => {
        lines.push(`${index + 1}. ${fix.title}`);
        lines.push(`   ${fix.detail}`);
        if (index !== preview.safeFixes.length - 1) lines.push('');
      });
    }

    if (preview.manualSuggestions.length > 0) {
      lines.push('', 'Manual suggestions:', '');
      preview.manualSuggestions.forEach((suggestion, index) => {
        lines.push(`${index + 1}. ${suggestion.title}`);
        lines.push(`   ${suggestion.detail}`);
        if (index !== preview.manualSuggestions.length - 1) lines.push('');
      });
    }
    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }

  // --apply path
  const applicable = preview.safeFixes.filter((f) => f.action !== undefined);
  if (applicable.length === 0) {
    return {
      exitCode: EXIT_OK,
      stdout: 'No applicable safe fixes.\n',
      stderr: '',
    };
  }

  if (opts.dryRun) {
    const wouldApply = applicable.map((f) => ({
      // f.action is non-undefined here because of the filter above.
      kind: f.action?.kind ?? 'unknown',
      title: f.title,
      detail: f.detail,
    }));
    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${emitJson({ schemaVersion: 1, dryRun: true, wouldApply })}\n`,
        stderr: '',
      };
    }
    const lines = [
      `Would apply ${wouldApply.length} fix${wouldApply.length === 1 ? '' : 'es'}:`,
      '',
    ];
    wouldApply.forEach((w, index) => {
      lines.push(`${index + 1}. ${w.title} [${w.kind}]`);
      lines.push(`   ${w.detail}`);
      if (index !== wouldApply.length - 1) lines.push('');
    });
    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }

  if (!opts.yes) {
    // Non-interactive callers (CI, agents, `yes | rk fix --apply`) must be
    // explicit. Reading piped stdin as a y/n answer is unsafe — require --yes.
    if (!process.stdin.isTTY) {
      return {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: 'rk fix --apply requires --yes when stdin is not a TTY (CI, agents, piped stdin)\n',
      };
    }
    const confirmed = await confirmApply(applicable);
    if (!confirmed) {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr: 'aborted (no changes applied) — pass --yes to apply non-interactively\n',
      };
    }
  }

  const applied: string[] = [];
  const failed: { title: string; reason: string }[] = [];
  for (const fix of applicable) {
    if (!fix.action) continue;
    try {
      await applySafeFix(fix.action);
      applied.push(fix.title);
    } catch (cause) {
      failed.push({ title: fix.title, reason: (cause as Error).message });
    }
  }

  if (opts.json) {
    return {
      exitCode: failed.length > 0 ? EXIT_RUNTIME : EXIT_OK,
      stdout: `${emitJson({ schemaVersion: 1, applied, failed })}\n`,
      stderr: '',
    };
  }

  const lines: string[] = [];
  if (applied.length > 0) {
    lines.push(`Applied ${applied.length} fix${applied.length === 1 ? '' : 'es'}:`);
    for (const title of applied) lines.push(`  ${title}`);
  }
  if (failed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Failed ${failed.length} fix${failed.length === 1 ? '' : 'es'}:`);
    for (const f of failed) lines.push(`  ${f.title} — ${f.reason}`);
  }
  return {
    exitCode: failed.length > 0 ? EXIT_RUNTIME : EXIT_OK,
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
  };
}

async function confirmApply(fixes: readonly SafeFix[]): Promise<boolean> {
  process.stdout.write(`About to apply ${fixes.length} fix${fixes.length === 1 ? '' : 'es'}:\n`);
  for (const fix of fixes) process.stdout.write(`  - ${fix.title}\n`);
  process.stdout.write('Proceed? [y/N] ');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return new Promise<boolean>((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    });
    rl.once('close', () => resolve(false));
  });
}

async function applySafeFix(action: SafeFixAction): Promise<void> {
  switch (action.kind) {
    case 'mkdir':
      await mkdir(action.dir, { recursive: true });
      return;
    case 'regenerate-registry':
      await regenerateRegistry(action.path, action.projectCwd);
      return;
    case 'create-default-queue':
      await createDefaultQueue(action.path, action.lane);
      return;
    case 'init':
      throw new Error(`run repokernel init from ${action.cwd} (apply does not init projects)`);
    case 'strip-deprecated-config-field':
      await stripDeprecatedConfigField(action.configPath, action.fieldPath);
      return;
    case 'renumber-duplicate-review':
      await renumberDuplicateReview(action);
      return;
    case 'set-shipped-base-sha':
      await setShippedBaseSha(action);
      return;
    case 'remove-sprint-from-queue':
      await removeSprintFromQueueAction(action);
      return;
    case 'prune-leaked-worktree-record':
      await pruneWorktreeRecordByPath(action.projectCwd, action.worktreePath);
      return;
    case 'remove-clean-leaked-worktree':
      await removeLeakedWorktreeIfClean(action.projectCwd, action.worktreePath);
      return;
  }
}

async function removeSprintFromQueueAction(action: {
  readonly projectCwd: string;
  readonly queueFile: string;
  readonly sprintId: string;
  readonly lane?: string;
}): Promise<void> {
  const queueAbs = action.queueFile.startsWith('/')
    ? action.queueFile
    : join(action.projectCwd, action.queueFile);
  const lane = action.lane ?? basename(action.queueFile, '.md');
  const opRoot = await operationalRootBestEffort(action.projectCwd);
  await removeSlotFromQueue(queueAbs, action.sprintId, opRoot, lane);
}

async function collectDuplicateReviewFixes(args: {
  readonly cwd: string;
  readonly reviewsDir: string;
  readonly reviewsDirAbs: string;
  readonly renumberedDuplicates: Set<string>;
}): Promise<SafeFix[]> {
  const byId = new Map<string, string[]>();
  const files = await listMarkdownFiles(args.cwd, join(args.cwd, args.reviewsDir));
  for (const file of files) {
    const text = await readFile(join(args.cwd, file), 'utf8').catch(() => null);
    if (text === null) continue;
    const parsed = parseMarkdown(text);
    if (!parsed.ok) continue;
    const id = parsed.parsed.data.id;
    if (typeof id !== 'string' || !/^R-\d+$/.test(id)) continue;
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }

  const fixes: SafeFix[] = [];
  for (const [duplicateId, filesForId] of byId) {
    if (filesForId.length < 2) continue;
    for (const duplicateFile of filesForId.slice(1)) {
      const key = `${duplicateId}::${duplicateFile}`;
      if (args.renumberedDuplicates.has(key)) continue;
      args.renumberedDuplicates.add(key);
      fixes.push({
        title: `Renumber duplicate review id ${duplicateId}`,
        detail: `${duplicateId} appears in ${duplicateFile} — renumber to next free R-NNN`,
        action: {
          kind: 'renumber-duplicate-review',
          projectCwd: args.cwd,
          duplicateId,
          duplicateFile,
          reviewsDir: args.reviewsDirAbs,
        },
      });
    }
  }
  return fixes;
}

async function findReliableBaseSha(
  projectCwd: string,
  sprintId: string,
  outcome: {
    graph: { reviews: ReadonlyMap<string, { sprint_id: string; base_sha?: string | undefined }> };
  },
  collectOpts: CollectOpts,
): Promise<{ baseSha: string; source: 'run-state' | 'review' | 'flag' } | null> {
  // Source 3: explicit operator flag.
  if (collectOpts.baseSha && collectOpts.sprint && collectOpts.sprint === sprintId) {
    return { baseSha: collectOpts.baseSha, source: 'flag' };
  }

  // Source 2: linked review's base_sha.
  for (const review of outcome.graph.reviews.values()) {
    if (review.sprint_id === sprintId && review.base_sha) {
      return { baseSha: review.base_sha, source: 'review' };
    }
  }

  // Source 1: run state start_sha (if a run record names this sprint).
  try {
    const { commonGitDir } = await import('../lifecycle/controlPaths.js');
    const gitDir = await commonGitDir(projectCwd);
    const opRoot = join(gitDir, 'repokernel');
    const runsDir = join(opRoot, 'runs');
    const { readdir } = await import('node:fs/promises');
    const runFiles = await readdir(runsDir).catch(() => [] as string[]);
    for (const f of runFiles) {
      if (!/^RUN-\d+\.json$/.test(f)) continue;
      const text = await readFile(join(runsDir, f), 'utf8').catch(() => '');
      if (!text) continue;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const completed = (data as { completed_sprints?: unknown }).completed_sprints;
      if (!Array.isArray(completed)) continue;
      for (const entry of completed) {
        const e = entry as Record<string, unknown>;
        if (e.sprint_id === sprintId && typeof e.start_sha === 'string') {
          return { baseSha: e.start_sha, source: 'run-state' };
        }
      }
    }
  } catch {
    // run state not available — fall through
  }

  return null;
}

async function setShippedBaseSha(action: {
  readonly projectCwd: string;
  readonly sprintFile: string;
  readonly sprintId: string;
  readonly baseSha: string;
}): Promise<void> {
  const opRoot = await operationalRootBestEffort(action.projectCwd);
  // Serialize the sprint .md read-modify-write against concurrent rk processes.
  await withLockRetrying(`sprint-${action.sprintId}`, opRoot, async () => {
    const matter = (await import('gray-matter')).default;
    const sprintAbs = action.sprintFile.startsWith('/')
      ? action.sprintFile
      : join(action.projectCwd, action.sprintFile);
    const text = await readFile(sprintAbs, 'utf8');
    const parsed = matter(text);
    parsed.data.base_sha = action.baseSha;
    await writeFile(sprintAbs, matter.stringify(parsed.content, parsed.data), 'utf8');
  });
}

async function renumberDuplicateReview(action: {
  readonly projectCwd: string;
  readonly duplicateId: string;
  readonly duplicateFile: string;
  readonly reviewsDir: string;
}): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(action.reviewsDir).catch(() => [] as string[]);
  const re = /^R-(\d+)(?:-.+)?\.md$/;
  let max = 0;
  for (const f of files) {
    const m = re.exec(f);
    if (m?.[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  const newId = `R-${String(max + 1).padStart(3, '0')}`;
  const oldAbs = action.duplicateFile.startsWith('/')
    ? action.duplicateFile
    : join(action.projectCwd, action.duplicateFile);
  const newAbs = join(action.reviewsDir, `${newId}.md`);
  // Read, mutate the id field, write to new path, remove old.
  const text = await readFile(oldAbs, 'utf8');
  const matter = (await import('gray-matter')).default;
  const parsed = matter(text);
  const sprintId = (parsed.data as Record<string, unknown>).sprint_id;
  parsed.data.id = newId;
  await writeFile(newAbs, matter.stringify(parsed.content, parsed.data), 'utf8');
  const { unlink } = await import('node:fs/promises');
  await unlink(oldAbs);
  // Update the linked sprint's review_id back-reference, if found.
  if (typeof sprintId === 'string') {
    const outcome = await loadProject({ cwd: action.projectCwd });
    if (outcome.ok) {
      const sprint = outcome.graph.sprints.get(sprintId);
      if (sprint && sprint.review_id === action.duplicateId) {
        const sprintAbs = join(action.projectCwd, sprint.file);
        const sprintText = await readFile(sprintAbs, 'utf8');
        const sprintMatter = matter(sprintText);
        sprintMatter.data.review_id = newId;
        await writeFile(
          sprintAbs,
          matter.stringify(sprintMatter.content, sprintMatter.data),
          'utf8',
        );
      }
    }
  }
}

async function regenerateRegistry(registryPath: string, projectCwd: string): Promise<void> {
  // Back up an existing registry that doesn't parse, before overwriting.
  if (await exists(registryPath)) {
    try {
      const raw = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
      if (!RegistrySchema.safeParse(raw).success) {
        await rename(registryPath, `${registryPath}.bak`);
      }
    } catch {
      await rename(registryPath, `${registryPath}.bak`);
    }
  }
  const outcome = await loadProject({ cwd: projectCwd });
  if (!outcome.ok) {
    throw new Error('cannot regenerate registry: project failed to load');
  }
  const findings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
  });
  const registry = generateRegistry({
    graph: outcome.graph,
    config: outcome.config,
    findings,
    generatedBy: RK_GENERATED_BY,
  });
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, canonicalJson(registry), 'utf8');
}

async function createDefaultQueue(queuePath: string, lane: string): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  const body = `---\nlane: ${lane}\nslots: []\n---\n\n# ${lane} queue\n`;
  await writeFile(queuePath, body, 'utf8');
}

async function stripDeprecatedConfigField(
  configPath: string,
  fieldPath: readonly string[],
): Promise<void> {
  if (fieldPath.length === 0) return;
  const text = await readFile(configPath, 'utf8');
  const data = parseYaml(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  let parent: Record<string, unknown> = data as Record<string, unknown>;
  for (let i = 0; i < fieldPath.length - 1; i++) {
    const segment = fieldPath[i];
    if (segment === undefined) return;
    const next = parent[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
    parent = next as Record<string, unknown>;
  }
  const leaf = fieldPath[fieldPath.length - 1];
  if (leaf === undefined) return;
  delete parent[leaf];
  await writeFile(configPath, stringifyYaml(data), 'utf8');
}

interface CollectOpts {
  readonly baseSha?: string;
  readonly sprint?: string;
}

async function collectFixPreview(
  startCwd: string,
  collectOpts: CollectOpts = {},
): Promise<FixPreview> {
  const safeFixes: SafeFix[] = [];
  const manualSuggestions: SafeFix[] = [];
  const config = await loadConfig({ cwd: startCwd }).catch((cause) => {
    if (cause instanceof RepoKernelError && cause.kind === 'CONFIG_FILE_NOT_FOUND') return null;
    throw cause;
  });

  if (config === null) {
    return {
      safeFixes: [
        {
          title: 'Create RepoKernel config and folders',
          detail: 'repokernel init',
          action: { kind: 'init', cwd: startCwd },
        },
      ],
      manualSuggestions,
    };
  }
  if (!config.ok) {
    return { safeFixes, manualSuggestions };
  }

  const cwd = config.cwd;
  for (const dir of [
    config.config.paths.epics,
    config.config.paths.sprints,
    config.config.paths.reviews,
    config.config.paths.queues,
    config.config.paths.lanes,
    dirname(config.config.paths.registry),
  ]) {
    if (!(await exists(join(cwd, dir)))) {
      safeFixes.push({
        title: `Create missing directory`,
        detail: dir,
        action: { kind: 'mkdir', dir: join(cwd, dir) },
      });
    }
  }

  const registryPath = join(cwd, config.config.paths.registry);
  if (!(await exists(registryPath))) {
    safeFixes.push({
      title: 'Generate missing registry',
      detail: 'repokernel registry --write',
      action: { kind: 'regenerate-registry', path: registryPath, projectCwd: cwd },
    });
  } else {
    try {
      const raw = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
      if (!RegistrySchema.safeParse(raw).success) {
        safeFixes.push({
          title: 'Regenerate invalid registry',
          detail: 'repokernel registry --write',
          action: { kind: 'regenerate-registry', path: registryPath, projectCwd: cwd },
        });
      }
    } catch {
      safeFixes.push({
        title: 'Regenerate invalid registry',
        detail: 'repokernel registry --write',
        action: { kind: 'regenerate-registry', path: registryPath, projectCwd: cwd },
      });
    }
  }

  const defaultLane = config.config.policies.defaultLane;
  const defaultQueue = join(config.config.paths.queues, `${defaultLane}.md`);
  if (!(await exists(join(cwd, defaultQueue)))) {
    safeFixes.push({
      title: `Create missing queue file for lane ${defaultLane}`,
      detail: defaultQueue,
      action: {
        kind: 'create-default-queue',
        path: join(cwd, defaultQueue),
        lane: defaultLane,
      },
    });
  }

  for (const warning of config.warnings) {
    if (warning.code === 'DEPRECATED_FIELD' && warning.file) {
      const fieldPath = (warning.data?.path as readonly string[] | undefined) ?? [];
      const dotted = fieldPath.join('.');
      safeFixes.push({
        title: `Strip deprecated config field "${dotted}"`,
        detail: warning.message,
        action: {
          kind: 'strip-deprecated-config-field',
          configPath: warning.file,
          fieldPath,
        },
      });
    }
  }

  const reviewsDirAbs = join(cwd, config.config.paths.reviews);
  const renumberedDuplicates = new Set<string>();
  safeFixes.push(
    ...(await collectDuplicateReviewFixes({
      cwd,
      reviewsDir: config.config.paths.reviews,
      reviewsDirAbs,
      renumberedDuplicates,
    })),
  );

  const outcome = await loadProject({ cwd });
  if (outcome.ok) {
    // CLI-only operational findings — leaked sprint and epic worktrees recorded
    // in worktrees.json that no longer correspond to active entities. Mirrors
    // the layering done in validate.ts; the core validator can't see
    // worktrees.json (it lives outside the project tree).
    try {
      const activeSprintIds = new Set(
        [...outcome.parsed.sprints]
          .filter((s) => s.status !== 'shipped' && s.status !== 'cancelled')
          .map((s) => s.id),
      );
      const activeEpicIds = new Set(
        [...outcome.parsed.epics]
          .filter((e) => e.status !== 'done' && e.status !== 'cancelled')
          .map((e) => e.id),
      );
      const leaked = [
        ...(await findLeakedSprintWorktrees(activeSprintIds, cwd)),
        ...(await findLeakedEpicWorktrees(activeEpicIds, cwd)),
      ];
      // `git worktree remove` only acts on registered worktrees. Any other
      // path that happens to live inside the repo (a stray dir, a leftover
      // build output) would otherwise pass `isWorkingTreeClean` because git
      // auto-discovers the parent .git — guard against that misclassification.
      // Canonicalize both sides via realpath: git records resolved paths, and
      // tmpdir on macOS lives behind a /var→/private/var symlink.
      const canonicalize = (p: string) => realpath(p).catch(() => resolve(p));
      const listed = await listWorktrees(cwd).catch(() => []);
      const registeredWorktreePaths = new Set(
        await Promise.all(listed.map((w) => canonicalize(w.path))),
      );
      for (const finding of leaked) {
        const rawPath = finding.data?.path;
        if (typeof rawPath !== 'string') continue;
        const onDisk = await exists(rawPath);
        const ref = finding.entityId ?? '?';
        if (!onDisk) {
          // Ghost record: directory already gone. Safe to drop the entry.
          safeFixes.push({
            title: `Prune ghost worktree record for ${ref}`,
            detail: `${rawPath} (no longer on disk) — record-only cleanup`,
            action: {
              kind: 'prune-leaked-worktree-record',
              projectCwd: cwd,
              worktreePath: rawPath,
            },
          });
        } else {
          // Path exists. Auto-remove only when the tree is a registered git
          // worktree AND clean — `git worktree remove` (no --force) is then
          // non-destructive. Dirty trees stay manual: --force would silently
          // drop untracked or uncommitted work.
          const canonicalRawPath = await canonicalize(rawPath);
          const isRegisteredWorktree = registeredWorktreePaths.has(canonicalRawPath);
          const clean =
            isRegisteredWorktree && (await isWorkingTreeClean(rawPath).catch(() => false));
          if (clean) {
            safeFixes.push({
              title: `Remove clean leaked worktree for ${ref}`,
              detail: `${rawPath} (no uncommitted/untracked changes) — git worktree remove + record prune`,
              action: {
                kind: 'remove-clean-leaked-worktree',
                projectCwd: cwd,
                worktreePath: rawPath,
              },
            });
          } else {
            const rawBranch = finding.data?.branch;
            const branch = typeof rawBranch === 'string' ? rawBranch : '<branch>';
            manualSuggestions.push({
              title: `Remove leaked worktree for ${ref}`,
              detail:
                `git worktree remove "${rawPath}"  ` +
                `(or --force to discard untracked changes; branch: ${branch}). ` +
                `After removal, run \`rk fix --apply\` to scrub the worktrees.json record.`,
            });
          }
        }
      }
    } catch {
      // worktrees.json unreadable / missing — no-op.
    }

    // `rk fix` collects fix actions across both live and audit scopes — its job
    // is to repair any fixable problem, including historical-hygiene ones like
    // SHIPPED_SPRINT_MISSING_BASE_SHA. Scope-tagging exists to keep validate /
    // report quiet, not to limit what fix can act on.
    const findings = runValidators({
      graph: outcome.graph,
      config: outcome.config,
      parsed: outcome.parsed,
      parseFindings: outcome.parsed.findings,
      scope: 'all',
    });
    for (const finding of findings) {
      if (
        (finding.code === 'SHIPPED_SPRINT_IN_QUEUE' ||
          finding.code === 'CANCELLED_SPRINT_IN_QUEUE') &&
        finding.file &&
        finding.entityId
      ) {
        const reason = finding.code === 'SHIPPED_SPRINT_IN_QUEUE' ? 'shipped' : 'cancelled';
        const lane = typeof finding.data?.lane === 'string' ? finding.data.lane : undefined;
        const action: SafeFixAction = {
          kind: 'remove-sprint-from-queue',
          projectCwd: cwd,
          queueFile: finding.file,
          sprintId: finding.entityId,
          ...(lane ? { lane } : {}),
          reason,
        };
        safeFixes.push({
          title: `Remove ${finding.entityId} from queue`,
          detail: `${finding.entityId} (${reason}) from ${finding.file}`,
          action,
        });
        continue;
      }
      if (finding.code === 'SHIPPED_SPRINT_MISSING_BASE_SHA' && finding.entityId && finding.file) {
        const sprintId = finding.entityId;
        const reliable = await findReliableBaseSha(cwd, sprintId, outcome, collectOpts);
        if (reliable) {
          safeFixes.push({
            title: `Set base_sha on shipped sprint ${sprintId} (source: ${reliable.source})`,
            detail: `${sprintId} → base_sha=${reliable.baseSha}`,
            action: {
              kind: 'set-shipped-base-sha',
              projectCwd: cwd,
              sprintFile: finding.file,
              sprintId,
              baseSha: reliable.baseSha,
              source: reliable.source,
            },
          });
        } else {
          manualSuggestions.push({
            title: `Set base_sha on shipped sprint ${sprintId} (manual)`,
            detail:
              `no reliable source: pass --base-sha <sha> --sprint ${sprintId}, or restore run state ` +
              'start_sha / linked review base_sha. No SHA will be guessed.',
          });
        }
      }
    }
  }

  return { safeFixes, manualSuggestions };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw cause;
  }
}
