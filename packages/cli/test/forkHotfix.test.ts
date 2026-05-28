import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runForkHotfixCommand } from '../src/commands/forkHotfix.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function readFm(file: string): Promise<Record<string, unknown>> {
  return matter(await readFile(file, 'utf8')).data as Record<string, unknown>;
}

/** Parent S-001 active on `main` (scoped to test/**), with a free `ui` lane. */
async function projectWithActiveParent(allowedPaths: string[] = ['test/**']): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'E2E epic', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'E2E suite',
        epic_id: 'E-001',
        status: 'active',
        lane: 'main',
        allowed_paths: allowedPaths,
        base_sha: 'a1b2c3d',
        started_at: '2026-04-25T10:00:00Z',
      }),
    },
    {
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
    },
    { path: 'queues/ui.md', content: fm({ lane: 'ui', slots: [] }) },
  ]);
}

describe('runForkHotfixCommand', () => {
  it('places the hotfix on a free lane and records parent context', async () => {
    const cwd = await projectWithActiveParent();
    const r = await runForkHotfixCommand({
      cwd,
      parentId: 'S-001',
      description: 'engagement selector unusable',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { lane: string; forkedFrom: string; parentBaseSha: string; sprintFile: string };
      next_actions: string[];
    };
    expect(env.ok).toBe(true);
    expect(env.data.lane).toBe('ui');
    expect(env.data.forkedFrom).toBe('S-001');
    expect(env.data.parentBaseSha).toBe('a1b2c3d');

    const data = await readFm(env.data.sprintFile);
    const extras = data.extras as Record<string, unknown>;
    expect(extras.forked_from).toBe('S-001');
    expect(extras.parent_base_sha).toBe('a1b2c3d');
  });

  it('inherits the parent allowed_paths as the hotfix scope', async () => {
    const cwd = await projectWithActiveParent(['test/**']);
    const r = await runForkHotfixCommand({
      cwd,
      parentId: 'S-001',
      description: 'fix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    const env = JSON.parse(r.stdout) as { data: { sprintFile: string; unscoped: boolean } };
    expect(env.data.unscoped).toBe(false);
    const data = await readFm(env.data.sprintFile);
    expect(data.allowed_paths).toEqual(['test/**']);
  });

  it('--allow overrides the inherited parent scope', async () => {
    const cwd = await projectWithActiveParent(['test/**']);
    const r = await runForkHotfixCommand({
      cwd,
      parentId: 'S-001',
      description: 'fix',
      acceptanceCriteria: [],
      allowPaths: ['src/ui/**'],
      denyPaths: [],
      json: true,
    });
    const env = JSON.parse(r.stdout) as { data: { sprintFile: string } };
    const data = await readFm(env.data.sprintFile);
    expect(data.allowed_paths).toEqual(['src/ui/**']);
  });

  it('suggests committing the hotfix then rebasing the parent', async () => {
    const cwd = await projectWithActiveParent();
    const r = await runForkHotfixCommand({
      cwd,
      parentId: 'S-001',
      description: 'fix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    const env = JSON.parse(r.stdout) as { next_actions: string[] };
    expect(env.next_actions.some((a) => a.includes('rk close'))).toBe(true);
    expect(env.next_actions).toContain('rk rebase-sprint S-001 --to HEAD');
  });

  it('warns when the parent is unscoped and no --allow is given', async () => {
    const cwd = await projectWithActiveParent([]);
    const r = await runForkHotfixCommand({
      cwd,
      parentId: 'S-001',
      description: 'fix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('UNSCOPED');
  });

  it('errors when the parent sprint does not exist', async () => {
    const cwd = await projectWithActiveParent();
    const r = await runForkHotfixCommand({
      cwd,
      parentId: 'S-999',
      description: 'fix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not found');
  });
});
