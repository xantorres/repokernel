import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { invalidatePreflightCache, runPreflightCommand } from '../src/commands/preflight.js';
import { EXIT_OK } from '../src/exitCodes.js';
import { refreshRegistry } from '../src/lifecycle/registry.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);

afterAll(cleanupAllFixtures);

async function fixture(): Promise<string> {
  const cwd = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Epic', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Sprint',
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    { path: 'lanes/main.md', content: fm({ name: 'main' }) },
  ]);
  // Preflight resolves opRoot under .git/repokernel — initialize a real git
  // repo so the cache write location is well-defined and worktree scans
  // can run without surfacing errors.
  await execFileAsync('git', ['init', '-q'], { cwd });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd });
  return cwd;
}

describe('rk preflight', () => {
  it('emits JSON with cache_hit=false on first call, cache_hit=true on second', async () => {
    const cwd = await fixture();

    const first = await runPreflightCommand({ cwd, json: true });
    expect(first.exitCode).toBe(EXIT_OK);
    const firstParsed = JSON.parse(first.stdout) as {
      schemaVersion: number;
      cache_hit: boolean;
      warnings_count: number;
      status: { schemaVersion: number };
    };
    expect(firstParsed.schemaVersion).toBe(1);
    expect(firstParsed.cache_hit).toBe(false);
    expect(firstParsed.status.schemaVersion).toBe(2);

    const second = await runPreflightCommand({ cwd, json: true });
    expect(second.exitCode).toBe(EXIT_OK);
    const secondParsed = JSON.parse(second.stdout) as { cache_hit: boolean };
    expect(secondParsed.cache_hit).toBe(true);
  });

  it('--refresh forces a fresh scan', async () => {
    const cwd = await fixture();
    await runPreflightCommand({ cwd, json: true });

    const refreshed = await runPreflightCommand({ cwd, json: true, refresh: true });
    expect(refreshed.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(refreshed.stdout) as { cache_hit: boolean };
    expect(parsed.cache_hit).toBe(false);
  });

  it('writes the cache file under the operational root', async () => {
    const cwd = await fixture();
    await runPreflightCommand({ cwd, json: true });

    const cachePath = join(cwd, '.git', 'repokernel', 'preflight.json');
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as {
      schemaVersion: number;
      captured_at: string;
      status: unknown;
    };
    expect(cached.schemaVersion).toBe(1);
    expect(typeof cached.captured_at).toBe('string');
    expect(cached.status).toBeDefined();
  });

  it('expired cache (max-age 0) triggers a re-scan', async () => {
    const cwd = await fixture();
    await runPreflightCommand({ cwd, json: true });

    const result = await runPreflightCommand({ cwd, json: true, maxAgeSeconds: 0 });
    const parsed = JSON.parse(result.stdout) as { cache_hit: boolean };
    expect(parsed.cache_hit).toBe(false);
  });

  it('ignores a cache file with a wrong schemaVersion', async () => {
    const cwd = await fixture();
    const cachePath = join(cwd, '.git', 'repokernel', 'preflight.json');
    await mkdir(join(cwd, '.git', 'repokernel'), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ schemaVersion: 999, captured_at: 'x' }));

    const result = await runPreflightCommand({ cwd, json: true });
    const parsed = JSON.parse(result.stdout) as { cache_hit: boolean };
    expect(parsed.cache_hit).toBe(false);
  });

  it('invalidatePreflightCache removes the cache file (no-op when absent)', async () => {
    const cwd = await fixture();
    await runPreflightCommand({ cwd, json: true });

    const opRoot = join(cwd, '.git', 'repokernel');
    const cachePath = join(opRoot, 'preflight.json');

    await expect(readFile(cachePath, 'utf8')).resolves.toBeTruthy();
    await invalidatePreflightCache(opRoot);
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow(/ENOENT/);

    // Idempotent — no error when called against a missing cache file.
    await invalidatePreflightCache(opRoot);
  });

  it('a refreshRegistry call invalidates the preflight cache', async () => {
    const cwd = await fixture();
    await runPreflightCommand({ cwd, json: true });
    const cachePath = join(cwd, '.git', 'repokernel', 'preflight.json');
    await expect(readFile(cachePath, 'utf8')).resolves.toBeTruthy();

    await refreshRegistry(cwd);

    await expect(readFile(cachePath, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
