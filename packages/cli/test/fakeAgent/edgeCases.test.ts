/**
 * Edge cases and boundary conditions for fake-agent runs.
 *
 * Covers: all-shipped epics, all-gated epics, non-existent epics,
 * concurrent runs on same lane, invalid run IDs, invalid --limit values.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReviewVerdictCommand } from '../../src/commands/lifecycle.js';
import { runRunAbortCommand, runRunCommand } from '../../src/commands/run.js';
import {
  commitAll,
  findRunId,
  loadRunFile,
  makeEpicRepo,
  opRoot,
  readFm,
  removeRepo,
} from './helpers.js';

let repoDir: string;

afterEach(async () => {
  if (repoDir) await removeRepo(repoDir);
});

// — non-existent epic —

describe('run on non-existent epic', () => {
  it('returns error when epic ID not found', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });

    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-999',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('E-999');
  });
});

// — resume with non-existent run ID —

describe('resume with non-existent run ID', () => {
  it('returns error for unknown run ID', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });

    const r = await runRunCommand({
      cwd: repoDir,
      resume: 'RUN-999',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('RUN-999');
  });
});

// — abort non-existent run —

describe('abort non-existent run', () => {
  it('returns error for unknown run ID', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });

    const r = await runRunAbortCommand('RUN-999', { cwd: repoDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('RUN-999');
  });
});

// — all sprints already shipped (epic complete before run) —

describe('epic with all sprints shipped', () => {
  it('run exits with epic_completed when re-run after all sprints ship', async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001' }],
    });

    // Ship S-001 via the actual flow
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
    });

    const runId = await findRunId(repoDir);
    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    const reviewId = sprintData.review_id as string;
    await runReviewVerdictCommand(reviewId, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: accept verdict');

    // Close sprint (ship it)
    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    // Now S-001 is shipped. Try running the epic again.
    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    expect(r.exitCode).toBe(0);
    const run = await loadRunFile(repoDir, 'RUN-002');
    expect(['epic_completed', 'no_runnable_sprint']).toContain(run.halt_reason);
    expect(run.status).toBe('completed');
    expect(run.sprint_count).toBe(0);
  });
});

// — second run while first is active (lane conflict) —

describe('concurrent run on same lane', () => {
  it('second rk run on same epic while first is running fails with lane error', async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001' }, { id: 'S-002' }],
    });

    // Start first run (pauses at awaiting_review)
    const r1 = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
    });
    expect(r1.exitCode).toBe(0);

    // Try to start second run while first is paused (still "active" in terms of lane lock)
    const r2 = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    // Should fail — first run is still paused with lane claim
    expect(r2.exitCode).not.toBe(0);
    // Should mention the existing run
    expect(r2.stderr + r2.stdout).toMatch(/RUN-001|already active|lane/i);
  });
});

// — dry run doesn't create run state —

describe('dry run', () => {
  it('--dry-run exits 0 without creating a run file', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });

    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: true,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dry-run');

    // No run file should exist
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const runsDir = join(opRoot(repoDir), 'runs');
    const files = await readdir(runsDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});

// — unknown agent name —

describe('unknown agent', () => {
  it('returns error for unknown --agent value', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });

    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'nonexistent-agent-xyz',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('nonexistent-agent-xyz');
  });
});

// — missing epic ID —

describe('missing epicId', () => {
  it('returns error when no epicId and no --resume provided', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });

    const r = await runRunCommand({
      cwd: repoDir,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/epic|required/i);
  });
});
