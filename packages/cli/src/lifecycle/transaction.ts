import { resolve } from 'node:path';
import { loadProject, RepoKernelError } from '@repokernel/core';
import { operationalRootBestEffort } from './controlPaths.js';
import { type JournalContext, withJournal } from './journal.js';
import { withLockRetrying } from './locks.js';
import { type RegistryReport, refreshRegistry } from './registry.js';

export interface LifecycleScopeInput {
  readonly cwd: string;
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

export type LoadedProject = Extract<Awaited<ReturnType<typeof loadProject>>, { ok: true }>;

export interface LifecycleScope {
  readonly cwd: string;
  readonly opRoot: string;
  readonly journal: JournalContext;
  reloadProject(): Promise<LoadedProject>;
  refreshRegistry(): Promise<RegistryReport>;
  /**
   * Run `fn` under an operational lock keyed by `resourceKey` (e.g.
   * `sprint-S-001`, `review-R-001`). Serializes a plan-state read-modify-write
   * across concurrent rk processes that share the same clone — operational
   * locks live under the git-common-dir, so they are visible across worktrees.
   */
  lockedMutate<T>(resourceKey: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Internal lifecycle scope wrapper.
 *
 * Despite the older name, this is NOT a database-style transaction: there is
 * no rollback, no snapshot, no compensation. It centralizes op-root
 * resolution and gives apply blocks one place to reload the project and
 * refresh the registry while nested lifecycle primitives piggy-back on the
 * same journal. If an apply block needs atomicity, it must use journal
 * snapshots or idempotent writes explicitly.
 */
export async function withLifecycleScope<T>(
  input: LifecycleScopeInput,
  fn: (scope: LifecycleScope) => Promise<T>,
): Promise<T> {
  const cwd = resolve(input.cwd);
  const opRoot = await operationalRootBestEffort(cwd);
  return withJournal(opRoot, input.command, input.args ?? {}, async (journal) =>
    fn({
      cwd,
      opRoot,
      journal,
      async reloadProject(): Promise<LoadedProject> {
        const outcome = await loadProject({ cwd });
        if (!outcome.ok) {
          throw new RepoKernelError('CONFIG_INVALID', 'project failed to load; run rk validate');
        }
        return outcome;
      },
      refreshRegistry(): Promise<RegistryReport> {
        // The registry is a single derived file regenerated from a full scan
        // of plan state. Serialize the read-modify-write so concurrent rk
        // processes cannot last-writer-wins each other's mutations.
        return withLockRetrying('registry', opRoot, () => refreshRegistry(cwd));
      },
      lockedMutate<T>(resourceKey: string, fn: () => Promise<T>): Promise<T> {
        return withLockRetrying(resourceKey, opRoot, fn);
      },
    }),
  );
}
