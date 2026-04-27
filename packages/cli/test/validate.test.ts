import { afterAll, describe, expect, it } from 'vitest';
import { runValidateCommand } from '../src/commands/validate.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

describe('runValidateCommand', () => {
  it('exit 0 on a clean project', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runValidateCommand({ cwd, json: false, failOn: 'P1' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('RepoKernel validation');
    expect(result.stdout).toContain('No findings.');
    expect(result.stdout).toContain('Health: clean');
  });

  it('exit 1 when threshold is breached (P1 by default)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-999',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    const result = await runValidateCommand({ cwd, json: false, failOn: 'P1' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('SPRINT_WITHOUT_EPIC');
  });

  it('emits canonical JSON when --json', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runValidateCommand({ cwd, json: true, failOn: 'P1' });
    expect(result.exitCode).toBe(0);
    const obj = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(obj.findings).toEqual([]);
    expect(obj.threshold).toBe('P1');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('filters findings by severity but bases exit code on full project health', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-999',
          status: 'planned',
          lane: 'main',
          mystery: true,
        }),
      },
    ]);
    const result = await runValidateCommand({
      cwd,
      json: true,
      failOn: 'P1',
      filters: { only: 'P3' },
    });
    expect(result.exitCode).toBe(1);
    const obj = JSON.parse(result.stdout) as { findings: Array<{ severity: string }> };
    expect(obj.findings).toHaveLength(1);
    expect(obj.findings[0]?.severity).toBe('P3');
  });

  it('tells humans when filters hide threshold-breaching findings', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-999',
          status: 'planned',
          lane: 'main',
          mystery: true,
        }),
      },
    ]);
    const result = await runValidateCommand({
      cwd,
      json: false,
      failOn: 'P1',
      filters: { only: 'P3' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('UNKNOWN_FRONTMATTER_FIELD');
    expect(result.stdout).not.toContain('SPRINT_WITHOUT_EPIC');
    expect(result.stdout).toContain('Threshold P1 breached by findings hidden by filters.');
  });

  it('rejects --open with --json', async () => {
    const cwd = await makeFixture([]);
    const result = await runValidateCommand({ cwd, json: true, open: true, failOn: 'P1' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('cannot be used with --json');
  });

  it('uses policies.severityFailThreshold when --fail-on is omitted', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}policies:
  severityFailThreshold: P2
`,
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T11:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'someone',
          created_at: '2026-04-25T11:30:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    const result = await runValidateCommand({ cwd, json: true });
    const obj = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(result.exitCode).toBe(1);
    expect(obj.threshold).toBe('P2');
  });

  it('CONFIG_REQUIRES_NOT_MET P1 when installed version below requires:', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}requires: ">=99.0.0"\n`,
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runValidateCommand({
      cwd,
      json: true,
      failOn: 'P1',
      runtimeVersion: '1.0.0',
    });
    const obj = JSON.parse(result.stdout) as {
      findings: Array<{ code: string; severity: string }>;
    };
    expect(result.exitCode).toBe(1);
    const finding = obj.findings.find((f) => f.code === 'CONFIG_REQUIRES_NOT_MET');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('P1');
  });

  it('no CONFIG_REQUIRES_NOT_MET when version satisfies requires:', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}requires: ">=1.0.0"\n`,
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runValidateCommand({
      cwd,
      json: true,
      failOn: 'P1',
      runtimeVersion: '1.0.0',
    });
    const obj = JSON.parse(result.stdout) as { findings: Array<{ code: string }> };
    expect(result.exitCode).toBe(0);
    expect(obj.findings.every((f) => f.code !== 'CONFIG_REQUIRES_NOT_MET')).toBe(true);
  });

  it('no CONFIG_REQUIRES_NOT_MET when requires: absent', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runValidateCommand({
      cwd,
      json: true,
      failOn: 'P1',
      runtimeVersion: '1.0.0',
    });
    const obj = JSON.parse(result.stdout) as { findings: Array<{ code: string }> };
    expect(result.exitCode).toBe(0);
    expect(obj.findings.every((f) => f.code !== 'CONFIG_REQUIRES_NOT_MET')).toBe(true);
  });

  it('exit 2 when config is missing', async () => {
    const cwd = await makeFixture([]);
    const result = await runValidateCommand({ cwd, json: false, failOn: 'P1' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('config not found');
  });

  it('review extras: fields do not produce UNKNOWN_FRONTMATTER_FIELD', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T11:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'agent-a',
          created_at: '2026-04-25T11:30:00Z',
          extras: {
            reviewers_run: ['agent-a'],
            iterations: 1,
            cost_usd: 0.42,
            grandfathered: false,
            reviewer_count: 1,
          },
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    const result = await runValidateCommand({ cwd, json: true, failOn: 'P1' });
    const obj = JSON.parse(result.stdout) as { findings: Array<{ code: string }> };
    expect(result.exitCode).toBe(0);
    expect(obj.findings.every((f) => f.code !== 'UNKNOWN_FRONTMATTER_FIELD')).toBe(true);
  });

  it('--fail-on P0 lets P1 through with exit 0', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-999',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    const result = await runValidateCommand({ cwd, json: false, failOn: 'P0' });
    expect(result.exitCode).toBe(0);
  });
});
