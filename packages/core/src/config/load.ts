import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RepoKernelError } from '../errors/RepoKernelError.js';
import type { Finding } from '../schemas/finding.js';
import { ConfigSchema, type Config } from './schema.js';

export const CONFIG_FILENAME = 'repokernel.config.yaml';

export type LoadConfigResult =
  | { ok: true; config: Config; configPath: string; cwd: string }
  | { ok: false; configPath: string; cwd: string; finding: Finding };

export interface LoadConfigOptions {
  readonly cwd: string;
  readonly filename?: string;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadConfigResult> {
  const cwd = resolve(options.cwd);
  const filename = options.filename ?? CONFIG_FILENAME;
  const configPath = join(cwd, filename);

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

  return { ok: true, config: parsed.data, configPath, cwd };
}
