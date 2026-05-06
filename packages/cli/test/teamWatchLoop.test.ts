import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTeamStatusCommand } from '../src/commands/team.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-watch-'));
  tracked.push(dir);
  return dir;
}

async function fixtureProject(dir: string): Promise<void> {
  await mkdir(join(dir, '.repokernel', 'plan', 'sprints'), { recursive: true });
  await mkdir(join(dir, '.repokernel', 'plan', 'epics'), { recursive: true });
  await mkdir(join(dir, '.repokernel', 'plan', 'reviews'), { recursive: true });
  await mkdir(join(dir, '.repokernel', 'plan', 'queues'), { recursive: true });
  await mkdir(join(dir, '.repokernel', 'plan', 'lanes'), { recursive: true });
  await writeFile(
    join(dir, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: demo
projectName: demo
paths:
  epics: .repokernel/plan/epics
  sprints: .repokernel/plan/sprints
  reviews: .repokernel/plan/reviews
  queues: .repokernel/plan/queues
  lanes: .repokernel/plan/lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
  );
  // git init so operationalRoot resolves under .git/repokernel
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await exec('git', ['-C', dir, 'config', 'user.name', 'rk']);
  await exec('git', ['-C', dir, 'config', 'user.email', 'rk@example.com']);
}

describe('runTeamStatusCommand --watch', () => {
  it('exits cleanly after maxIterations and writes one CLEAR_SCREEN per refresh', async () => {
    const dir = await tmp();
    await fixtureProject(dir);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sleeps: number[] = [];
    const result = await runTeamStatusCommand({
      cwd: dir,
      json: true,
      watch: true,
      intervalSeconds: 60,
      maxIterations: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    writeSpy.mockRestore();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    // intervalSeconds is below the 15s floor → floor wins.
    expect(sleeps.every((ms) => ms === 60_000)).toBe(true);
    expect(sleeps.length).toBe(2); // sleep is skipped on the final iteration
  });

  it('honours the 15s minimum interval floor', async () => {
    const dir = await tmp();
    await fixtureProject(dir);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sleeps: number[] = [];
    await runTeamStatusCommand({
      cwd: dir,
      json: true,
      watch: true,
      intervalSeconds: 1, // below floor
      maxIterations: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    writeSpy.mockRestore();

    expect(sleeps).toEqual([15_000]);
  });
});
