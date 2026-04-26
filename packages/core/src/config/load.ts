import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RepoKernelError } from '../errors/RepoKernelError.js';
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

export async function findProjectRoot(
  startDir: string,
  filename: string = CONFIG_FILENAME,
): Promise<FindProjectRootResult | null> {
  let dir = resolve(startDir);
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
        `repokernel config not found at ${configPath}`,
        cause,
      );
    }
    throw new RepoKernelError(
      'CONFIG_FILE_UNREADABLE',
      `cannot read repokernel config at ${configPath}`,
      cause,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true });
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
