import { afterAll, describe, expect, it } from 'vitest';
import { runReportCommand } from '../src/commands/report.js';
import { stripAnsi } from '../src/format/table.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function reportFixture(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'Visual <Report>',
        status: 'active',
        sprints: ['S-001', 'S-002'],
      }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Build dashboard',
        epic_id: 'E-001',
        status: 'active',
        lane: 'main',
        allowed_paths: ['src/**'],
        started_at: '2026-04-29T10:00:00Z',
        base_sha: 'a1b2c3d',
      }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({
        id: 'S-002',
        title: 'Ship report',
        epic_id: 'E-001',
        status: 'queued',
        lane: 'main',
        allowed_paths: ['docs/**'],
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
    { path: 'lanes/main.md', content: fm({ name: 'main' }) },
  ]);
}

describe('rk report', () => {
  it('prints headline + EPICS dashboard with active sprints under their epic', async () => {
    const cwd = await reportFixture();
    const result = await runReportCommand({ cwd, json: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const out = stripAnsi(result.stdout);
    expect(out).toContain('demo');
    expect(out).toContain('1 epic');
    expect(out).toContain('2 sprints');
    expect(out).toContain('clean');
    expect(out).toContain('NEXT');
    expect(out).toContain('S-001');
    expect(out).toContain('Build dashboard');
    expect(out).toMatch(/^EPICS \(/m);
    expect(out).toContain('E-001');
    expect(out).toContain('Visual <Report>');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('<!doctype');
    expect(out).not.toContain('FINDINGS');
  });

  it('only lists active sprints under each epic by default; --all expands all sprints', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Epic',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Already shipped',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Currently active',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          allowed_paths: ['src/**'],
          started_at: '2026-04-29T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);

    const lean = stripAnsi((await runReportCommand({ cwd, json: false })).stdout);
    expect(lean).toContain('Currently active');
    expect(lean).not.toContain('Already shipped');

    const expanded = stripAnsi((await runReportCommand({ cwd, json: false, all: true })).stdout);
    expect(expanded).toContain('Currently active');
    expect(expanded).toContain('Already shipped');
  });

  it('aggregates findings by code in default view; expands per-entity with --all', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'orphan one',
          epic_id: 'E-999',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'orphan two',
          epic_id: 'E-999',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);

    const lean = stripAnsi((await runReportCommand({ cwd, json: false })).stdout);
    expect(lean).toContain('FINDINGS');
    expect(lean).toContain('SPRINT_WITHOUT_EPIC');
    expect(lean).toContain('×2');
    expect(lean).toContain('rk validate');
    expect(lean).not.toContain('[S-001]');
    expect(lean).not.toContain('[S-002]');

    const expanded = stripAnsi((await runReportCommand({ cwd, json: false, all: true })).stdout);
    expect(expanded).toContain('SPRINT_WITHOUT_EPIC');
    expect(expanded).toContain('[S-001]');
    expect(expanded).toContain('[S-002]');
  });

  it('NEXT line explains why when no runnable sprint exists', async () => {
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
          title: 'planned only',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);

    const out = stripAnsi((await runReportCommand({ cwd, json: false })).stdout);
    expect(out).toContain('NEXT');
    expect(out).toMatch(/NEXT\s+(none|blocked)/);
  });

  it('emits structured JSON when requested', async () => {
    const cwd = await reportFixture();
    const result = await runReportCommand({ cwd, json: true });

    expect(result.exitCode).toBe(0);
    const obj = JSON.parse(result.stdout) as {
      project: { id: string; name: string };
      counts: { epics: number; sprints: number; findings: number };
      next: { result: string; sprintId: string | null; lane: string };
      epics: Array<{ id: string; title: string }>;
      sprints: Array<{ id: string; status: string }>;
      findings: unknown[];
      maxSeverity: string | null;
    };
    expect(obj.project).toMatchObject({ id: 'demo', name: 'Demo' });
    expect(obj.counts.epics).toBe(1);
    expect(obj.counts.sprints).toBe(2);
    expect(obj.epics.map((e) => e.id)).toEqual(['E-001']);
    expect(obj.sprints.map((s) => s.id)).toEqual(['S-001', 'S-002']);
    expect(obj.findings).toEqual([]);
    expect(obj.maxSeverity).toBeNull();
    expect(obj.next.lane).toBe('main');
  });
});
