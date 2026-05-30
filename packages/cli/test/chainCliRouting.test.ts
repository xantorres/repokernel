import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);
const RK_BIN = resolve(__dirname, '..', 'dist', 'index.js');

afterAll(cleanupAllFixtures);

function run(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [RK_BIN, ...args], { env: { ...process.env, NO_COLOR: '1' } });
}

async function projectWithEpic(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'demo', status: 'active', sprints: [] }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

describe('rk chain <target> routing', () => {
  it('rk chain E-NNN is an alias for rk chain preview --epic E-NNN', async () => {
    const cwd = await projectWithEpic();
    const alias = await run(['chain', 'E-001', '--cwd', cwd]);
    const canonical = await run(['chain', 'preview', '--epic', 'E-001', '--cwd', cwd]);
    expect(alias.stdout).toBe(canonical.stdout);
  });

  it('rk chain preview keeps its own --json flag (parent does not shadow it)', async () => {
    const cwd = await projectWithEpic();
    const { stdout } = await run(['chain', 'preview', '--epic', 'E-001', '--json', '--cwd', cwd]);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('rk chain S-NNN errors with a helpful usage message (chain has no sprint scope)', async () => {
    const cwd = await projectWithEpic();
    let err: (Error & { code?: number; stderr?: string }) | undefined;
    try {
      await run(['chain', 'S-001', '--cwd', cwd]);
    } catch (e) {
      err = e as Error & { code?: number; stderr?: string };
    }
    expect(err).toBeDefined();
    expect(err?.code).not.toBe(0);
    expect(String(err?.stderr)).toContain('expects an epic id');
  });

  it('rk chain with no target prints chain help', async () => {
    const { stdout } = await run(['chain']);
    expect(stdout).toContain('preview');
  });
});
