import { afterAll, describe, expect, it } from 'vitest';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runExplainCommand } from '../src/commands/explain.js';
import { runFixCommand } from '../src/commands/fix.js';
import { runInitCommand } from '../src/commands/init.js';
import { runInspectCommand } from '../src/commands/inspect.js';
import { runNextCommand } from '../src/commands/next.js';
import { runOpenCommand } from '../src/commands/open.js';
import { runValidateCommand } from '../src/commands/validate.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

describe('UX commands', () => {
  it('explains validation codes', () => {
    const result = runExplainCommand({ code: 'ACTIVE_SPRINT_MISSING_BASE_SHA' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Severity:');
    expect(result.stdout).toContain('Why it matters:');
    expect(result.stdout).toContain('base_sha');
  });

  it('diagnoses missing setup without config', async () => {
    const cwd = await makeFixture([]);
    const result = await runDoctorCommand({ cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('RepoKernel setup is incomplete.');
    expect(result.stdout).toContain('Missing config file');
    expect(result.stdout).toContain('repokernel init');
  });

  it('initializes a working example that validates and resolves next', async () => {
    const cwd = await makeFixture([]);
    const init = await runInitCommand({ cwd, example: true });
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain('RepoKernel initialized.');
    expect(init.stdout).toContain('.repokernel/plan/sprints/S-002.md');

    const validate = await runValidateCommand({ cwd, json: true, failOn: 'P1' });
    expect(validate.exitCode).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({ findings: [] });

    const next = await runNextCommand({ cwd, json: true });
    expect(next.exitCode).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({
      ok: true,
      data: { result: 'runnable', sprint_id: 'S-002' },
    });
  });

  it('inspects a sprint in the initialized example', async () => {
    const cwd = await makeFixture([]);
    await runInitCommand({ cwd, example: true });
    const result = await runInspectCommand({ cwd, id: 'S-002' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('S-002: Implement active starter work');
    expect(result.stdout).toContain('Status:      active');
    expect(result.stdout).toContain('S-001 shipped');
  });

  it('returns exit 1 for missing inspect entities', async () => {
    const cwd = await makeFixture([]);
    await runInitCommand({ cwd, example: true });
    const result = await runInspectCommand({ cwd, id: 'S-999' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('entity not found: S-999');
    expect(result.stdout).toContain('rk validate');
    expect(result.stderr).toBe('');
  });

  it('opens an entity path or prints it in non-interactive contexts', async () => {
    const cwd = await makeFixture([]);
    await runInitCommand({ cwd, example: true });
    const result = await runOpenCommand({ cwd, id: 'S-002' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('S-002.md');
  });

  it('returns exit 1 for missing open entities', async () => {
    const cwd = await makeFixture([]);
    await runInitCommand({ cwd, example: true });
    const result = await runOpenCommand({ cwd, id: 'S-999' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('entity not found: S-999');
    expect(result.stdout).toContain('repokernel status');
    expect(result.stderr).toBe('');
  });

  it('previews safe fixes and requires --preview or --apply', async () => {
    const cwd = await makeFixture([]);
    const preview = await runFixCommand({ cwd, preview: true, apply: false, yes: false });
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Available safe fixes:');
    expect(preview.stdout).toContain('repokernel init');

    const neither = await runFixCommand({ cwd, preview: false, apply: false, yes: false });
    expect(neither.exitCode).toBe(2);
    expect(neither.stderr).toContain('pass --preview or --apply');
  });

  it('classifies shipped-sprint queue removals as safe fixes (mechanical)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'e', status: 'active', sprints: ['S-001'] }),
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
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    const result = await runFixCommand({ cwd, preview: true, apply: false, yes: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Available safe fixes:');
    expect(result.stdout).toContain('Remove S-001 from queue');
    expect(result.stdout).not.toContain('Manual suggestions:');
  });
});
