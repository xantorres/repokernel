import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  canonicalJson,
  type Finding,
  generateRegistry,
  loadProject,
  RepoKernelError,
  runValidators,
} from '@repokernel/core';
import { RK_GENERATED_BY } from '../version.js';
import { atomicWriteText } from './atomicWrite.js';

export interface RegistryReport {
  readonly findings: readonly Finding[];
}

export async function refreshRegistry(cwd: string): Promise<RegistryReport> {
  let outcome: Awaited<ReturnType<typeof loadProject>>;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) throw cause;
    throw new RepoKernelError('IO_ERROR', 'failed to load project for registry refresh', cause);
  }

  if (!outcome.ok) {
    return { findings: outcome.findings };
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

  const registryPath = resolve(outcome.cwd, outcome.config.paths.registry);
  await mkdir(dirname(registryPath), { recursive: true });
  await atomicWriteText(registryPath, canonicalJson(registry));

  return { findings };
}
