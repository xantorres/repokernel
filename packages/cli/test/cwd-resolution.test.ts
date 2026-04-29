import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const RK_BIN = resolve(__dirname, '..', 'dist', 'index.js');

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-cwd-'));
  tracked.push(dir);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@rk.test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'RK Test']);

  await writeFile(
    join(dir, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: cwd-test
projectName: CWD Resolution Test
paths:
  epics: .agents/plan/epics
  sprints: .agents/plan/sprints
  reviews: .agents/plan/reviews
  queues: .agents/plan/queues
  lanes: .agents/plan/lanes
  generated: .agents
  registry: .agents/registry.json
`,
    'utf8',
  );
  for (const p of [
    '.agents/plan/epics',
    '.agents/plan/sprints',
    '.agents/plan/reviews',
    '.agents/plan/queues',
    '.agents/plan/lanes',
  ]) {
    await mkdir(join(dir, p), { recursive: true });
    await writeFile(join(dir, p, '.gitkeep'), '', 'utf8');
  }
  await writeFile(
    join(dir, '.agents/plan/epics/E-001.md'),
    `---
id: E-001
title: Test epic
status: active
adr_links: []
sprints: []
---

# E-001: Test epic
`,
    'utf8',
  );
  await writeFile(join(dir, '.agents/registry.json'), '{}', 'utf8');
  await execFileAsync('git', ['-C', dir, 'add', '-A']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

async function rk(
  cwd: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [RK_BIN, ...args], { cwd });
    return { exitCode: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('CLI: stdout flushed before exit (Fix 1)', () => {
  it('rk validate emits stdout when piped (no truncation)', async () => {
    const dir = await makeProject();
    // execFile pipes stdout — exact repro of agent-shell invocation that
    // surfaced the silent no-op bug in DV's rk-issues 2026-04-29 entry.
    const r = await rk(dir, ['validate', '--fail-on', 'P0,P1', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('rk create epic writes a file AND emits non-empty stdout', async () => {
    const dir = await makeProject();
    const r = await rk(dir, ['create', 'epic', 'flush-test']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    // The file should exist on disk after the command returns.
    const ls = await execFileAsync('ls', [join(dir, '.agents/plan/epics')]);
    expect(ls.stdout).toMatch(/E-\d{3}.*\.md/);
  });
});

describe('CLI: nested subcommands resolve config from a subdirectory (Fix 5)', () => {
  it('rk validate works from a deep subdirectory', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/epics');
    const r = await rk(deep, ['validate', '--fail-on', 'P0,P1']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/repokernel\.config\.yaml not found/);
  });

  it('rk epic status works from a deep subdirectory (two-level subcommand)', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/sprints');
    const r = await rk(deep, ['epic', 'status', 'E-001', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/repokernel\.config\.yaml not found/);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('rk epic ls works from a deep subdirectory', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/reviews');
    const r = await rk(deep, ['epic', 'ls', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/repokernel\.config\.yaml not found/);
    const data = JSON.parse(r.stdout) as { epics: { id: string }[] };
    expect(data.epics.some((e) => e.id === 'E-001')).toBe(true);
  });

  it('rk ls epics --unshipped works from a deep subdirectory', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/queues');
    const r = await rk(deep, ['ls', 'epics', '--unshipped', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/repokernel\.config\.yaml not found/);
  });
});
