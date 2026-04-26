import { type AgentDefinition, RepoKernelError } from '@repokernel/core';
import { ClaudeRunner, CodexRunner } from './claude.js';
import { ExternalRunner } from './external.js';
import { FakeRunner } from './fake.js';
import { ManualRunner } from './manual.js';
import type { AgentRunner } from './types.js';

const builtins = new Map<string, AgentRunner>([
  ['manual', new ManualRunner()],
  ['fake', new FakeRunner()],
]);

const experimental_builtins = new Set(['claude', 'codex']);

export function getRunner(
  name: string,
  experimental = false,
  agentDefs: Record<string, AgentDefinition> = {},
): AgentRunner {
  if (experimental_builtins.has(name)) {
    if (!experimental) {
      throw new RepoKernelError('INTERNAL', `${name} runner requires --experimental flag`);
    }
    if (name === 'claude') return new ClaudeRunner();
    if (name === 'codex') return new CodexRunner();
  }

  const builtin = builtins.get(name);
  if (builtin) return builtin;

  const def = agentDefs[name];
  if (def) return new ExternalRunner(name, def);

  throw new RepoKernelError(
    'INTERNAL',
    `unknown agent: "${name}" (available: manual, fake, claude/codex --experimental, or define in config agents:{})`,
  );
}

export type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';
