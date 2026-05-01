/**
 * Unit-level tests for runRecoverCommand / detectOperationalCorruption.
 *
 * The companion recover.test.ts exercises the same logic via the compiled CLI
 * binary (rk recover …). V8 coverage cannot trace into a spawned process, so
 * that suite contributes 0 coverage lines. These tests import the functions
 * directly to close the gap.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { detectOperationalCorruption, runRecoverCommand } from '../src/commands/recover.js';

const execFileAsync = promisify(execFile);

const tracked: string[] = [];

afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeGitRepo(): Promise<{ cwd: string; opRoot: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-recover-unit-'));
  tracked.push(cwd);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'u@rk.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'U']);
  await writeFile(join(cwd, 'README.md'), 'init', 'utf8');
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-m', 'init']);
  const opRoot = join(cwd, '.git', 'repokernel');
  await mkdir(opRoot, { recursive: true });
  return { cwd, opRoot };
}

function minimalRunJson(id: string, status: string): string {
  return JSON.stringify({
    id,
    epic_id: 'E-001',
    lane: 'main',
    status,
    mode: 'autonomous',
    agent: 'test',
    worktree: '/tmp/wt',
    branch: `rk/sprint/E-001/S-001`,
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T01:00:00.000Z',
    current_sprint: null,
    completed_sprints: [],
    halt_reason: null,
    limit: null,
    sprint_count: 0,
    execution_strategy: 'sequential',
    wave_index: -1,
    active_sprints: [],
    parallel_workers: [],
    abort_requested: false,
  });
}

describe('runRecoverCommand — argument validation', () => {
  it('rejects --preview + --apply together', async () => {
    const result = await runRecoverCommand({
      cwd: process.cwd(),
      preview: true,
      apply: true,
      json: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('returns runtime error for non-git cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-recover-notgit-'));
    tracked.push(dir);
    const result = await runRecoverCommand({
      cwd: dir,
      preview: true,
      apply: false,
      json: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('runRecoverCommand — preview (read-only)', () => {
  it('healthy state → zero findings, exitCode 0', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{"worktrees":[]}', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: unknown[] };
    expect(parsed.findings).toEqual([]);
  });

  it('corrupt worktrees.json → finding reported, exitCode non-zero', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{bad json', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ kind: string; path: string; detail: string; suggestion: string }>;
      actions: unknown[];
    };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].kind).toBe('corrupt_worktrees_json');
    expect(parsed.findings[0].suggestion).toContain('rk recover --apply');
    expect(parsed.actions).toEqual([]);
  });

  it('corrupt run file → finding reported, file untouched', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    const runFile = join(runsDir, 'RUN-001.json');
    await writeFile(runFile, 'not json', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ kind: string }>;
    };
    expect(parsed.findings.some((f) => f.kind === 'corrupt_run_file')).toBe(true);
    expect(await readFile(runFile, 'utf8')).toBe('not json');
  });

  it('stale lane claim (terminal run) → finding reported', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const runsDir = join(opRoot, 'runs');
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(runsDir, { recursive: true });
    await mkdir(lanesDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-001.json'), minimalRunJson('RUN-001', 'completed'), 'utf8');
    await writeFile(
      join(lanesDir, 'main.json'),
      JSON.stringify({
        lane: 'main',
        run_id: 'RUN-001',
        epic_id: 'E-001',
        worktree: '/tmp/wt',
        branch: 'rk/sprint/E-001/S-001',
        claimed_at: new Date().toISOString(),
      }),
      'utf8',
    );

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ kind: string }>;
    };
    expect(parsed.findings.some((f) => f.kind === 'stale_lane_claim')).toBe(true);
  });

  it('aborted run → stale_lane_claim finding', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const runsDir = join(opRoot, 'runs');
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(runsDir, { recursive: true });
    await mkdir(lanesDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-002.json'), minimalRunJson('RUN-002', 'aborted'), 'utf8');
    await writeFile(
      join(lanesDir, 'main.json'),
      JSON.stringify({
        lane: 'main',
        run_id: 'RUN-002',
        epic_id: 'E-001',
        worktree: '/tmp/wt',
        branch: 'rk/sprint/E-001/S-001',
        claimed_at: new Date().toISOString(),
      }),
      'utf8',
    );

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string }> };
    expect(parsed.findings.some((f) => f.kind === 'stale_lane_claim')).toBe(true);
  });

  it('failed run → stale_lane_claim finding', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const runsDir = join(opRoot, 'runs');
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(runsDir, { recursive: true });
    await mkdir(lanesDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-003.json'), minimalRunJson('RUN-003', 'failed'), 'utf8');
    await writeFile(
      join(lanesDir, 'main.json'),
      JSON.stringify({
        lane: 'main',
        run_id: 'RUN-003',
        epic_id: 'E-001',
        worktree: '/tmp/wt',
        branch: 'rk/sprint/E-001/S-001',
        claimed_at: new Date().toISOString(),
      }),
      'utf8',
    );

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string }> };
    expect(parsed.findings.some((f) => f.kind === 'stale_lane_claim')).toBe(true);
  });

  it('orphan pid → orphan_lane_pid finding', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(lanesDir, { recursive: true });
    await writeFile(
      join(lanesDir, 'main.json'),
      JSON.stringify({
        lane: 'main',
        run_id: 'RUN-999',
        epic_id: 'E-001',
        worktree: '/tmp/wt',
        branch: 'rk/sprint/E-001/S-001',
        claimed_at: new Date().toISOString(),
        pid: 2_000_001,
      }),
      'utf8',
    );

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string }> };
    expect(parsed.findings.some((f) => f.kind === 'orphan_lane_pid')).toBe(true);
  });

  it('live pid → no finding', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(lanesDir, { recursive: true });
    await writeFile(
      join(lanesDir, 'main.json'),
      JSON.stringify({
        lane: 'main',
        run_id: 'RUN-100',
        epic_id: 'E-001',
        worktree: '/tmp/wt',
        branch: 'rk/sprint/E-001/S-001',
        claimed_at: new Date().toISOString(),
        pid: process.pid,
      }),
      'utf8',
    );

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: unknown[] };
    expect(parsed.findings).toEqual([]);
  });
});

describe('runRecoverCommand — apply (repair)', () => {
  it('apply with no issues → zero actions, exitCode 0', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{"worktrees":[]}', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: false, apply: true, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { actions: unknown[] };
    expect(parsed.actions).toEqual([]);
  });

  it('apply with corrupt worktrees.json → quarantine + rebuild, file is valid after', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const wtFile = join(opRoot, 'worktrees.json');
    await writeFile(wtFile, '{"broken":[', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: false, apply: true, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ kind: string }>;
      actions: Array<{ kind: string }>;
    };
    expect(parsed.findings.some((f) => f.kind === 'corrupt_worktrees_json')).toBe(true);
    expect(parsed.actions.some((a) => a.kind === 'quarantine_worktrees_json')).toBe(true);
    expect(parsed.actions.some((a) => a.kind === 'rebuild_worktrees_json')).toBe(true);

    const entries = await readdir(opRoot);
    expect(entries.some((e) => e.startsWith('worktrees.json.corrupt.'))).toBe(true);
    const rebuilt = JSON.parse(await readFile(wtFile, 'utf8'));
    expect(Array.isArray(rebuilt.worktrees)).toBe(true);
  });

  it('apply with corrupt run file → quarantine, file gone from runs dir', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-001.json'), '!!!', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: false, apply: true, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ kind: string }>;
    };
    expect(parsed.actions.some((a) => a.kind === 'quarantine_run_file')).toBe(true);

    const entries = await readdir(runsDir);
    expect(entries.some((e) => e === 'RUN-001.json')).toBe(false);
    expect(entries.some((e) => e.startsWith('RUN-001.json.corrupt.'))).toBe(true);
  });

  it('apply with orphan pid → release_stale_lane action', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(lanesDir, { recursive: true });
    await writeFile(
      join(lanesDir, 'main.json'),
      JSON.stringify({
        lane: 'main',
        run_id: 'RUN-999',
        epic_id: 'E-001',
        worktree: '/tmp/wt',
        branch: 'rk/sprint/E-001/S-001',
        claimed_at: new Date().toISOString(),
        pid: 2_000_001,
      }),
      'utf8',
    );

    const result = await runRecoverCommand({ cwd, preview: false, apply: true, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ kind: string }>;
    };
    expect(parsed.actions.some((a) => a.kind === 'release_stale_lane')).toBe(true);

    const entries = await readdir(lanesDir);
    expect(entries.some((e) => e === 'main.json')).toBe(false);
    expect(entries.some((e) => e.startsWith('main.json.corrupt.'))).toBe(true);
  });
});

describe('runRecoverCommand — non-JSON text output', () => {
  it('healthy state → human-readable text, exitCode 0', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{"worktrees":[]}', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: true, apply: false, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('healthy');
  });

  it('preview with findings → text output shows kind + suggestion', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{bad', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: false, apply: false, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('corrupt_worktrees_json');
    expect(result.stdout).toContain('rk recover --apply');
  });

  it('apply with findings → text shows "actions taken"', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{bad', 'utf8');

    const result = await runRecoverCommand({ cwd, preview: false, apply: true, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/actions?/);
  });
});

describe('detectOperationalCorruption', () => {
  it('non-git cwd → empty array (no throw)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-detect-notgit-'));
    tracked.push(dir);
    const findings = await detectOperationalCorruption(dir);
    expect(findings).toEqual([]);
  });

  it('git repo, no worktrees.json → empty array', async () => {
    const { cwd } = await makeGitRepo();
    const findings = await detectOperationalCorruption(cwd);
    expect(findings).toEqual([]);
  });

  it('valid worktrees.json → empty array', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{"worktrees":[]}', 'utf8');
    const findings = await detectOperationalCorruption(cwd);
    expect(findings).toEqual([]);
  });

  it('corrupt worktrees.json → corrupt_worktrees_json finding', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '!!! not json', 'utf8');
    const findings = await detectOperationalCorruption(cwd);
    expect(findings.some((f) => f.kind === 'corrupt_worktrees_json')).toBe(true);
    expect(findings[0].suggestion).toContain('rk recover');
  });

  it('corrupt run file → corrupt_run_file finding', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-001.json'), 'nope', 'utf8');
    const findings = await detectOperationalCorruption(cwd);
    expect(findings.some((f) => f.kind === 'corrupt_run_file')).toBe(true);
  });

  it('multiple corrupt artifacts → multiple findings', async () => {
    const { cwd, opRoot } = await makeGitRepo();
    await writeFile(join(opRoot, 'worktrees.json'), 'broken', 'utf8');
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-001.json'), 'also broken', 'utf8');
    const findings = await detectOperationalCorruption(cwd);
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
});
