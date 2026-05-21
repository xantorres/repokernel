import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  canonicalJson,
  compareRegistries,
  type FindingSummary,
  generateRegistry,
  type LoadProjectOutcome,
  loadProject,
  type Registry,
  RegistrySchema,
  RepoKernelError,
  runValidators,
  summarizeFindings,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { formatFindings } from '../format/text.js';
import { atomicWriteText } from '../lifecycle/atomicWrite.js';
import { RK_GENERATED_BY } from '../version.js';
import type { CommandResult } from './validate.js';

export interface RegistryCommandOptions {
  readonly cwd: string;
  readonly write: boolean;
  readonly check: boolean;
  readonly json: boolean;
  readonly explain?: boolean;
  readonly out?: string;
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
    if (opts.json) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: emitJson({
          findings: outcome.findings,
          summary: summarizeFindings(outcome.findings),
        }),
        stderr: '',
      };
    }
    const lines = ['config invalid'];
    if (outcome.findings.length > 0) {
      lines.push('');
      lines.push(formatFindings(outcome.findings));
    } else {
      lines.push('  (no findings reported; run `rk validate` for details)');
    }
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `${lines.join('\n')}\n`,
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
    generatedBy: RK_GENERATED_BY,
  });

  const canonicalPath = resolve(outcome.cwd, outcome.config.paths.registry);
  if (!isInsideProject(outcome.cwd, canonicalPath)) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `registry path escapes project root: ${outcome.config.paths.registry}\n`,
    };
  }

  if (opts.write) {
    // --out overrides the write destination (one-off); --check always uses canonical path
    const writePath = opts.out !== undefined ? resolve(opts.out) : canonicalPath;
    await mkdir(dirname(writePath), { recursive: true });
    await atomicWriteText(writePath, canonicalJson(registry));
    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: emitJson({ written: writePath, registry }),
        stderr: '',
      };
    }
    return {
      exitCode: EXIT_OK,
      stdout: `wrote ${writePath}\n`,
      stderr: '',
    };
  }

  const registryPath = canonicalPath;

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
      const suggestion = 'rk registry --write';
      if (opts.json) {
        return {
          exitCode: EXIT_FINDINGS,
          stdout: emitJson({
            drift: true,
            registryPath,
            ...(opts.explain === true ? { reason: cmp.reason ?? 'registry differs' } : {}),
            suggestion,
          }),
          stderr: '',
        };
      }
      const details =
        opts.explain === true
          ? `\nReason: ${cmp.reason ?? 'registry differs'}\nRun: ${suggestion}\n`
          : `\nRun: ${suggestion}\n`;
      return {
        exitCode: EXIT_FINDINGS,
        stdout: `REGISTRY_DRIFT detected at ${registryPath}${details}`,
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
    // The registry's health block is already a FindingSummary in all but
    // `total` — surface a top-level `summary` so agents parse the same shape
    // emitted by `rk status` and `rk validate`.
    const fc = registry.health.findingCounts;
    const summary: FindingSummary = {
      maxSeverity: registry.health.maxSeverity,
      findingCounts: fc,
      total: fc.P0 + fc.P1 + fc.P2 + fc.P3,
    };
    return { exitCode: EXIT_OK, stdout: emitJson({ ...registry, summary }), stderr: '' };
  }
  return {
    exitCode: EXIT_OK,
    stdout: canonicalJson(registry),
    stderr: '',
  };
}

function isInsideProject(cwd: string, path: string): boolean {
  const root = resolve(cwd);
  const target = resolve(path);
  return target === root || target.startsWith(`${root}${sep}`);
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
