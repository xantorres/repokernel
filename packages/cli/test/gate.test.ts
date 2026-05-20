import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runGateListCommand, runGateResolveCommand } from '../src/commands/gate.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

vi.mock('../src/lifecycle/git.js', () => ({
  getCurrentSha: vi.fn().mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd'),
  getPublishState: vi.fn().mockResolvedValue({ state: 'no_remote', remotes: [] }),
  isWorkingTreeClean: vi.fn().mockResolvedValue(true),
  changedFilesSince: vi.fn().mockResolvedValue([]),
  changedFilesForSprint: vi.fn().mockResolvedValue({
    files: [],
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
  }),
}));

// — fixtures —

function epicFile(id: string, sprintIds: string[]) {
  return fm({ id, title: `Epic ${id}`, status: 'active', sprints: sprintIds });
}

function sprintFile(id: string, epicId: string, opts: { status?: string; gate?: string } = {}) {
  const data: Record<string, unknown> = {
    id,
    title: `Sprint ${id}`,
    epic_id: epicId,
    status: opts.status ?? 'queued',
    lane: 'main',
  };
  if (opts.gate !== undefined) data.gate = opts.gate;
  return fm(data);
}

function queueFile(slots: Array<{ id: string; sprint_id: string; order: number }>) {
  return fm({ lane: 'main', slots });
}

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

// — rk gate ls —

describe('runGateListCommand', () => {
  it('returns empty message when no gates exist', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001') },
    ]);
    const r = await runGateListCommand({ cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No gates');
  });

  it('lists gates with their blocked sprints', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001') },
      { path: 'sprints/S-002.md', content: sprintFile('S-002', 'E-001', { gate: 'phase-1' }) },
    ]);
    const r = await runGateListCommand({ cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('phase-1');
    expect(r.stdout).toContain('S-002');
  });

  it('filters by epic when epicId provided', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001']) },
      { path: 'epics/E-002.md', content: epicFile('E-002', ['S-002']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { gate: 'alpha' }) },
      { path: 'sprints/S-002.md', content: sprintFile('S-002', 'E-002', { gate: 'beta' }) },
    ]);
    const r = await runGateListCommand({ cwd, epicId: 'E-001' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('alpha');
    expect(r.stdout).not.toContain('beta');
  });

  it('emits json when --json flag set', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { gate: 'checkpoint' }) },
    ]);
    const r = await runGateListCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ name: string }>;
    expect(parsed[0]?.name).toBe('checkpoint');
  });
});

// — rk gate resolve —

describe('runGateResolveCommand', () => {
  it('clears gate field from matching sprints', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { status: 'shipped' }) },
      { path: 'sprints/S-002.md', content: sprintFile('S-002', 'E-001', { gate: 'phase-1' }) },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-002', sprint_id: 'S-002', order: 0 }]),
      },
    ]);
    const r = await runGateResolveCommand('phase-1', { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('resolved');
    expect(r.stdout).toContain('S-002');

    const data = await readFm(join(cwd, 'sprints/S-002.md'));
    expect(data.gate).toBeUndefined();
  });

  it('clears multiple sprints sharing the same gate', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001', 'S-002', 'S-003']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { status: 'shipped' }) },
      { path: 'sprints/S-002.md', content: sprintFile('S-002', 'E-001', { gate: 'wave-2' }) },
      { path: 'sprints/S-003.md', content: sprintFile('S-003', 'E-001', { gate: 'wave-2' }) },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-002', sprint_id: 'S-002', order: 0 },
          { id: 'Q-003', sprint_id: 'S-003', order: 1 },
        ]),
      },
    ]);
    const r = await runGateResolveCommand('wave-2', { cwd });
    expect(r.exitCode).toBe(0);

    const d2 = await readFm(join(cwd, 'sprints/S-002.md'));
    const d3 = await readFm(join(cwd, 'sprints/S-003.md'));
    expect(d2.gate).toBeUndefined();
    expect(d3.gate).toBeUndefined();
  });

  it('fails when gate name not found', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001') },
    ]);
    const r = await runGateResolveCommand('unknown-gate', { cwd });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('unknown-gate');
  });

  it('fails when upstream sprints are not yet shipped', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001', 'S-002']) },
      // S-001 still active — not shipped
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { status: 'active' }) },
      { path: 'sprints/S-002.md', content: sprintFile('S-002', 'E-001', { gate: 'phase-1' }) },
    ]);
    const r = await runGateResolveCommand('phase-1', { cwd });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('S-001');
  });

  it('--force bypasses precondition check', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { status: 'active' }) },
      { path: 'sprints/S-002.md', content: sprintFile('S-002', 'E-001', { gate: 'phase-1' }) },
    ]);
    const r = await runGateResolveCommand('phase-1', { cwd, force: true });
    expect(r.exitCode).toBe(0);

    const data = await readFm(join(cwd, 'sprints/S-002.md'));
    expect(data.gate).toBeUndefined();
  });

  it('--dry-run shows what would change without writing', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { status: 'shipped' }) },
      { path: 'sprints/S-002.md', content: sprintFile('S-002', 'E-001', { gate: 'phase-1' }) },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-002', sprint_id: 'S-002', order: 0 }]),
      },
    ]);

    const r = await runGateResolveCommand('phase-1', { cwd, dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dry-run');
    expect(r.stdout).toContain('No files written');
    expect(r.stdout).toContain('S-002');

    // dry-run must not have written anything — gate is still resolvable
    const r2 = await runGateResolveCommand('phase-1', { cwd });
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain('resolved');
  });

  it('is idempotent when gate already cleared', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001']) },
      // S-001 has no gate
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-001', { status: 'queued' }) },
    ]);
    // resolving a gate that matches nothing → not found error
    const r = await runGateResolveCommand('phase-1', { cwd });
    expect(r.exitCode).not.toBe(0);
    // no crash, clean error
  });

  it('scopes to epic when epicId provided', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile('E-001', ['S-001']) },
      { path: 'epics/E-002.md', content: epicFile('E-002', ['S-002']) },
      {
        path: 'sprints/S-001.md',
        content: sprintFile('S-001', 'E-001', { gate: 'phase-1', status: 'queued' }),
      },
      {
        path: 'sprints/S-002.md',
        content: sprintFile('S-002', 'E-002', { gate: 'phase-1', status: 'queued' }),
      },
    ]);
    // Resolve only for E-001, with --force to skip precondition
    const r = await runGateResolveCommand('phase-1', { cwd, epicId: 'E-001', force: true });
    expect(r.exitCode).toBe(0);

    const d1 = await readFm(join(cwd, 'sprints/S-001.md'));
    const d2 = await readFm(join(cwd, 'sprints/S-002.md'));
    expect(d1.gate).toBeUndefined(); // resolved
    expect(d2.gate).toBe('phase-1'); // untouched
  });
});
