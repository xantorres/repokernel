import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runReportCommand } from '../src/commands/report.js';
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
  it('writes a local HTML report with escaped project state', async () => {
    const cwd = await reportFixture();
    const result = await runReportCommand({ cwd, out: 'rk-report.html', json: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rk-report.html');

    const html = await readFile(join(cwd, 'rk-report.html'), 'utf8');
    expect(html).toContain('RepoKernel Report');
    expect(html).toContain('Visual &lt;Report&gt;');
    expect(html).toContain('S-001');
    expect(html).toContain('Build dashboard');
    expect(html).toContain('main');
  });

  it('emits JSON when requested', async () => {
    const cwd = await reportFixture();
    const result = await runReportCommand({ cwd, out: 'rk-report.html', json: true });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      report: { path: join(cwd, 'rk-report.html') },
    });
  });
});
