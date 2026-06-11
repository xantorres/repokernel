/**
 * Unit tests for rk run inspect / abort / logs and limit_reached resume behavior.
 *
 * Uses real temp dirs + mocked operationalRoot (no git repo needed).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HaltReason, Run } from '@repokernel/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runRunAbortCommand,
  runRunCommand,
  runRunInspectCommand,
  runRunLogsCommand,
} from '../src/commands/run.js';
import { operationalRoot } from '../src/lifecycle/controlPaths.js';
import { createRun, loadRun } from '../src/lifecycle/runState.js';
import { eid, runId, sid } from './helpers/brand.js';

vi.mock('../src/lifecycle/controlPaths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lifecycle/controlPaths.js')>();
  return {
    ...actual,
    isWorktreeCheckout: vi.fn().mockResolvedValue(false),
    operationalRoot: vi.fn(),
  };
});

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'rk-subcmd-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    id: runId('RUN-001'),
    epic_id: eid('E-001'),
    lane: 'main',
    status: 'paused',
    mode: 'assisted',
    agent: 'fake',
    worktree: '/tmp/wt',
    branch: 'main',
    started_at: '2026-04-26T10:00:00Z',
    ended_at: null,
    current_sprint: null,
    completed_sprints: [],
    halt_reason: null,
    limit: null,
    sprint_count: 1,
    execution_strategy: 'sequential',
    wave_index: -1,
    active_sprints: [],
    parallel_workers: [],
    abort_requested: false,
    ...overrides,
  };
}

async function makeOpRoot(): Promise<string> {
  const opRoot = join(tmpRoot, 'op');
  await mkdir(opRoot, { recursive: true });
  vi.mocked(operationalRoot).mockResolvedValue(opRoot);
  return opRoot;
}

// — inspect —

describe('rk run inspect', () => {
  it('shows run info and next step for awaiting_review halt', async () => {
    const opRoot = await makeOpRoot();
    const run = baseRun({
      status: 'paused',
      halt_reason: { reason: 'awaiting_review' },
      current_sprint: sid('S-001'),
    });
    await createRun(run, opRoot);

    const result = await runRunInspectCommand('RUN-001', { cwd: tmpRoot, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('RUN-001');
    expect(result.stdout).toContain('awaiting_review');
    expect(result.stdout).toContain('review-verdict');
    expect(result.stdout).toContain('--resume RUN-001');
  });

  it('shows next step for limit_reached halt', async () => {
    const opRoot = await makeOpRoot();
    const run = baseRun({ status: 'paused', halt_reason: { reason: 'limit_reached' }, limit: 2 });
    await createRun(run, opRoot);

    const result = await runRunInspectCommand('RUN-001', { cwd: tmpRoot, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('limit_reached');
    expect(result.stdout).toContain('--resume RUN-001');
  });

  it('shows next step for merge_conflict halt', async () => {
    const opRoot = await makeOpRoot();
    const run = baseRun({
      status: 'paused',
      halt_reason: { reason: 'merge_conflict', target: 'S-002' },
    });
    await createRun(run, opRoot);

    const result = await runRunInspectCommand('RUN-001', { cwd: tmpRoot, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('merge_conflict:S-002');
    expect(result.stdout).toContain('resolve conflict');
  });

  it('returns JSON when --json flag set', async () => {
    const opRoot = await makeOpRoot();
    const run = baseRun({ halt_reason: { reason: 'limit_reached' } });
    await createRun(run, opRoot);

    const result = await runRunInspectCommand('RUN-001', { cwd: tmpRoot, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe('RUN-001');
  });

  it('shows the latest autonomous checkpoint when present', async () => {
    const opRoot = await makeOpRoot();
    const run = baseRun({ checkpoint_sha: 'abc123456789def' });
    await createRun(run, opRoot);

    const result = await runRunInspectCommand('RUN-001', { cwd: tmpRoot, json: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Checkpoint: abc123456789');
  });

  it('returns error for non-existent run', async () => {
    await makeOpRoot();
    const result = await runRunInspectCommand('RUN-999', { cwd: tmpRoot, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('RUN-999');
  });
});

// — abort —

describe('rk run abort', () => {
  it('aborts a paused run', async () => {
    const opRoot = await makeOpRoot();
    // Set up a fake lane claim so releaseLane has something to find
    await mkdir(join(opRoot, 'lanes'), { recursive: true });
    const run = baseRun({ status: 'paused', halt_reason: { reason: 'limit_reached' } });
    await createRun(run, opRoot);

    const result = await runRunAbortCommand('RUN-001', { cwd: tmpRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('aborted');
  });

  it('rejects aborting an already-completed run', async () => {
    const opRoot = await makeOpRoot();
    const run = baseRun({ status: 'completed', halt_reason: { reason: 'epic_completed' } });
    await createRun(run, opRoot);

    const result = await runRunAbortCommand('RUN-001', { cwd: tmpRoot });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('already completed');
  });

  it('rejects aborting an already-aborted run', async () => {
    const opRoot = await makeOpRoot();
    const run = baseRun({ status: 'failed', halt_reason: { reason: 'user_abort' } });
    // Force status to 'aborted' bypassing TS — testing the guard logic
    (run as Record<string, unknown>).status = 'aborted';
    await createRun(run, opRoot);

    const result = await runRunAbortCommand('RUN-001', { cwd: tmpRoot });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('already aborted');
  });

  it('returns error for non-existent run', async () => {
    await makeOpRoot();
    const result = await runRunAbortCommand('RUN-999', { cwd: tmpRoot });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('RUN-999');
  });

  it('persists abort_requested=true and status=aborted on the stored run', async () => {
    const opRoot = await makeOpRoot();
    await mkdir(join(opRoot, 'lanes'), { recursive: true });
    const run = baseRun({ status: 'paused', halt_reason: { reason: 'limit_reached' } });
    await createRun(run, opRoot);

    const abortResult = await runRunAbortCommand('RUN-001', { cwd: tmpRoot });
    expect(abortResult.exitCode).toBe(0);

    const stored = await loadRun('RUN-001', opRoot);
    expect(stored.abort_requested).toBe(true);
    expect(stored.status).toBe('aborted');
    expect(stored.halt_reason).toEqual({ reason: 'user_abort' });
    expect(stored.ended_at).not.toBeNull();
  });

  it('releases lane even when run state was already in terminal status', async () => {
    const opRoot = await makeOpRoot();
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(lanesDir, { recursive: true });
    // Write a fake lane claim for the epic
    await writeFile(
      join(lanesDir, 'epic-E-001.json'),
      JSON.stringify({
        lane: 'epic-E-001',
        run_id: 'RUN-001',
        epic_id: 'E-001',
        branch: 'main',
        worktree: '/tmp/wt',
        claimed_at: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    const run = baseRun({ status: 'paused', halt_reason: { reason: 'limit_reached' } });
    await createRun(run, opRoot);

    await runRunAbortCommand('RUN-001', { cwd: tmpRoot });

    // Lane file should be removed
    const { access } = await import('node:fs/promises');
    await expect(access(join(lanesDir, 'epic-E-001.json'))).rejects.toThrow();
  });
});

// — logs —

describe('rk run logs', () => {
  it('lists log files when no sprint-id given', async () => {
    const opRoot = await makeOpRoot();
    const logsDir = join(opRoot, 'runs', 'RUN-001', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'S-001.agent.log'), 'agent output\n', 'utf8');

    const result = await runRunLogsCommand('RUN-001', { cwd: tmpRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('S-001.agent.log');
  });

  it('shows sprint log content when sprint-id given', async () => {
    const opRoot = await makeOpRoot();
    const logsDir = join(opRoot, 'runs', 'RUN-001', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'S-001.agent.log'), 'agent ran ok\n', 'utf8');
    await writeFile(join(logsDir, 'S-001.lifecycle.log'), 'lifecycle ok\n', 'utf8');

    const result = await runRunLogsCommand('RUN-001', { cwd: tmpRoot, sprintId: 'S-001' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('agent ran ok');
    expect(result.stdout).toContain('lifecycle ok');
  });

  it('tails sprint log content when --tail is supplied', async () => {
    const opRoot = await makeOpRoot();
    const logsDir = join(opRoot, 'runs', 'RUN-001', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'S-001.agent.log'), 'one\ntwo\nthree\n', 'utf8');
    await writeFile(join(logsDir, 'S-001.lifecycle.log'), 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await runRunLogsCommand('RUN-001', {
      cwd: tmpRoot,
      sprintId: 'S-001',
      tail: 2,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('one');
    expect(result.stdout).toContain('two\nthree');
    expect(result.stdout).not.toContain('alpha');
    expect(result.stdout).toContain('beta\ngamma');
  });

  it('prints summaries when --summary is supplied', async () => {
    const opRoot = await makeOpRoot();
    const summariesDir = join(opRoot, 'runs', 'RUN-001', 'summaries');
    await mkdir(summariesDir, { recursive: true });
    await writeFile(join(summariesDir, 'S-001.md'), '# S-001\n\nDone.\n', 'utf8');

    const result = await runRunLogsCommand('RUN-001', { cwd: tmpRoot, summary: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Summaries for RUN-001');
    expect(result.stdout).toContain('Done.');
  });

  it('returns no-logs message when run has no logs', async () => {
    await makeOpRoot();
    const result = await runRunLogsCommand('RUN-MISSING', { cwd: tmpRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no logs');
  });
});

// — resume: terminal halt_reason states —

type ResumeCase = {
  halt_reason: HaltReason;
  status: Run['status'];
  messagePart: string;
};

const terminalCases: ResumeCase[] = [
  // terminal halt_reasons: status guard is irrelevant, new routing fires first
  { halt_reason: 'epic_completed', status: 'failed', messagePart: 'already completed' },
  { halt_reason: 'no_runnable_sprint', status: 'failed', messagePart: 'already completed' },
  { halt_reason: 'user_abort', status: 'failed', messagePart: 'aborted by user' },
  // unrecoverable failure states
  { halt_reason: 'config_error', status: 'failed', messagePart: 'unrecoverable' },
  { halt_reason: 'epic_not_found', status: 'failed', messagePart: 'unrecoverable' },
  { halt_reason: 'path_conflict', status: 'failed', messagePart: 'unrecoverable' },
];

describe('rk run --resume terminal halt_reason states', () => {
  for (const { halt_reason, status, messagePart } of terminalCases) {
    it(`returns actionable error for halt_reason="${halt_reason}" (status: ${status})`, async () => {
      const opRoot = await makeOpRoot();
      const run = baseRun({ halt_reason: { reason: halt_reason } });
      (run as Record<string, unknown>).status = status;
      await createRun(run, opRoot);

      const result = await runRunCommand({
        cwd: tmpRoot,
        resume: 'RUN-001',
        agent: 'fake',
        mode: 'assisted',
        worktree: false,
        dryRun: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(messagePart);
      expect(result.stderr).not.toContain('not yet implemented');
    });
  }
});
