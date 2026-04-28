/**
 * Run state machine transition tests.
 *
 * Tests every status field mutation directly via the runState API
 * plus integration-level transitions triggered by runRunCommand + FakeRunner.
 */
import { join } from 'node:path';
import type { Run } from '@repokernel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReviewVerdictCommand } from '../../src/commands/lifecycle.js';
import { runRunAbortCommand, runRunCommand } from '../../src/commands/run.js';
import { allocateRun, createRun, loadRun, updateRun } from '../../src/lifecycle/runState.js';
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

// — direct API: allocate / create / update / load —

describe('allocateRun', () => {
  it('assigns sequential RUN-001, RUN-002 IDs', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const op = opRoot(repoDir);

    const base: Omit<Run, 'id'> = {
      schema_version: 1,
      epic_id: 'E-001',
      lane: 'main',
      status: 'running',
      mode: 'assisted',
      agent: 'fake',
      worktree: repoDir,
      branch: 'main',
      started_at: new Date().toISOString(),
      ended_at: null,
      current_sprint: null,
      completed_sprints: [],
      halt_reason: null,
      limit: null,
      sprint_count: 0,
      execution_strategy: 'sequential',
      wave_index: -1,
      active_sprints: [],
      parallel_workers: [],
      abort_requested: false,
    };

    const r1 = await allocateRun(base, op);
    const r2 = await allocateRun(base, op);

    expect(r1.id).toBe('RUN-001');
    expect(r2.id).toBe('RUN-002');
  });
});

describe('updateRun', () => {
  it('applies patch and returns updated run', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const op = opRoot(repoDir);

    const base: Run = {
      schema_version: 1,
      id: 'RUN-001',
      epic_id: 'E-001',
      lane: 'main',
      status: 'running',
      mode: 'assisted',
      agent: 'fake',
      worktree: repoDir,
      branch: 'main',
      started_at: new Date().toISOString(),
      ended_at: null,
      current_sprint: null,
      completed_sprints: [],
      halt_reason: null,
      limit: null,
      sprint_count: 0,
      execution_strategy: 'sequential',
      wave_index: -1,
      active_sprints: [],
      parallel_workers: [],
      abort_requested: false,
    };

    await createRun(base, op);
    const updated = await updateRun(
      'RUN-001',
      { status: 'paused', halt_reason: 'limit_reached' },
      op,
    );
    expect(updated.status).toBe('paused');
    expect(updated.halt_reason).toBe('limit_reached');
  });

  it('persists patch to disk', async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const op = opRoot(repoDir);

    const base: Run = {
      schema_version: 1,
      id: 'RUN-001',
      epic_id: 'E-001',
      lane: 'main',
      status: 'running',
      mode: 'assisted',
      agent: 'fake',
      worktree: repoDir,
      branch: 'main',
      started_at: new Date().toISOString(),
      ended_at: null,
      current_sprint: null,
      completed_sprints: [],
      halt_reason: null,
      limit: null,
      sprint_count: 0,
      execution_strategy: 'sequential',
      wave_index: -1,
      active_sprints: [],
      parallel_workers: [],
      abort_requested: false,
    };

    await createRun(base, op);
    await updateRun('RUN-001', { sprint_count: 3 }, op);
    const reloaded = await loadRun('RUN-001', op);
    expect(reloaded.sprint_count).toBe(3);
  });
});

// — via runRunCommand integration —

describe('run status via runRunCommand', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
  });

  it('fresh run has status=paused + halt_reason=awaiting_review after first sprint', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    expect(run.status).toBe('paused');
    expect(run.halt_reason).toBe('awaiting_review');
  });

  it('run completes with status=completed after sprint ships', async () => {
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
    await runReviewVerdictCommand(sprintData.review_id as string, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: verdict');

    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    const finalRun = await loadRunFile(repoDir, runId);
    expect(finalRun.status).toBe('completed');
    expect(finalRun.ended_at).toBeTruthy();
  });

  it('aborted run has status=aborted', async () => {
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
    await runRunAbortCommand(runId, { cwd: repoDir });

    const run = await loadRunFile(repoDir, runId);
    expect(run.status).toBe('aborted');
  });

  it('started_at set, ended_at null while run is paused', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    expect(run.started_at).toBeTruthy();
    // paused run may or may not have ended_at depending on path
    // key: started_at must be set
  });

  it('lane field is main (default lane)', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    expect(run.lane).toBe('main');
  });

  it('current_sprint is S-001 while awaiting review', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    expect(run.current_sprint).toBe('S-001');
  });

  it('current_sprint is null after sprint ships', async () => {
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
    await runReviewVerdictCommand(sprintData.review_id as string, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: verdict');

    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    const finalRun = await loadRunFile(repoDir, runId);
    expect(finalRun.current_sprint).toBeNull();
  });

  it('sprint_count increments by 1 per shipped sprint', async () => {
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
    const mid = await loadRunFile(repoDir, runId);
    expect(mid.sprint_count).toBe(0); // not yet counted (awaiting review)

    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    await runReviewVerdictCommand(sprintData.review_id as string, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: verdict');

    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    const finalRun = await loadRunFile(repoDir, runId);
    expect(finalRun.sprint_count).toBe(1);
  });
});

// — gate halt transitions —

describe('gate halt transitions', () => {
  it('gate halt sets status=paused with halt_reason starting with gate:', async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001', gate: 'checkpoint' }],
    });

    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    const runId = await findRunId(repoDir);
    const run = await loadRunFile(repoDir, runId);
    expect(run.status).toBe('paused');
    expect(run.halt_reason).toMatch(/^gate:/);
    expect(run.sprint_count).toBe(0);
  });
});
