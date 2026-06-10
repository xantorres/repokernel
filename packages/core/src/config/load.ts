import { accessSync, realpathSync } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { docsUrl, RepoKernelError } from '../errors/RepoKernelError.js';
import type { Finding } from '../schemas/finding.js';
import { FINDING_CODES } from '../validator/codes.js';
import { type Config, ConfigSchema, KNOWN_DEPRECATED_FIELDS } from './schema.js';

export const CONFIG_FILENAME = 'repokernel.config.yaml';

export type LoadConfigResult =
  | {
      ok: true;
      config: Config;
      configPath: string;
      cwd: string;
      warnings: readonly Finding[];
    }
  | { ok: false; configPath: string; cwd: string; finding: Finding };

export interface LoadConfigOptions {
  readonly cwd: string;
  readonly filename?: string;
}

export interface FindProjectRootResult {
  readonly cwd: string;
  readonly configPath: string;
}

/**
 * Resolve symlinks before walking. Mitigates a config-confusion attack where
 * a symlinked directory points into a tree that has a hostile
 * `repokernel.config.yaml` planted in a parent. By canonicalizing the path
 * first, the walk follows the actual filesystem ancestry rather than the
 * symlink's apparent path.
 *
 * Falls back to the original `resolve(startDir)` if `realpath` fails — e.g.
 * the path doesn't exist yet (`rk init` from a fresh dir before mkdir).
 */
function canonicalize(startDir: string): string {
  const resolved = resolve(startDir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function canonicalizeAsync(startDir: string): Promise<string> {
  const resolved = resolve(startDir);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function findProjectRoot(
  startDir: string,
  filename: string = CONFIG_FILENAME,
): Promise<FindProjectRootResult | null> {
  let dir = await canonicalizeAsync(startDir);
  while (true) {
    const candidate = join(dir, filename);
    try {
      await access(candidate);
      return { cwd: dir, configPath: candidate };
    } catch {
      // not here
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Synchronous walk-up to locate the nearest `repokernel.config.yaml`. Used at
 * CLI entry to normalize `--cwd` into the project root before commands run, so
 * `rk` can be invoked from any subdirectory of an initialized repo. Returns
 * `null` if no config is found between `startDir` and the filesystem root.
 */
export function findProjectRootSync(
  startDir: string,
  filename: string = CONFIG_FILENAME,
): FindProjectRootResult | null {
  let dir = canonicalize(startDir);
  while (true) {
    const candidate = join(dir, filename);
    try {
      accessSync(candidate);
      return { cwd: dir, configPath: candidate };
    } catch {
      // not here
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadConfigResult> {
  const startDir = resolve(options.cwd);
  const filename = options.filename ?? CONFIG_FILENAME;
  const found = await findProjectRoot(startDir, filename);
  const cwd = found?.cwd ?? startDir;
  const configPath = found?.configPath ?? join(startDir, filename);

  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new RepoKernelError(
        'CONFIG_FILE_NOT_FOUND',
        `repokernel.config.yaml not found in ${startDir} or any parent — run from a directory inside a repokernel-initialized repo, or run \`rk init\` here. See ${docsUrl('CONFIG_FILE_NOT_FOUND')}`,
        cause,
      );
    }
    throw new RepoKernelError(
      'CONFIG_FILE_UNREADABLE',
      `cannot read repokernel config at ${configPath}. See ${docsUrl('CONFIG_FILE_UNREADABLE')}`,
      cause,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, maxAliasCount: 100 });
  } catch (cause) {
    return {
      ok: false,
      configPath,
      cwd,
      finding: {
        severity: 'P0',
        code: 'CONFIG_INVALID',
        message: `repokernel config YAML parse error: ${(cause as Error).message}`,
        file: configPath,
        entityType: 'config',
        suggestion: 'fix YAML syntax',
        data: {},
      },
    };
  }

  const warnings: Finding[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    stripDeprecatedFields(raw as Record<string, unknown>, configPath, warnings);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      configPath,
      cwd,
      finding: {
        severity: 'P0',
        code: 'CONFIG_INVALID',
        message: `repokernel config schema validation failed`,
        file: configPath,
        entityType: 'config',
        suggestion: 'see issues in data.issues',
        data: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path,
            message: i.message,
            code: i.code,
          })),
        },
      },
    };
  }

  return { ok: true, config: parsed.data, configPath, cwd, warnings };
}

function stripDeprecatedFields(
  root: Record<string, unknown>,
  configPath: string,
  warnings: Finding[],
): void {
  for (const entry of KNOWN_DEPRECATED_FIELDS) {
    const path = entry.path;
    let parent: Record<string, unknown> | undefined = root;
    for (let i = 0; i < path.length - 1; i++) {
      const segment = path[i];
      if (segment === undefined) {
        parent = undefined;
        break;
      }
      const next = parent[segment];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        parent = undefined;
        break;
      }
      parent = next as Record<string, unknown>;
    }
    if (!parent) continue;
    const leaf = path[path.length - 1];
    if (leaf === undefined) continue;
    if (!Object.hasOwn(parent, leaf)) continue;

    const dotted = path.join('.');
    const message = entry.replacement
      ? `config field "${dotted}" is deprecated — ${entry.reason}; use ${entry.replacement} instead`
      : `config field "${dotted}" is deprecated — ${entry.reason}`;
    warnings.push({
      severity: 'P3',
      code: FINDING_CODES.DEPRECATED_FIELD,
      message,
      file: configPath,
      entityType: 'config',
      data: { path: [...path], reason: entry.reason },
    });
    delete parent[leaf];
  }
}
