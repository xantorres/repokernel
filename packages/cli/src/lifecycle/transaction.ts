import { resolve } from 'node:path';
import { loadProject, RepoKernelError } from '@repokernel/core';
import { operationalRootBestEffort } from './controlPaths.js';
import { type JournalContext, withJournal } from './journal.js';
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
        return refreshRegistry(cwd);
      },
    }),
  );
}
