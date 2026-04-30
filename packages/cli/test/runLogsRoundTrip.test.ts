import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAgentLog,
  appendLifecycleLog,
  appendLog,
  readLog,
} from '../src/lifecycle/runLogs.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-runlogs-'));
  tracked.push(dir);
  return dir;
}

describe('runLogs (PR9 backfill)', () => {
  it('appendAgentLog writes a redacted line under runs/<id>/logs/<sprint>.agent.log', async () => {
    const opRoot = await tmp();
    await appendAgentLog('RUN-001', 'S-001', 'agent says hello', opRoot);
    const out = await readLog('RUN-001', 'S-001', 'agent', opRoot);
    expect(out).toBe('agent says hello\n');
  });

  it('appendLifecycleLog writes to the lifecycle log file, not the agent file', async () => {
    const opRoot = await tmp();
    await appendLifecycleLog('RUN-001', 'S-001', 'started', opRoot);
    expect(await readLog('RUN-001', 'S-001', 'lifecycle', opRoot)).toBe('started\n');
    expect(await readLog('RUN-001', 'S-001', 'agent', opRoot)).toBe('');
  });

  it('appendLog accumulates lines across calls', async () => {
    const opRoot = await tmp();
    await appendLog('RUN-001', 'S-001', 'agent', 'one', opRoot);
    await appendLog('RUN-001', 'S-001', 'agent', 'two', opRoot);
    await appendLog('RUN-001', 'S-001', 'agent', 'three', opRoot);
    expect(await readLog('RUN-001', 'S-001', 'agent', opRoot)).toBe('one\ntwo\nthree\n');
  });

  it('readLog returns empty string when the file does not exist', async () => {
    const opRoot = await tmp();
    expect(await readLog('RUN-999', 'S-999', 'agent', opRoot)).toBe('');
  });

  it('agent log redacts secret-shaped substrings before writing', async () => {
    const opRoot = await tmp();
    await appendAgentLog(
      'RUN-002',
      'S-002',
      'leaked sk-proj-fakefakefakefakefakefakefakefake here',
      opRoot,
    );
    const persisted = await readLog('RUN-002', 'S-002', 'agent', opRoot);
    expect(persisted).not.toContain('sk-proj-fakefakefakefakefakefakefakefake');
    expect(persisted).toContain('[REDACTED]');
  });

  it('lifecycle log path differs from agent log path on disk', async () => {
    const opRoot = await tmp();
    await appendAgentLog('RUN-003', 'S-003', 'a', opRoot);
    await appendLifecycleLog('RUN-003', 'S-003', 'b', opRoot);
    const agent = await readFile(
      join(opRoot, 'runs', 'RUN-003', 'logs', 'S-003.agent.log'),
      'utf8',
    );
    const lifecycle = await readFile(
      join(opRoot, 'runs', 'RUN-003', 'logs', 'S-003.lifecycle.log'),
      'utf8',
    );
    expect(agent).toBe('a\n');
    expect(lifecycle).toBe('b\n');
  });
});
