import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runEpicAddSprintCommand } from '../src/commands/epic.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

function epicFile(sprintIds: string[], status = 'active') {
  return fm({ id: 'E-001', title: 'Test Epic', status, sprints: sprintIds });
}

function sprintFile(id: string, epicId = 'E-001') {
  return fm({
    id,
    title: `Sprint ${id}`,
    epic_id: epicId,
    status: 'planned',
    lane: 'main',
    depends_on: [],
    blocked_by: [],
    allowed_paths: [],
    denied_paths: [],
    generated_paths: [],
    review_required: false,
  });
}

describe('runEpicAddSprintCommand', () => {
  it('adds sprint to empty sprints[] ordering', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([]) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001') },
    ]);

    const r = await runEpicAddSprintCommand('E-001', 'S-001', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added S-001 to E-001');

    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.sprints).toEqual(['S-001']);
  });

  it('appends sprint to non-empty sprints[]', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001') },
      { path: 'sprints/S-002.md', content: sprintFile('S-002') },
    ]);

    const r = await runEpicAddSprintCommand('E-001', 'S-002', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.sprints).toEqual(['S-001', 'S-002']);
  });

  it('is idempotent when sprint already in sprints[]', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001') },
    ]);

    const r = await runEpicAddSprintCommand('E-001', 'S-001', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('already in');

    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.sprints).toEqual(['S-001']);
  });

  it('returns added:false in JSON mode when already present', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001') },
    ]);

    const r = await runEpicAddSprintCommand('E-001', 'S-001', {
      cwd,
      dryRun: false,
      json: true,
    });

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout) as { added: boolean };
    expect(payload.added).toBe(false);
  });

  it('errors when epic not found', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-999') },
    ]);

    const r = await runEpicAddSprintCommand('E-999', 'S-001', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('E-999');
  });

  it('errors when sprint not found', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([]) },
    ]);

    const r = await runEpicAddSprintCommand('E-001', 'S-999', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('S-999');
  });

  it('errors when sprint belongs to a different epic', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([]) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001', 'E-002') },
    ]);

    const r = await runEpicAddSprintCommand('E-001', 'S-001', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('E-002');
  });

  it('dry-run outputs plan but makes no changes', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([]) },
      { path: 'sprints/S-001.md', content: sprintFile('S-001') },
    ]);

    const r = await runEpicAddSprintCommand('E-001', 'S-001', {
      cwd,
      dryRun: true,
      json: false,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dry-run');

    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.sprints).toEqual([]);
  });
});
