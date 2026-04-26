import { RepoKernelError } from '@repokernel/core';
import { ClaudeRunner } from './claude.js';
import { FakeRunner } from './fake.js';
import { ManualRunner } from './manual.js';
import type { AgentRunner } from './types.js';

const runners = new Map<string, AgentRunner>([
  ['manual', new ManualRunner()],
  ['fake', new FakeRunner()],
]);

export function getRunner(name: string, experimental = false): AgentRunner {
  if (name === 'claude') {
    if (!experimental) {
      throw new RepoKernelError('INTERNAL', 'claude runner requires --experimental flag');
    }
    return new ClaudeRunner();
  }

  const runner = runners.get(name);
  if (!runner) {
    throw new RepoKernelError(
      'INTERNAL',
      `unknown agent: "${name}" (available: manual, fake, claude --experimental)`,
    );
  }
  return runner;
}

export type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';
