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
    ]);
    const result = await runValidateCommand({ cwd, json: false, failOn: 'P1' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No findings.');
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
    ]);
    const result = await runValidateCommand({ cwd, json: true, failOn: 'P1' });
    expect(result.exitCode).toBe(0);
    const obj = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(obj.findings).toEqual([]);
    expect(obj.threshold).toBe('P1');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('exit 2 when config is missing', async () => {
    const cwd = await makeFixture([]);
    const result = await runValidateCommand({ cwd, json: false, failOn: 'P1' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('config not found');
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
