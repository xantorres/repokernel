import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runRebaseSprintCommand } from '../src/commands/rebaseSprint.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);
afterAll(cleanupAllFixtures);

async function readFm(file: string): Promise<Record<string, unknown>> {
  return matter(await readFile(file, 'utf8')).data as Record<string, unknown>;
}

async function gitFixture(status: string): Promise<string> {
  const cwd = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Long sprint',
        epic_id: 'E-001',
        status,
        lane: 'main',
        ...(status === 'active' ? { base_sha: 'a1b2c3d', started_at: '2026-04-25T10:00:00Z' } : {}),
      }),
    },
  ]);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@rk.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'RK Test']);
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-m', 'init']);
  return cwd;
}

describe('runRebaseSprintCommand', () => {
  it('realigns an active sprint base_sha to HEAD', async () => {
    const cwd = await gitFixture('active');
    const head = (await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim();

    const r = await runRebaseSprintCommand('S-001', { cwd, to: 'HEAD', json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { base_sha: string; changed: boolean };
    expect(obj.changed).toBe(true);
    expect(obj.base_sha).toBe(head);

    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.base_sha).toBe(head);
  });

  it('is a no-op when base_sha already matches the ref', async () => {
    const cwd = await gitFixture('active');
    await runRebaseSprintCommand('S-001', { cwd, to: 'HEAD', json: true });
    const second = await runRebaseSprintCommand('S-001', { cwd, to: 'HEAD', json: true });
    expect(second.exitCode).toBe(0);
    const obj = JSON.parse(second.stdout) as { changed: boolean };
    expect(obj.changed).toBe(false);
  });

  it('rejects a non-active sprint', async () => {
    const cwd = await gitFixture('queued');
    const r = await runRebaseSprintCommand('S-001', { cwd, to: 'HEAD', json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('expected active');
  });

  it('rejects an unresolvable git ref', async () => {
    const cwd = await gitFixture('active');
    const r = await runRebaseSprintCommand('S-001', { cwd, to: 'no-such-ref', json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('could not resolve git ref');
  });

  it('reports a missing sprint', async () => {
    const cwd = await gitFixture('active');
    const r = await runRebaseSprintCommand('S-999', { cwd, to: 'HEAD', json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not found');
  });
});
