import { EXIT_FINDINGS, EXIT_OK } from '../exitCodes.js';
import { runRegistryMergeDriver } from '../lifecycle/registry/mergeDriver.js';
import type { CommandResult } from './validate.js';

export interface RegistryMergeDriverCommandOptions {
  readonly currentPath: string;
  readonly otherPath: string;
  readonly basePath?: string;
  readonly json: boolean;
}

/**
 * Thin command-layer wrapper around `runRegistryMergeDriver`.
 *
 * Git invokes `rk registry-merge-driver --current %A --other %B --base %O`
 * automatically when a merge touches `.repokernel/registry.json` AND the
 * `merge=repokernel-registry` attribute is set. Exit code 0 tells git
 * the conflict is resolved (file at %A holds the merged content). Any
 * other exit code leaves the standard conflict markers in place so the
 * user can resolve manually.
 */
export async function runRegistryMergeDriverCommand(
  opts: RegistryMergeDriverCommandOptions,
): Promise<CommandResult> {
  const result = await runRegistryMergeDriver({
    currentPath: opts.currentPath,
    otherPath: opts.otherPath,
    ...(opts.basePath !== undefined ? { basePath: opts.basePath } : {}),
  });

  if (opts.json) {
    return {
      exitCode: result.ok ? EXIT_OK : EXIT_FINDINGS,
      stdout: `${JSON.stringify(
        {
          ok: result.ok,
          conflicts: result.conflicts,
          integrityIssues: result.integrityIssues,
          errors: result.errors,
        },
        null,
        2,
      )}\n`,
      stderr: '',
    };
  }

  if (result.ok) {
    return { exitCode: EXIT_OK, stdout: '', stderr: '' };
  }

  const lines: string[] = ['registry merge driver could not resolve cleanly'];
  for (const e of result.errors) lines.push(`  error: ${e}`);
  for (const c of result.conflicts) {
    lines.push(
      `  conflict: ${c.kind} ${c.id} ${c.field} (local=${JSON.stringify(c.local)} remote=${JSON.stringify(c.remote)})`,
    );
  }
  for (const i of result.integrityIssues) {
    lines.push(`  integrity: ${i.kind} ${i.id} -> ${i.missing}`);
  }
  return { exitCode: EXIT_FINDINGS, stdout: '', stderr: `${lines.join('\n')}\n` };
}
