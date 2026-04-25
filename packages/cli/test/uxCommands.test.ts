import { afterAll, describe, expect, it } from 'vitest';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runExplainCommand } from '../src/commands/explain.js';
import { runFixCommand } from '../src/commands/fix.js';
import { runInitCommand } from '../src/commands/init.js';
import { runInspectCommand } from '../src/commands/inspect.js';
import { runNextCommand } from '../src/commands/next.js';
import { runOpenCommand } from '../src/commands/open.js';
import { runValidateCommand } from '../src/commands/validate.js';
import { cleanupAllFixtures, makeFixture } from './helpers/fixture.js';

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
    expect(JSON.parse(next.stdout)).toMatchObject({ result: 'runnable', sprintId: 'S-002' });
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

  it('opens an entity path or prints it in non-interactive contexts', async () => {
    const cwd = await makeFixture([]);
    await runInitCommand({ cwd, example: true });
    const result = await runOpenCommand({ cwd, id: 'S-002' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('S-002.md');
  });

  it('previews safe fixes and refuses applying fixes in v0', async () => {
    const cwd = await makeFixture([]);
    const preview = await runFixCommand({ cwd, preview: true });
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Available safe fixes:');
    expect(preview.stdout).toContain('repokernel init');

    const apply = await runFixCommand({ cwd, preview: false });
    expect(apply.exitCode).toBe(2);
    expect(apply.stderr).toContain('only supports --preview');
  });
});
