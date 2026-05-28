import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runHotfixCommand } from '../src/commands/hotfix.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(): Promise<string> {
  return makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }]);
}

/** A project with S-001 active on `main` and an empty, free `ui` lane. */
async function projectWithBusyMainAndFreeUi(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Long sprint',
        epic_id: 'E-001',
        status: 'active',
        lane: 'main',
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

describe('runHotfixCommand', () => {
  it('rejects empty description', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: '   ',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('<description> is required');
  });

  it('creates a T-NNN fastpath task with [hotfix] prefix in body', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'Patch broken auth middleware',
      acceptanceCriteria: ['Middleware allows valid tokens'],
      denyPaths: ['src/legacy/**'],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      taskId: string;
      sprintFile: string;
      epicFile: string;
      kind: string;
    };
    expect(obj.kind).toBe('hotfix');
    expect(obj.taskId).toMatch(/^T-\d+$/);
    const sprintBody = await readFile(obj.sprintFile, 'utf8');
    expect(sprintBody).toContain('[hotfix]');
    expect(sprintBody).toContain('Patch broken auth middleware');
  });

  it('emits commit hint with the T-NNN id in non-JSON output', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'CI timing fix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/T-\d+/);
    expect(r.stdout).toContain('git commit');
    expect(r.stdout).toContain('rk close');
  });

  it('synthesized sprint has review_required: false so rk close T-NNN works without review', async () => {
    const cwd = await project();
    const matter = (await import('gray-matter')).default;
    const r = await runHotfixCommand({
      cwd,
      description: 'No-review hotfix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { sprintFile: string };
    const data = matter(await readFile(obj.sprintFile, 'utf8')).data;
    expect(data.review_required).toBe(false);
  });

  it('single-quotes the commit hint so shell metacharacters are inert', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'Fix $(rm -rf x) `whoami` "auth"',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    // Whole message is single-quoted; the dangerous substrings survive as
    // literal characters inside the quotes rather than as a double-quoted
    // string where $() / backticks would execute when pasted.
    expect(r.stdout).toContain('git commit -m \'fix: Fix $(rm -rf x) `whoami` "auth"');
    expect(r.stdout).not.toContain('git commit -m "');
  });

  it('returns runtime error when no config found', async () => {
    const cwd = await makeFixture([]); // no repokernel.config.yaml
    const r = await runHotfixCommand({
      cwd,
      description: 'fix something',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not found');
  });

  it('returns runtime error when config YAML is malformed', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: 'invalid: yaml: ][' },
    ]);
    const r = await runHotfixCommand({
      cwd,
      description: 'fix something',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid');
  });

  it('defaults to the default lane when --lane is omitted (non-breaking)', async () => {
    const cwd = await projectWithBusyMainAndFreeUi();
    const r = await runHotfixCommand({
      cwd,
      description: 'default lane',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { lane: string; laneFellBackToDefault: boolean };
    expect(obj.lane).toBe('main');
    expect(obj.laneFellBackToDefault).toBe(false);
  });

  it('--lane <named> places the hotfix on that lane', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'named lane',
      acceptanceCriteria: [],
      denyPaths: [],
      lane: 'ui',
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { lane: string; sprintFile: string };
    expect(obj.lane).toBe('ui');
    const data = matter(await readFile(obj.sprintFile, 'utf8')).data;
    expect(data.lane).toBe('ui');
  });

  it('rejects a --lane that would escape the queues directory', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'traversal',
      acceptanceCriteria: [],
      denyPaths: [],
      lane: '../sprints/S-001',
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid --lane');
  });

  it('--lane auto skips the busy default lane and picks a free one', async () => {
    const cwd = await projectWithBusyMainAndFreeUi();
    const r = await runHotfixCommand({
      cwd,
      description: 'urgent fix',
      acceptanceCriteria: [],
      denyPaths: [],
      lane: 'auto',
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { lane: string; laneFellBackToDefault: boolean };
    expect(obj.lane).toBe('ui');
    expect(obj.laneFellBackToDefault).toBe(false);
  });

  it('--lane auto falls back to the default lane and flags it when none free', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Busy',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          base_sha: 'a1b2c3d',
          started_at: '2026-04-25T10:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    const r = await runHotfixCommand({
      cwd,
      description: 'no free lane',
      acceptanceCriteria: [],
      denyPaths: [],
      lane: 'auto',
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no free lane');
  });

  it('warns that an unscoped hotfix may touch any path when no --allow given', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'unscoped',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('UNSCOPED');
  });

  it('--allow scopes the hotfix: sets allowed_paths and suppresses the unscoped warning', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'scoped',
      acceptanceCriteria: [],
      denyPaths: [],
      allowPaths: ['src/auth/**'],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { unscoped: boolean; sprintFile: string };
    expect(obj.unscoped).toBe(false);
    const data = matter(await readFile(obj.sprintFile, 'utf8')).data;
    expect(data.allowed_paths).toEqual(['src/auth/**']);
  });

  it('two consecutive hotfixes yield distinct T-NNN ids', async () => {
    const cwd = await project();
    const r1 = await runHotfixCommand({
      cwd,
      description: 'first',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    const r2 = await runHotfixCommand({
      cwd,
      description: 'second',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    const o1 = JSON.parse(r1.stdout) as { taskId: string };
    const o2 = JSON.parse(r2.stdout) as { taskId: string };
    expect(o1.taskId).not.toBe(o2.taskId);
  });
});
