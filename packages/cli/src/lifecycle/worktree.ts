import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { EpicId, SprintId } from '@repokernel/core';
import {
  type Config,
  epicBranchPatternFor,
  FINDING_CODES,
  type Finding,
  RepoKernelError,
  renderBranchPattern,
  sprintBranchPatternFor,
  toErrorMessage,
} from '@repokernel/core';
import { z } from 'zod';
import { atomicWriteText } from './atomicWrite.js';
import { operationalRoot } from './controlPaths.js';
import { isAncestor, isWorkingTreeClean } from './git.js';
import { git } from './gitExec.js';
import { withLockRetrying } from './locks.js';
import { terminateProcessesRootedIn } from './processes.js';

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly reused: boolean;
}

interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly bare: boolean;
}

export function worktreePath(epicId: EpicId, config: Config, controlCwd: string): string {
  const root = config.worktrees.root;
  const base = isAbsolute(root) ? root : resolve(controlCwd, root);
  // Namespace worktrees by repo basename + a short hash of the canonical repo
  // path. Basename alone collides when two checkouts share a name (e.g. two
  // repos both called "myapp"), letting their epic IDs cross-contaminate; the
  // path hash makes the namespace unique per checkout.
  const canonical = resolve(controlCwd);
  const repoBase = canonical.split('/').pop() || 'repo';
  const repoHash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  const repoName = `${repoBase}-${repoHash}`;
  return join(base, repoName, epicId);
}

export function worktreeBranch(epicId: EpicId, config: Config): string {
  return renderBranchPattern(epicBranchPatternFor(config.worktrees), {
    branchPrefix: config.worktrees.branchPrefix,
    epicId,
  });
}

export async function listWorktrees(controlCwd: string): Promise<WorktreeEntry[]> {
  try {
    const { stdout } = await git(['-C', controlCwd, 'worktree', 'list', '--porcelain']);
    return parseWorktreeList(stdout);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', 'could not list git worktrees', cause);
  }
}

function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.trim().split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.trim().split('\n');
    let path = '';
    let branch: string | null = null;
    let bare = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace('refs/heads/', '');
      else if (line === 'bare') bare = true;
    }
    if (path) entries.push({ path, branch, bare });
  }
  return entries;
}

