import { type AgentDefinition, RepoKernelError } from '@repokernel/core';
import { BUILTIN_PRESETS } from './catalog.js';
import { ExternalRunner } from './external.js';
import { FakeRunner } from './fake.js';
import { ManualRunner } from './manual.js';
import type { AgentRunner } from './types.js';

const RESERVED = new Map<string, AgentRunner>([
  ['manual', new ManualRunner()],
  ['fake', new FakeRunner()],
]);

export function getRunner(
  name: string,
  agentDefs: Record<string, AgentDefinition> = {},
): AgentRunner {
  const reserved = RESERVED.get(name);
  if (reserved) return reserved;

  const userDef = agentDefs[name];
  if (userDef) return new ExternalRunner(name, userDef);

  const preset = BUILTIN_PRESETS[name];
  if (preset) return new ExternalRunner(name, preset);

  const presetNames = Object.keys(BUILTIN_PRESETS).join(', ');
  throw new RepoKernelError(
    'INTERNAL',
    `unknown agent: "${name}" (available: manual, fake, presets: ${presetNames}, or define agents.${name} in repokernel.config.yaml)`,
  );
}

export type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';
