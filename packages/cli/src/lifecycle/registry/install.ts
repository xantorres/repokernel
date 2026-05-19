import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from '../gitExec.js';

/**
 * Install the registry merge driver into a repo's git config and
 * `.gitattributes`. The driver itself is invoked by git as
 * `rk registry merge-driver %O %A %B` — this helper wires up that
 * invocation so collaborators automatically pick the resolution up the
 * next time they pull.
 *
 * The function is idempotent. Re-running it does not duplicate
 * `.gitattributes` entries and does not error when the git config keys
 * already exist with matching values.
 */
export interface InstallMergeDriverArgs {
  readonly cwd: string;
  /** Repo-relative path to `.repokernel/registry.json`. Defaults to that. */
  readonly registryPath?: string;
  /** Override the git config block name. Defaults to `repokernel-registry`. */
  readonly driverName?: string;
  /** Command git runs to perform the merge. */
  readonly mergeCommand?: string;
}

export interface InstallMergeDriverResult {
  readonly attributesPath: string;
  readonly attributesAdded: boolean;
  readonly driverName: string;
  readonly configKeys: readonly string[];
}

const DEFAULT_DRIVER_NAME = 'repokernel-registry';
const DEFAULT_REGISTRY_PATH = '.repokernel/registry.json';
// Single hyphenated command name matches RK's existing style (rk install-skill,
// rk review-create) and avoids restructuring `rk registry` into a parent
// command. The CLI registers `rk registry-merge-driver` as a top-level
// command that delegates to `runRegistryMergeDriver`.
const DEFAULT_MERGE_COMMAND = 'rk registry-merge-driver --current %A --other %B --base %O';

export async function installRegistryMergeDriver(
  args: InstallMergeDriverArgs,
): Promise<InstallMergeDriverResult> {
  const driverName = args.driverName ?? DEFAULT_DRIVER_NAME;
  const registryPath = args.registryPath ?? DEFAULT_REGISTRY_PATH;
  const mergeCommand = args.mergeCommand ?? DEFAULT_MERGE_COMMAND;

  // The registryPath is interpolated into a `.gitattributes` line. Reject
  // any value that would produce a malformed line (whitespace, newlines,
  // shell metacharacters that look like glob escapes git would re-parse).
  // The default value is a static repo-relative path, so this only fires
  // when a caller passes an explicit override.
  if (/[\s\r\n\0]/.test(registryPath)) {
    throw new Error(
      `installRegistryMergeDriver: registryPath must not contain whitespace or NUL (got: ${JSON.stringify(registryPath)})`,
    );
  }
  if (/[\s\r\n\0]/.test(driverName)) {
    throw new Error(
      `installRegistryMergeDriver: driverName must not contain whitespace or NUL (got: ${JSON.stringify(driverName)})`,
    );
  }

  const attributesPath = join(args.cwd, '.gitattributes');
  const attributesAdded = await ensureGitAttributesEntry(
    attributesPath,
    `${registryPath} merge=${driverName}`,
  );

  const configKeys: string[] = [];
  await setGitConfig(args.cwd, `merge.${driverName}.name`, 'RepoKernel registry merge driver');
  configKeys.push(`merge.${driverName}.name`);
  await setGitConfig(args.cwd, `merge.${driverName}.driver`, mergeCommand);
  configKeys.push(`merge.${driverName}.driver`);
  await setGitConfig(args.cwd, `merge.${driverName}.recursive`, 'binary');
  configKeys.push(`merge.${driverName}.recursive`);

  return {
    attributesPath,
    attributesAdded,
    driverName,
    configKeys,
  };
}

async function ensureGitAttributesEntry(path: string, line: string): Promise<boolean> {
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') throw cause;
  }
  const lines = existing.length > 0 ? existing.split('\n') : [];
  // Treat any line that already targets the same path as already-installed —
  // we do not overwrite a user-customised driver assignment.
  const target = line.split(' ')[0];
  for (const existingLine of lines) {
    const trimmed = existingLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith(`${target} `)) {
      return false;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const next =
    existing.length > 0 && !existing.endsWith('\n')
      ? `${existing}\n${line}\n`
      : `${existing}${line}\n`;
  await writeFile(path, next, 'utf8');
  return true;
}

async function setGitConfig(cwd: string, key: string, value: string): Promise<void> {
  await git(['-C', cwd, 'config', key, value]);
}
