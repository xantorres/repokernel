import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  canonicalJson,
  compareRegistries,
  generateRegistry,
  type LoadProjectOutcome,
  loadProject,
  type Registry,
  RegistrySchema,
  RepoKernelError,
  runValidators,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import type { CommandResult } from './validate.js';

export interface RegistryCommandOptions {
  readonly cwd: string;
  readonly write: boolean;
  readonly check: boolean;
  readonly json: boolean;
}

export async function runRegistryCommand(opts: RegistryCommandOptions): Promise<CommandResult> {
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd: opts.cwd });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
  if (!outcome.ok) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: opts.json ? emitJson({ findings: outcome.findings }) : '',
      stderr: opts.json ? '' : 'config invalid; see validate output\n',
    };
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
  });

  const registryPath = resolve(outcome.cwd, outcome.config.paths.registry);

  if (opts.write) {
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, canonicalJson(registry), 'utf8');
    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: emitJson({ written: registryPath, registry }),
        stderr: '',
      };
    }
    return {
      exitCode: EXIT_OK,
      stdout: `wrote ${join(outcome.cwd, outcome.config.paths.registry)}\n`,
      stderr: '',
    };
  }

  if (opts.check) {
    const previous = await loadPreviousRegistry(registryPath);
    if (!previous) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: opts.json
          ? emitJson({ drift: true, reason: 'NO_PREVIOUS_REGISTRY' })
          : `no previous registry at ${registryPath}\n`,
        stderr: '',
      };
    }
    const cmp = compareRegistries(registry, previous);
    if (cmp.drift) {
      if (opts.json) {
        return {
          exitCode: EXIT_FINDINGS,
          stdout: emitJson({
            drift: true,
            registryPath,
          }),
          stderr: '',
        };
      }
      return {
        exitCode: EXIT_FINDINGS,
        stdout: `REGISTRY_DRIFT detected at ${registryPath}\n`,
        stderr: '',
      };
    }
    return {
      exitCode: EXIT_OK,
      stdout: opts.json ? emitJson({ drift: false, registryPath }) : 'no drift\n',
      stderr: '',
    };
  }

  if (opts.json) {
    return { exitCode: EXIT_OK, stdout: emitJson(registry), stderr: '' };
  }
  return {
    exitCode: EXIT_OK,
    stdout: canonicalJson(registry),
    stderr: '',
  };
}

async function loadPreviousRegistry(path: string): Promise<Registry | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw cause;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
