import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointAutonomousSprint } from '../src/lifecycle/checkpoint.js';

const execFileAsync = promisify(execFile);
const tracked: string[] = [];

afterEach(async () => {
  await Promise.all(tracked.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-checkpoint-'));
  tracked.push(cwd);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 't@rk.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'T']);
  await writeFile(join(cwd, 'README.md'), 'init\n', 'utf8');
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-m', 'init']);
  return cwd;
}

describe('checkpointAutonomousSprint', () => {
  it('commits dirty allowed-path work and returns the checkpoint sha', async () => {
    const cwd = await repo();
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf8');

    const checkpoint = await checkpointAutonomousSprint({
      cwd,
      sprintId: 'S-001',
      allowedPaths: ['src'],
      generatedPaths: [],
    });

    expect(checkpoint).toMatchObject({ files: ['src/feature.ts'] });
    expect(checkpoint?.sha).toMatch(/^[0-9a-f]{40}$/);
    const status = await execFileAsync('git', ['-C', cwd, 'status', '--short']);
    expect(status.stdout.trim()).toBe('');
  });

  it('leaves out-of-scope dirty files uncommitted', async () => {
    const cwd = await repo();
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'note.md'), 'draft\n', 'utf8');

    const checkpoint = await checkpointAutonomousSprint({
      cwd,
      sprintId: 'S-001',
      allowedPaths: ['src'],
      generatedPaths: [],
    });

    expect(checkpoint).toBeNull();
    const status = await execFileAsync('git', ['-C', cwd, 'status', '--short']);
    expect(status.stdout).toContain('docs/');
  });
});
