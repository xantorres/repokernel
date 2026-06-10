import { describe, expect, it } from 'vitest';
import { formatTaskSummary, reframeRunOutput } from '../src/commands/fastpath/render.js';
import type { TaskAlias } from '../src/commands/fastpath/types.js';
import { eid, sid } from './helpers/brand.js';

const ALIAS: TaskAlias = {
  id: 'T-001',
  epic_id: eid('E-001'),
  sprint_id: sid('S-007'),
  source: 'inline',
  title: 'Add health endpoint',
  created_at: '2026-04-29T00:00:00.000Z',
  closed_at: null,
  status: 'review',
};

describe('reframeRunOutput', () => {
  it('replaces standalone sprint refs with the task ID', () => {
    const out = reframeRunOutput({
      stdout: 'Sprint S-007 reached review.',
      stderr: '',
      alias: ALIAS,
    });
    expect(out.stdout).toBe('Sprint T-001 reached review.');
  });

  it('preserves sprint refs that are part of a path', () => {
    const out = reframeRunOutput({
      stdout: 'Wrote .repokernel/plan/sprints/S-007.md',
      stderr: '',
      alias: ALIAS,
    });
    expect(out.stdout).toContain('S-007.md');
    expect(out.stdout).not.toContain('T-001.md');
  });

  it('preserves sprint refs that are part of a longer word', () => {
    const out = reframeRunOutput({
      stdout: 'branchS-007extra',
      stderr: '',
      alias: ALIAS,
    });
    expect(out.stdout).toBe('branchS-007extra');
  });

  it('reframes both stdout and stderr independently', () => {
    const out = reframeRunOutput({
      stdout: 'S-007 active',
      stderr: 'error: S-007 already shipped',
      alias: ALIAS,
    });
    expect(out.stdout).toBe('T-001 active');
    expect(out.stderr).toBe('error: T-001 already shipped');
  });

  it('returns empty strings unchanged without throwing', () => {
    const out = reframeRunOutput({ stdout: '', stderr: '', alias: ALIAS });
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('');
  });
});

describe('formatTaskSummary', () => {
  it('renders task and status with no optional fields', () => {
    const out = formatTaskSummary({
      alias: ALIAS,
      status: 'active',
      checksPassed: null,
      nextHints: [],
    });
    expect(out).toContain('T-001');
    expect(out).toContain('Add health endpoint');
    expect(out).toContain('active');
    expect(out).not.toContain('Worktree:');
    expect(out).not.toContain('Checks:');
    expect(out).not.toContain('Next:');
  });

  it('includes worktree path when provided', () => {
    const out = formatTaskSummary({
      alias: ALIAS,
      status: 'review',
      checksPassed: true,
      worktreePath: '/tmp/wt/E-001',
      nextHints: [],
    });
    expect(out).toContain('Worktree:');
    expect(out).toContain('/tmp/wt/E-001');
  });

  it('shows passed/failed for checks status', () => {
    const passed = formatTaskSummary({
      alias: ALIAS,
      status: 'review',
      checksPassed: true,
      nextHints: [],
    });
    expect(passed).toMatch(/passed/);

    const failed = formatTaskSummary({
      alias: ALIAS,
      status: 'active',
      checksPassed: false,
      nextHints: [],
    });
    expect(failed).toMatch(/failed/);
  });

  it('renders next hints when provided', () => {
    const out = formatTaskSummary({
      alias: ALIAS,
      status: 'review',
      checksPassed: true,
      nextHints: ['rk close T-001', 'rk discard T-001'],
    });
    expect(out).toContain('Next:');
    expect(out).toContain('rk close T-001');
    expect(out).toContain('rk discard T-001');
  });

  it('exercises every status colour branch', () => {
    for (const status of ['active', 'review', 'shipped', 'cancelled'] as const) {
      const out = formatTaskSummary({
        alias: ALIAS,
        status,
        checksPassed: null,
        nextHints: [],
      });
      expect(out).toContain(status);
    }
  });
});
