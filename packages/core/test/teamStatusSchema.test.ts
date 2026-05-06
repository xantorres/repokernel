import { describe, expect, it } from 'vitest';
import { TeamStatusSchema } from '../src/schemas/run.js';

describe('TeamStatusSchema v2', () => {
  it('declares schemaVersion: 2 and accepts pre-operational JSON', () => {
    const legacy = {
      timestamp: '2026-04-30T12:00:00.000Z',
      runs: [],
      sprints: [],
      registry: {
        files_changed: 0,
        conflicts: 0,
        ready_to_merge: true,
        health: 'OK',
      },
      bottlenecks: [],
    };

    const parsed = TeamStatusSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.operational).toEqual({
      live_claims: [],
      corrupt_run_files: [],
      leaked_worktrees: [],
      active_worktree_count: 0,
      collection_errors: [],
    });
  });

  it('accepts operational without collection_errors and defaults it to empty', () => {
    const partial = {
      timestamp: '2026-04-30T12:00:00.000Z',
      runs: [],
      sprints: [],
      registry: {
        files_changed: 0,
        conflicts: 0,
        ready_to_merge: true,
        health: 'OK',
      },
      operational: {
        live_claims: [],
        corrupt_run_files: [],
        leaked_worktrees: [],
        active_worktree_count: 0,
      },
      bottlenecks: [],
    };

    const parsed = TeamStatusSchema.parse(partial);
    expect(parsed.operational.collection_errors).toEqual([]);
  });

  it('round-trips a full v2 capture', () => {
    const v2 = {
      schemaVersion: 2,
      timestamp: '2026-04-30T12:00:00.000Z',
      runs: [],
      sprints: [],
      registry: {
        files_changed: 0,
        conflicts: 0,
        ready_to_merge: true,
        health: 'OK',
      },
      operational: {
        live_claims: [],
        corrupt_run_files: [],
        leaked_worktrees: [],
        active_worktree_count: 0,
        collection_errors: ['worktree scan failed: ENOENT'],
      },
      bottlenecks: [],
    };

    const parsed = TeamStatusSchema.parse(v2);
    expect(parsed.operational.collection_errors).toEqual(['worktree scan failed: ENOENT']);
  });
});
