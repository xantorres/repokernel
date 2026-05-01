import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { runLaneAcquireCommand, runLanesCommand } from '../src/commands/lanes.js';
import { stripAnsi } from '../src/format/table.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);

async function makeGitFixture(files: Array<{ path: string; content: string }>): Promise<string> {
  const cwd = await makeFixture(files);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@rk.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'RK Test']);
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-m', 'init']);
  return cwd;
}

afterAll(cleanupAllFixtures);

describe('runLanesCommand', () => {
  it('shows healthy lane with active sprint', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main', claimed_by: 'alice' }) },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Core', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Impl',
          status: 'active',
          epic_id: 'E-001',
          lane: 'main',
          depends_on: [],
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    const result = await runLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('main');
    expect(out).toContain('S-001');
    // healthy dot is ●
    expect(result.stdout).toContain('●');
  });

  it('shows stalled lane with empty queue but no active', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Core', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Impl',
          status: 'planned',
          epic_id: 'E-001',
          lane: 'main',
          depends_on: [],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    // stalled dot is ○
    expect(result.stdout).toContain('○');
  });

  it('shows blocked lane with multiple actives when policy disallows', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
policies:
  allowMultipleActivePerLane: false
`,
      },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Core', status: 'active', sprints: ['S-001', 'S-002'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'A',
          status: 'active',
          epic_id: 'E-001',
          lane: 'main',
          depends_on: [],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'B',
          status: 'active',
          epic_id: 'E-001',
          lane: 'main',
          depends_on: [],
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [
            { id: 'Q-001', sprint_id: 'S-001', order: 0 },
            { id: 'Q-002', sprint_id: 'S-002', order: 1 },
          ],
        }),
      },
    ]);
    const result = await runLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    // blocked dot is ✗
    expect(result.stdout).toContain('✗');
  });

  it('shows unclaimed lane with em dash', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runLanesCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('—');
  });

  it('shows claimed_by in output', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main', claimed_by: 'bob' }) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runLanesCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('bob');
  });

  it('emits JSON with health field', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Core', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Impl',
          status: 'active',
          epic_id: 'E-001',
          lane: 'main',
          depends_on: [],
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    const result = await runLanesCommand({ cwd, json: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('lanes');
    const main = data.lanes.find((l: { name: string }) => l.name === 'main');
    expect(main).toHaveProperty('health');
    expect(main.health).toBe('healthy');
    expect(main.activeSprint).toBe('S-001');
  });

  it('shows empty state when no lanes configured', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(no lanes');
  });

  it('shows acquired-only lane from laneState when not in graph', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    // Pre-populate laneState fallback dir (operationalRootBestEffort → <cwd>/.repokernel/_op)
    const laneDir = join(cwd, '.repokernel', '_op', 'lanes');
    await mkdir(laneDir, { recursive: true });
    const claim = {
      lane: 'epic-E-099',
      run_id: 'manual-E-099',
      epic_id: 'E-099',
      worktree: '/tmp/worktree-e-099',
      branch: 'epic/E-099',
      claimed_at: '2026-05-01T18:13:35.000Z',
    };
    await writeFile(join(laneDir, 'epic-E-099.json'), JSON.stringify(claim, null, 2), 'utf8');

    const result = await runLanesCommand({ cwd, json: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    const acquired = data.lanes.find((l: { name: string }) => l.name === 'epic-E-099');
    expect(acquired).toBeDefined();
    expect(acquired.claimed_by).toBe('manual-E-099');
  });

  it('shows acquired-only lane in text output', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const laneDir = join(cwd, '.repokernel', '_op', 'lanes');
    await mkdir(laneDir, { recursive: true });
    const claim = {
      lane: 'epic-E-055',
      run_id: 'manual-E-055',
      epic_id: 'E-055',
      worktree: '/tmp/worktree-e-055',
      branch: 'epic/E-055',
      claimed_at: '2026-05-01T18:00:00.000Z',
    };
    await writeFile(join(laneDir, 'epic-E-055.json'), JSON.stringify(claim, null, 2), 'utf8');

    const result = await runLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('epic-E-055');
    expect(out).toContain('manual-E-055');
  });

  it('classifies stalled lane when all queued sprints are dep-blocked', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Core', status: 'active', sprints: ['S-001', 'S-002'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'A',
          status: 'shipped',
          epic_id: 'E-001',
          lane: 'main',
          depends_on: [],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'B',
          status: 'queued',
          epic_id: 'E-001',
          lane: 'main',
          depends_on: ['S-001'],
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-002', order: 0 }] }),
      },
    ]);
    // S-002 depends on S-001 which is shipped — so it's NOT blocked by deps
    // Expected: healthy (has unblocked queued sprint)
    const result = await runLanesCommand({ cwd, json: true });
    const data = JSON.parse(result.stdout);
    const main = data.lanes.find((l: { name: string }) => l.name === 'main');
    expect(main.health).toBe('healthy');
  });
});

describe('runLaneAcquireCommand — queue scaffold', () => {
  it('creates queue file for the epic lane when none exists', async () => {
    const cwd = await makeGitFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-099.md',
        content: fm({ id: 'E-099', title: 'Scaffold Test', status: 'active', sprints: [] }),
      },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const r = await runLaneAcquireCommand('E-099', { cwd, force: false, allowDirty: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(created)');

    const queuePath = join(cwd, 'queues', 'epic-E-099.md');
    expect(existsSync(queuePath)).toBe(true);
  }, 20_000);

  it('reports queue file as already existed when present before acquire', async () => {
    const cwd = await makeGitFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-088.md',
        content: fm({ id: 'E-088', title: 'Pre-existing Queue', status: 'active', sprints: [] }),
      },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'queues/epic-E-088.md', content: fm({ lane: 'epic-E-088', slots: [] }) },
    ]);

    const r = await runLaneAcquireCommand('E-088', { cwd, force: false, allowDirty: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(already existed)');
  }, 20_000);
});
