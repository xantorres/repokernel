import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runTaskInspectCommand,
  runTaskListCommand,
  runTaskStatusCommand,
} from '../src/commands/fastpath/index.js';
import type { TaskAlias } from '../src/commands/fastpath/types.js';
import { cleanupAllFixtures, defaultConfigYaml, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const NOW = '2026-04-29T00:00:00.000Z';

function alias(overrides: Partial<TaskAlias>): TaskAlias {
  return {
    id: 'T-001',
    epic_id: 'E-001',
    sprint_id: 'S-001',
    source: 'inline',
    title: 'Test task',
    created_at: NOW,
    closed_at: null,
    status: 'active',
    ...overrides,
  } as TaskAlias;
}

async function project(aliases: readonly TaskAlias[] = []): Promise<string> {
  const cwd = await makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }]);
  if (aliases.length > 0) {
    await mkdir(join(cwd, '.repokernel', 'tasks'), { recursive: true });
    for (const a of aliases) {
      await writeFile(
        join(cwd, '.repokernel', 'tasks', `${a.id}.json`),
        `${JSON.stringify(a, null, 2)}\n`,
        'utf8',
      );
    }
  }
  return cwd;
}

describe('runTaskListCommand', () => {
  it('returns "(no tasks)" when the alias dir is empty', async () => {
    const cwd = await project();
    const r = await runTaskListCommand({ cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(no tasks)');
  });

  it('lists every alias by id, status, epic, sprint, title', async () => {
    const cwd = await project([
      alias({ id: 'T-001', status: 'shipped', title: 'Hotfix auth' }),
      alias({
        id: 'T-002',
        status: 'review',
        epic_id: 'E-002',
        sprint_id: 'S-002',
        title: 'Fix queue UI',
      }),
    ]);
    const r = await runTaskListCommand({ cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('T-001');
    expect(r.stdout).toContain('T-002');
    expect(r.stdout).toContain('Hotfix auth');
    expect(r.stdout).toContain('Fix queue UI');
  });

  it('emits valid JSON in deterministic id order with --json', async () => {
    const cwd = await project([
      alias({ id: 'T-002', status: 'shipped' }),
      alias({ id: 'T-001', status: 'active' }),
    ]);
    const r = await runTaskListCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as TaskAlias[];
    expect(parsed.map((a) => a.id)).toEqual(['T-001', 'T-002']);
  });

  it('filters by --status when provided', async () => {
    const cwd = await project([
      alias({ id: 'T-001', status: 'shipped' }),
      alias({ id: 'T-002', status: 'review' }),
      alias({ id: 'T-003', status: 'active' }),
    ]);
    const r = await runTaskListCommand({ cwd, status: 'review', json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as TaskAlias[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('T-002');
  });

  it('returns the empty-status message when filter matches nothing', async () => {
    const cwd = await project([alias({ id: 'T-001', status: 'shipped' })]);
    const r = await runTaskListCommand({ cwd, status: 'cancelled', json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(no tasks in status "cancelled")');
  });

  it('rejects an invalid --status value', async () => {
    const cwd = await project();
    const r = await runTaskListCommand({
      cwd,
      status: 'pending' as TaskAlias['status'],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid --status');
  });
});

describe('runTaskStatusCommand', () => {
  it('rejects an invalid task ID input', async () => {
    const cwd = await project();
    const r = await runTaskStatusCommand('not-a-task', { cwd, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not a valid task ID');
  });

  it('returns a not-found error pointing at `rk task list`', async () => {
    const cwd = await project();
    const r = await runTaskStatusCommand('T-999', { cwd, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no task alias found for T-999');
    expect(r.stderr).toContain('rk task list');
  });

  it('prints status, epic, sprint, source, created_at for an active task', async () => {
    const cwd = await project([alias({ id: 'T-001', status: 'active' })]);
    const r = await runTaskStatusCommand('T-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('T-001');
    expect(r.stdout).toContain('Test task');
    expect(r.stdout).toContain('active');
    expect(r.stdout).toContain('E-001');
    expect(r.stdout).toContain('S-001');
    expect(r.stdout).toContain('inline');
    expect(r.stdout).toContain(NOW);
  });

  it('includes Closed and Review SHA when present', async () => {
    const cwd = await project([
      alias({
        id: 'T-001',
        status: 'shipped',
        closed_at: '2026-04-30T12:00:00.000Z',
        review_sha: 'abcdef0123456789',
      }),
    ]);
    const r = await runTaskStatusCommand('T-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Closed');
    expect(r.stdout).toContain('2026-04-30T12:00:00.000Z');
    expect(r.stdout).toContain('Review SHA');
    expect(r.stdout).toContain('abcdef012345');
  });

  it('emits the full alias as JSON with --json', async () => {
    const cwd = await project([alias({ id: 'T-001', status: 'review' })]);
    const r = await runTaskStatusCommand('T-001', { cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as TaskAlias;
    expect(parsed.id).toBe('T-001');
    expect(parsed.status).toBe('review');
  });

  it('normalises non-padded ids (`T-1` → T-001)', async () => {
    const cwd = await project([alias({ id: 'T-001', status: 'review' })]);
    const r = await runTaskStatusCommand('T-1', { cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as TaskAlias;
    expect(parsed.id).toBe('T-001');
  });
});

describe('runTaskInspectCommand', () => {
  it('rejects an invalid task ID input', async () => {
    const cwd = await project();
    const r = await runTaskInspectCommand('bogus', { cwd, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not a valid task ID');
  });

  it('returns a not-found error pointing at `rk task list`', async () => {
    const cwd = await project();
    const r = await runTaskInspectCommand('T-999', { cwd, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no task alias found for T-999');
    expect(r.stderr).toContain('rk task list');
  });

  it('prints alias and resolved file paths', async () => {
    const cwd = await project([alias({ id: 'T-001', status: 'review' })]);
    const r = await runTaskInspectCommand('T-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('T-001');
    expect(r.stdout).toContain('Files:');
    expect(r.stdout).toContain('alias');
    // Sprint/review may be `(not found)` because we did not scaffold the full
    // project graph — that's acceptable inspect output.
    // Note: drop \s+ — ANSI bold reset code sits between the label and spaces.
    expect(r.stdout).toMatch(/sprint/);
    expect(r.stdout).toMatch(/review/);
  });

  it('emits a JSON envelope with alias + paths shape', async () => {
    const cwd = await project([alias({ id: 'T-001', status: 'review' })]);
    const r = await runTaskInspectCommand('T-001', { cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      alias: TaskAlias;
      paths: { alias: string; sprint: string | null; review: string | null };
    };
    expect(parsed.alias.id).toBe('T-001');
    expect(parsed.paths).toBeDefined();
    expect(parsed.paths.alias).toContain('T-001.json');
  });

  it('still inspects a cancelled task gracefully', async () => {
    const cwd = await project([alias({ id: 'T-001', status: 'cancelled', closed_at: NOW })]);
    const r = await runTaskInspectCommand('T-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('cancelled');
    expect(r.stdout).toContain('Closed');
  });
});
