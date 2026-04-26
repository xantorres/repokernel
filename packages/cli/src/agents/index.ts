import { type AgentDefinition, RepoKernelError } from '@repokernel/core';
import { ClaudeRunner } from './claude.js';
import { ExternalRunner } from './external.js';
import { FakeRunner } from './fake.js';
import { ManualRunner } from './manual.js';
import type { AgentRunner } from './types.js';

const builtins = new Map<string, AgentRunner>([
  ['manual', new ManualRunner()],
  ['fake', new FakeRunner()],
]);

export function getRunner(
  name: string,
  experimental = false,
  agentDefs: Record<string, AgentDefinition> = {},
): AgentRunner {
  if (name === 'claude') {
    if (!experimental) {
      throw new RepoKernelError('INTERNAL', 'claude runner requires --experimental flag');
    }
    return new ClaudeRunner();
  }

  const builtin = builtins.get(name);
  if (builtin) return builtin;

  const def = agentDefs[name];
  if (def) return new ExternalRunner(name, def);

  throw new RepoKernelError(
    'INTERNAL',
    `unknown agent: "${name}" (available: manual, fake, claude --experimental, or define in config agents:{})`,
  );
}

export type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';