async function branchExists(branch: string, controlCwd: string): Promise<boolean> {
  try {
    await git(['-C', controlCwd, 'rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function resolveBaseRef(baseBranch: string, controlCwd: string): Promise<string> {
  if (await branchExists(baseBranch, controlCwd)) return baseBranch;
  try {
    const { stdout } = await git(['-C', controlCwd, 'symbolic-ref', '--short', 'HEAD']);
    return stdout.trim();
  } catch {
    return baseBranch;
  }
}

export interface AcquireWorktreeOptions {
  readonly allowDirty?: boolean;
}

export async function acquireWorktree(
  epicId: EpicId,
  config: Config,
  controlCwd: string,
  options: AcquireWorktreeOptions = {},
): Promise<WorktreeInfo> {
  const path = worktreePath(epicId, config, controlCwd);
  const branch = worktreeBranch(epicId, config);
  const opRoot = await operationalRoot(controlCwd);

  if (!options.allowDirty) {
    const clean = await isWorkingTreeClean(controlCwd).catch(() => true);
    if (!clean) {
      throw new RepoKernelError(
        'WORKTREE_ACQUIRE_DIRTY_TREE',
        `cannot acquire worktree from a dirty main tree at ${controlCwd} — commit or stash uncommitted changes, or pass --allow-dirty to override`,
      );
    }
  }

  const existing = await listWorktrees(controlCwd);
  const registered = existing.find((w) => w.path === path);

  if (registered) {
    if (registered.branch !== branch) {
      throw new RepoKernelError(
        'IO_ERROR',
        `worktree at ${path} is on branch ${registered.branch ?? 'detached HEAD'}, expected ${branch} — release or migrate the existing worktree first`,
      );
    }
    await updateWorktreesJson(opRoot, { path, branch, epicId });
    return { path, branch, reused: true };
  }

  await mkdir(join(path, '..'), { recursive: true });

  const branchAlreadyExists = await branchExists(branch, controlCwd);

  try {
    if (branchAlreadyExists) {
      await git(['-C', controlCwd, 'worktree', 'add', path, branch]);
    } else {
      const baseRef = await resolveBaseRef(config.worktrees.baseBranch, controlCwd);
      await git(['-C', controlCwd, 'worktree', 'add', '-b', branch, path, baseRef]);
    }
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `could not create worktree at ${path} (branch: ${branch})`,
      cause,
    );
  }

  await updateWorktreesJson(opRoot, { path, branch, epicId });
  return { path, branch, reused: false };
}

export async function releaseWorktree(
  epicId: EpicId,
  config: Config,
  controlCwd: string,
  force = false,
): Promise<void> {
  const path = worktreePath(epicId, config, controlCwd);
  const opRoot = await operationalRoot(controlCwd);

  if (!force) {
    const clean = await isWorkingTreeClean(path).catch(() => true);
    if (!clean) {
      throw new RepoKernelError(
        'IO_ERROR',
        `worktree at ${path} has uncommitted changes — use --force to release anyway`,
      );
    }
  }

  // A build daemon or watcher left running in the worktree survives `git
  // worktree remove` (git doesn't touch live processes) and reparents,
  // burning CPU with its cwd pointing at a now-deleted directory.
  const sweep = terminateProcessesRootedIn(path);
  if (sweep.terminated + sweep.failed > 0) {
    console.warn(
      `rk: process sweep on ${path} — terminated ${sweep.terminated}, failed ${sweep.failed}`,
    );
  }

  try {
    const args = ['worktree', 'remove', path];
    if (force) args.push('--force');
    await git(['-C', controlCwd, ...args]);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not remove worktree at ${path}`, cause);
  }

  await removeFromWorktreesJson(opRoot, epicId);
}

// --- sprint-level worktrees ---

export function sprintWorktreePath(
  epicId: EpicId,
  sprintId: SprintId,
  config: Config,
  controlCwd: string,
): string {
  return join(worktreePath(epicId, config, controlCwd), '..', `${epicId}-sprints`, sprintId);
}

export function sprintWorktreeBranch(epicId: EpicId, sprintId: SprintId, config: Config): string {
  return renderBranchPattern(sprintBranchPatternFor(config.worktrees), {
    branchPrefix: config.worktrees.branchPrefix,
    epicId,
    sprintId,
  });
}

export interface SprintWorktreeInfo {
  readonly path: string;
  readonly branch: string;
}

/**
 * Create a git worktree for a sprint, branching from the epic worktree's current HEAD.
 * Sprint worktrees live beside the epic worktree — each parallel sprint gets isolation
 * without nesting one git checkout inside another.
 *
 * Branch naming: rk/sprint/E-001/S-003
 * Path: <worktrees.root>/<repo>/E-001-sprints/S-003
 */
export async function acquireSprintWorktree(
  epicId: EpicId,
  sprintId: SprintId,
  epicWorktreePath: string,
  config: Config,
  controlCwd: string,
): Promise<SprintWorktreeInfo> {
  const path = sprintWorktreePath(epicId, sprintId, config, controlCwd);
  const branch = sprintWorktreeBranch(epicId, sprintId, config);
  const opRoot = await operationalRoot(controlCwd);

  // Check if already registered (reuse)
  const existing = await listWorktrees(controlCwd);
  const registered = existing.find((w) => w.path === path);
  if (registered) {
    if (registered.branch !== branch) {
      throw new RepoKernelError(
        'IO_ERROR',
        `sprint worktree at ${path} is on branch ${registered.branch ?? 'detached HEAD'}, expected ${branch} — release or migrate the existing worktree first`,
      );
    }
    const clean = await isWorkingTreeClean(path).catch(() => false);
    if (!clean) {
      throw new RepoKernelError(
        'IO_ERROR',
        `sprint worktree at ${path} is dirty from a previous run — resolve manually or abort the run to clean up`,
      );
    }
    await updateWorktreesJson(opRoot, { path, branch, epicId, sprintId, type: 'sprint' });
    return { path, branch };
  }

  await mkdir(join(path, '..'), { recursive: true });

  const branchAlreadyExists = await branchExists(branch, controlCwd);

  try {
    if (branchAlreadyExists) {
      await git(['-C', controlCwd, 'worktree', 'add', path, branch]);
    } else {
      // Branch from epic worktree HEAD, not from baseBranch
      await git(['-C', epicWorktreePath, 'worktree', 'add', '-b', branch, path, 'HEAD']);
    }
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `could not create sprint worktree at ${path} (branch: ${branch})`,
      cause,
    );
  }

  await updateWorktreesJson(opRoot, { path, branch, epicId, sprintId, type: 'sprint' });
  return { path, branch };
}

/**
 * Acquire an isolated execution worktree for a single sprint.
 *
 * A sprint worktree branches from its epic worktree's HEAD, so the epic
 * worktree must exist first. This bundles the two-step acquisition
 * (epic worktree, then sprint worktree) into one call so every entry point —
 * `rk run` and `rk start` — acquires sprint isolation identically.
 */
export async function acquireSprintExecutionWorktree(
  epicId: EpicId,
  sprintId: SprintId,
  config: Config,
  controlCwd: string,
): Promise<SprintWorktreeInfo> {
  const epicInfo = await acquireWorktree(epicId, config, controlCwd);
  return acquireSprintWorktree(epicId, sprintId, epicInfo.path, config, controlCwd);
}

/**
 * Remove a sprint worktree after its branch has been merged into the epic branch.
 * Always uses --force since the sprint branch is expected to have merged commits.
 */
export async function releaseSprintWorktree(
  epicId: EpicId,
  sprintId: SprintId,
  config: Config,
  controlCwd: string,
): Promise<void> {
  const path = sprintWorktreePath(epicId, sprintId, config, controlCwd);
  const opRoot = await operationalRoot(controlCwd);

  const sweep = terminateProcessesRootedIn(path);
  if (sweep.terminated + sweep.failed > 0) {
    console.warn(
      `rk: process sweep on ${path} — terminated ${sweep.terminated}, failed ${sweep.failed}`,
    );
  }

  try {
    await git(['-C', controlCwd, 'worktree', 'remove', '--force', path]);
  } catch {
    // Ignore errors if worktree already removed
  }

  await removeSprintFromWorktreesJson(opRoot, epicId, sprintId);
}

// — worktrees.json registry —

const WorktreeRecordSchema = z.object({
  epicId: z.string(),
  path: z.string(),
  branch: z.string(),
  /** Distinguishes epic-level vs sprint-level worktrees. Defaults to 'epic'. */
  type: z.enum(['epic', 'sprint']).optional(),
  /** Only set for type='sprint'. */
  sprintId: z.string().optional(),
});
type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>;

const WorktreesJsonSchema = z.object({
  worktrees: z.array(WorktreeRecordSchema),
});
type WorktreesJson = z.infer<typeof WorktreesJsonSchema>;

function worktreesJsonPath(opRoot: string): string {
  return join(opRoot, 'worktrees.json');
}

/**
 * Read and parse worktrees.json. Returns `{ worktrees: [] }` ONLY when the
 * file is genuinely absent (ENOENT). Any other error — JSON syntax,
 * permission denied, IO failure — surfaces as a typed RepoKernelError so
 * callers (validate / doctor / recover) can present the corruption to the
 * operator rather than treating it as "no worktrees", which would hide a
 * lost record set behind a misleading empty default.
 */
async function readWorktreesJson(opRoot: string): Promise<WorktreesJson> {
  let raw: string;
  try {
    raw = await readFile(worktreesJsonPath(opRoot), 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { worktrees: [] };
    throw new RepoKernelError(
      'IO_ERROR',
      `failed to read worktrees.json at ${worktreesJsonPath(opRoot)}: ${toErrorMessage(cause)}`,
      cause,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `worktrees.json at ${worktreesJsonPath(opRoot)} is not valid JSON — run \`rk recover --preview\` to inspect, then \`rk recover --apply\` to rebuild from \`git worktree list\``,
      cause,
    );
  }
  // A torn write (crash mid-write) can leave syntactically valid JSON with the
  // wrong shape; validate so a malformed record set surfaces as corruption
  // rather than silently driving wrong worktree-lifecycle decisions.
  const parsed = WorktreesJsonSchema.safeParse(data);
  if (!parsed.success) {
    throw new RepoKernelError(
      'IO_ERROR',
      `worktrees.json at ${worktreesJsonPath(opRoot)} is malformed — run \`rk recover --preview\` to inspect, then \`rk recover --apply\` to rebuild from \`git worktree list\``,
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * Atomic write of worktrees.json. Delegates to the shared atomicWriteText
 * helper, which provides temp+rename atomicity (no partial writes
 * published, no half-old/half-new file at the target). It does NOT fsync
 * the file or parent directory — see atomicWrite.ts for the rationale.
 * Crash durability across a kernel-level crash is owned by `rk recover`
 * (PR6), not this write path.
 */
async function writeWorktreesJsonAtomic(opRoot: string, data: WorktreesJson): Promise<void> {
  const finalPath = worktreesJsonPath(opRoot);
  await atomicWriteText(finalPath, JSON.stringify(data, null, 2));
}

/**
 * Wrap a worktrees.json read-modify-write under a repo-level lock so
 * concurrent rk processes can't clobber each other's records. Pairs with
 * the atomic write above.
 */
async function withWorktreesJsonLock<T>(opRoot: string, fn: () => Promise<T>): Promise<T> {
  return withLockRetrying('worktrees-json', opRoot, fn, { deadlineMs: 5_000 });
}

async function updateWorktreesJson(
  opRoot: string,
  entry: {
    path: string;
    branch: string;
    epicId: string;
    sprintId?: string;
    type?: 'epic' | 'sprint';
  },
): Promise<void> {
  await mkdir(opRoot, { recursive: true });
  await withWorktreesJsonLock(opRoot, async () => {
    const data = await readWorktreesJson(opRoot);
    const isSprint = entry.type === 'sprint';
    const filtered = isSprint
      ? data.worktrees.filter((w) => !(w.epicId === entry.epicId && w.sprintId === entry.sprintId))
      : data.worktrees.filter((w) => w.epicId !== entry.epicId || w.type === 'sprint');
    let record: WorktreeRecord;
    if (isSprint) {
      const sprintId = entry.sprintId;
      if (sprintId === undefined) {
        throw new RepoKernelError('IO_ERROR', 'sprint worktree entry missing sprintId');
      }
      record = {
        epicId: entry.epicId,
        path: entry.path,
        branch: entry.branch,
        type: 'sprint',
        sprintId,
      };
    } else {
      record = { epicId: entry.epicId, path: entry.path, branch: entry.branch };
    }
    const updated: WorktreesJson = { worktrees: [...filtered, record] };
    await writeWorktreesJsonAtomic(opRoot, updated);
  });
}

async function removeFromWorktreesJson(opRoot: string, epicId: string): Promise<void> {
  await withWorktreesJsonLock(opRoot, async () => {
    const data = await readWorktreesJson(opRoot);
    const filtered = data.worktrees.filter((w) => w.epicId !== epicId || w.type === 'sprint');
    await writeWorktreesJsonAtomic(opRoot, { worktrees: filtered });
  });
}

async function removeSprintFromWorktreesJson(
  opRoot: string,
  epicId: string,
  sprintId: string,
): Promise<void> {
  await withWorktreesJsonLock(opRoot, async () => {
    const data = await readWorktreesJson(opRoot);
    const filtered = data.worktrees.filter(
      (w) => !(w.epicId === epicId && w.sprintId === sprintId),
    );
    await writeWorktreesJsonAtomic(opRoot, { worktrees: filtered });
  });
}

/**
 * Drop a single worktree record from worktrees.json by its on-disk path.
 *
 * Used by `rk fix --apply` to scrub ghost entries — records whose path no
 * longer exists on disk (typically because the directory was removed
 * out-of-band). This is record-only cleanup; it does not call
 * `git worktree remove` or touch the filesystem. For path-present cleanup the
 * user runs `git worktree remove [--force]` themselves and `rk fix` re-runs
 * to clear the now-ghost record.
 */
export async function pruneWorktreeRecordByPath(
  controlCwd: string,
  path: string,
): Promise<{ removed: boolean }> {
  const opRoot = await operationalRoot(controlCwd);
  let removed = false;
  await withWorktreesJsonLock(opRoot, async () => {
    const data = await readWorktreesJson(opRoot);
    const filtered = data.worktrees.filter((w) => w.path !== path);
    if (filtered.length !== data.worktrees.length) {
      removed = true;
      await writeWorktreesJsonAtomic(opRoot, { worktrees: filtered });
    }
  });
  return { removed };
}

/**
 * Auto-removal counterpart to `pruneWorktreeRecordByPath` for the case where
 * the worktree directory still exists on disk. Used by `rk fix --apply` for
 * the clean subset of leaked worktrees.
 *
 * Operates on the path stored in worktrees.json (not on a config-derived
 * path), since stale records may carry locations that no longer match the
 * current `worktrees.root` config. Refuses to act on dirty trees — git
 * worktree remove (no --force) is also defense-in-depth against races.
 */
export async function removeLeakedWorktreeIfClean(controlCwd: string, path: string): Promise<void> {
  const clean = await isWorkingTreeClean(path).catch(() => false);
  if (!clean) {
    throw new RepoKernelError(
      'IO_ERROR',
      `leaked worktree at ${path} has uncommitted/untracked changes — remove manually with \`git worktree remove --force\` and re-run \`rk fix --apply\``,
    );
  }
  const sweep = terminateProcessesRootedIn(path);
  if (sweep.terminated + sweep.failed > 0) {
    console.warn(
      `rk: process sweep on ${path} — terminated ${sweep.terminated}, failed ${sweep.failed}`,
    );
  }

  try {
    await git(['-C', controlCwd, 'worktree', 'remove', path]);
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `git refused to remove leaked worktree at ${path}`,
      cause,
    );
  }
  await pruneWorktreeRecordByPath(controlCwd, path);
}

// — merged branch sweep —

export interface SweepableBranch {
  readonly branch: string;
  readonly head: string;
}

/**
 * Worktree branches that are fully merged into the base and no longer back a
 * checked-out worktree.
 *
 * Releasing a worktree removes the directory and the record but leaves its
 * branch behind, so every completed epic and sprint deposits a ref that nothing
 * ever collects. Branches still attached to a worktree are excluded — git
 * refuses to delete those anyway, and listing them as candidates would be
 * misleading.
 *
 * Only branches under the configured prefix are considered. Adopting anything
 * else would let the sweep delete refs the project never created.
 */
export async function listMergedSweepableBranches(
  config: Config,
  controlCwd: string,
): Promise<SweepableBranch[]> {
  const prefix = config.worktrees.branchPrefix;
  const baseBranch = config.worktrees.baseBranch;
  const base = await resolveSweepBaseRef(baseBranch, controlCwd);

  // Every local branch, filtered in code rather than by a ref glob: git matches
  // ref patterns per path component, so `refs/heads/rk/*` silently skips
  // `rk/epic/E-001`, and the correct glob depends on whether the configured
  // prefix ends in a slash. A plain prefix test has neither problem.
  let listing: string;
  try {
    const { stdout } = await git([
      '-C',
      controlCwd,
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname)',
      'refs/heads/',
    ]);
    listing = stdout;
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', 'could not list worktree branches', cause);
  }

  // A failure here propagates rather than defaulting to an empty set: with no
  // attached branches known, every checked-out branch would list as sweepable
  // and the preview would lie about what --apply is going to remove.
  const worktrees = await listWorktrees(controlCwd);
  const attached = new Set(worktrees.flatMap((w) => (w.branch ? [w.branch] : [])));

  const candidates: SweepableBranch[] = [];
  for (const line of listing.split('\n')) {
    const [branch, head] = line.split('\t');
    if (!branch || !head) continue;
    if (!branchUnderPrefix(branch, prefix)) continue;
    if (attached.has(branch)) continue;
    // Exclude the base under both names. `base` is usually the remote-tracking
    // ref, so comparing against it alone lets a base branch that happens to sit
    // under the prefix (baseBranch `release/current`, prefix `release/`) fail
    // the test against `origin/release/current` and sweep itself away.
    if (branch === baseBranch || branch === base) continue;
    if (await isAncestor(controlCwd, branch, base)) {
      candidates.push({ branch, head });
    }
  }
  return candidates;
}

/**
 * Match the prefix on a path boundary instead of as a raw substring. The config
 * schema only checks that `branchPrefix` is a legal ref, not that it is
 * specific, so a short prefix like `r` would otherwise claim `release/*` and
 * `refactor/*` as rk's own and force-delete them.
 */
function branchUnderPrefix(branch: string, prefix: string): boolean {
  if (!branch.startsWith(prefix)) return false;
  return prefix.endsWith('/') || branch[prefix.length] === '/';
}

/**
 * Prefer the remote-tracking base over the local one: a local `main` can lag
 * behind what was actually merged, which would leave finished branches looking
 * unmerged and never sweep them.
 */
async function resolveSweepBaseRef(baseBranch: string, controlCwd: string): Promise<string> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      await git(['-C', controlCwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      // try the next candidate
    }
  }
  return baseBranch;
}

/**
 * Delete a worktree branch, re-checking first that it is still merged.
 *
 * `git branch -d` is unusable here: it measures the merge against HEAD rather
 * than against the base the sweep listed from, so it refuses branches that are
 * merged into the base whenever HEAD sits on a divergent branch. `-D` skips
 * git's check entirely, which makes the ancestry test below the only thing
 * standing between a stale candidate list and a lost branch — it is load
 * bearing, not defensive, and it measures against the ref the listing used.
 */
export async function deleteMergedBranch(
  branch: string,
  config: Config,
  controlCwd: string,
): Promise<void> {
  const base = await resolveSweepBaseRef(config.worktrees.baseBranch, controlCwd);
  // Re-checked here rather than trusted from the listing: this function force
  // deletes, so it owns its own refusal to remove the project's trunk.
  if (branch === config.worktrees.baseBranch || branch === base) {
    throw new RepoKernelError('IO_ERROR', `refusing to delete the base branch ${branch}`);
  }
  if (!(await isAncestor(controlCwd, branch, base))) {
    throw new RepoKernelError(
      'IO_ERROR',
      `branch ${branch} is no longer merged into ${base} — refusing to delete it`,
    );
  }
  try {
    await git(['-C', controlCwd, 'branch', '-D', branch]);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not delete branch ${branch}`, cause);
  }
}

// — worktree path resolution —

/**
 * Find the on-disk worktree path for a given sprint by consulting worktrees.json.
 * Returns null if no sprint-level worktree was registered for this sprint.
 */
export async function findSprintWorktreePath(
  sprintId: string,
  controlCwd: string,
): Promise<string | null> {
  try {
    const opRoot = await operationalRoot(controlCwd);
    const data = await readWorktreesJson(opRoot);
    const record = data.worktrees.find((w) => w.type === 'sprint' && w.sprintId === sprintId);
    return record?.path ?? null;
  } catch {
    return null;
  }
}

// — worktree leak detection —

/**
 * Check worktrees.json for sprint-level worktrees whose sprint is no longer active.
 * Called from CLI validate command (not the core validator — worktrees.json is CLI-only state).
 */
export async function findLeakedSprintWorktrees(
  activeSprintIds: ReadonlySet<string>,
  controlCwd: string,
): Promise<Finding[]> {
  const opRoot = await operationalRoot(controlCwd);
  const data = await readWorktreesJson(opRoot);
  const findings: Finding[] = [];

  for (const record of data.worktrees) {
    if (record.type !== 'sprint' || !record.sprintId) continue;
    if (activeSprintIds.has(record.sprintId)) continue;
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.SPRINT_WORKTREE_LEAKED,
      message: `sprint worktree at ${record.path} (branch ${record.branch}) exists but sprint ${record.sprintId} is not active`,
      entityType: 'sprint',
      entityId: record.sprintId,
      data: { path: record.path, branch: record.branch, epicId: record.epicId },
    });
  }

  return findings;
}

/**
 * Check worktrees.json for epic-level worktrees whose epic is closed,
 * cancelled, or no longer in the project. Mirrors findLeakedSprintWorktrees
 * for the epic side — ad-hoc tasks (`rk run -m`) and parallel runs both
 * register epic worktrees, and stale entries accumulate after discard /
 * cancel / close paths if cleanup misses one.
 */
export async function findLeakedEpicWorktrees(
  activeEpicIds: ReadonlySet<string>,
  controlCwd: string,
): Promise<Finding[]> {
  const opRoot = await operationalRoot(controlCwd);
  const data = await readWorktreesJson(opRoot);
  const findings: Finding[] = [];

  for (const record of data.worktrees) {
    if (record.type === 'sprint') continue;
    if (activeEpicIds.has(record.epicId)) continue;
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.SPRINT_WORKTREE_LEAKED,
      message: `epic worktree at ${record.path} (branch ${record.branch}) exists but epic ${record.epicId} is not active`,
      entityType: 'epic',
      entityId: record.epicId,
      data: { path: record.path, branch: record.branch, epicId: record.epicId },
    });
  }

  return findings;
}
