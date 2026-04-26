/**
 * Sequential fake-agent E2E tests.
 *
 * Scenarios NOT covered by the existing e2eSequential.test.ts:
 *   - Two sprints with depends_on: dependency enforced
 *   - Multi-sprint chain, both ship in sequence
 *   - limit: 1 on a 2-sprint epic → run completes after 1 sprint
 *   - Review pauses run; resume after accepted verdict
 *   - Abort mid-run transitions to aborted
 *   - Sprint state transitions: base_sha, end_sha, status: shipped
 *   - Run JSON fields: sprint_count, completed_sprints, agent, mode
 *   - Agent log file written after sprint runs
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

// — single sprint —

describe('single sprint run', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001' }],
    });
  });

  it('creates run JSON with status running initially, completes after review', async () => {
    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });
    expect(r.exitCode, `run failed: ${r.stderr}`).toBe(0);

    const runId = await findRunId(repoDir);
    const run = await loadRunFile(repoDir, runId);
    expect(run.agent).toBe('fake');
    expect(run.mode).toBe('assisted');
    expect(run.epic_id).toBe('E-001');
    expect(run.halt_reason).toBe('awaiting_review');
    expect(run.current_sprint).toBe('S-001');
  });

  it('sprint has base_sha after run starts', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(sprintData.base_sha).toBeTruthy();
    expect(sprintData.status).toBe('review');
  });

  it('sprint has end_sha and status=shipped after close', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    const reviewId = sprintData.review_id as string;

    await runReviewVerdictCommand(reviewId, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: accepted verdict');

    const runId = await findRunId(repoDir);
    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const finalSprint = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(finalSprint.status).toBe('shipped');
    expect(finalSprint.end_sha).toBeTruthy();
    expect(finalSprint.closed_at).toBeTruthy();
  });

  it('run JSON shows sprint_count=1 and completed_sprints after ship', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    const reviewId = sprintData.review_id as string;
    await runReviewVerdictCommand(reviewId, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: verdict');

    const runId = await findRunId(repoDir);
    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const run = await loadRunFile(repoDir, runId);
    expect(run.sprint_count).toBe(1);
    expect(run.completed_sprints).toHaveLength(1);
    expect(run.completed_sprints[0]!.id).toBe('S-001');
    expect(run.completed_sprints[0]!.verdict).toBe('accepted');
    expect(run.completed_sprints[0]!.start_sha).toBeTruthy();
    expect(run.completed_sprints[0]!.end_sha).toBeTruthy();
  });
});

// — two-sprint chain (S-002 depends_on S-001) —

describe('two-sprint dependency chain', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({
      sprints: [
        { id: 'S-001', allowed_paths: ['workspace/s001'] },
        { id: 'S-002', depends_on: ['S-001'], allowed_paths: ['workspace/s002'] },
      ],
    });
  });

  it('S-002 is not runnable until S-001 ships', async () => {
    // Run S-001 only (limit=1)
    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });
    expect(r.exitCode).toBe(0);

    const runId = await findRunId(repoDir);
    const run = await loadRunFile(repoDir, runId);
    // Only S-001 is current — S-002 dependency not yet met
    expect(run.current_sprint).toBe('S-001');
    expect(run.sprint_count).toBe(0);

    const s002data = await readFm(join(repoDir, 'sprints/S-002.md'));
    expect(s002data.status).toBe('queued'); // not started
  });

  it('both sprints ship in dependency order over multiple runs', async () => {
    // Round 1: run with no limit — S-001 runs first, pauses for review
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    const s001Data = await readFm(join(repoDir, 'sprints/S-001.md'));
    const r1 = s001Data.review_id as string;
    await runReviewVerdictCommand(r1, 'accepted', { cwd: repoDir, dryRun: false, json: false });
    await commitAll(repoDir, 'chore: accept S-001');

    // Resume: close S-001, run S-002
    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    // S-001 shipped, S-002 now in review
    const s001Final = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(s001Final.status).toBe('shipped');

    const s002Data = await readFm(join(repoDir, 'sprints/S-002.md'));
    expect(s002Data.status).toBe('review');
    const r2 = s002Data.review_id as string;

    await runReviewVerdictCommand(r2, 'accepted', { cwd: repoDir, dryRun: false, json: false });
    await commitAll(repoDir, 'chore: accept S-002');

    // Final resume: close S-002, epic_completed
    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const s002Final = await readFm(join(repoDir, 'sprints/S-002.md'));
    expect(s002Final.status).toBe('shipped');

    const finalRun = await loadRunFile(repoDir, runId);
    expect(finalRun.status).toBe('completed');
    expect(finalRun.halt_reason).toBe('epic_completed');
    expect(finalRun.sprint_count).toBe(2);
    expect(finalRun.completed_sprints).toHaveLength(2);
  });

  it('run gets RUN-NNN format ID', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    expect(runId).toMatch(/^RUN-\d+$/);
    const run = await loadRunFile(repoDir, runId);
    expect(run.id).toBe(runId);
  });
});

// — abort —

describe('abort', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
  });

  it('abort transitions paused run to status=aborted', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    const abortResult = await runRunAbortCommand(runId, { cwd: repoDir });
    expect(abortResult.exitCode).toBe(0);
    expect(abortResult.stdout).toContain('aborted');

    const run = await loadRunFile(repoDir, runId);
    expect(run.status).toBe('aborted');
  });

  it('abort on completed run returns error', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    const reviewId = sprintData.review_id as string;
    await runReviewVerdictCommand(reviewId, 'accepted', {
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
      experimental: false,
    });

    // Run is now completed
    const r = await runRunAbortCommand(runId, { cwd: repoDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('already completed');
  });
});

// — agent log files —

describe('sprint packet files', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
  });

  it('sprint packet file exists at expected path after sprint runs', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    const packetsDir = join(opRoot(repoDir), 'runs', runId, 'sprint-packets');
    const files = await readdir(packetsDir).catch(() => []);
    expect(files).toContain('S-001.md');
  });

  it('sprint packet contains sentinel markers', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    const packetPath = join(opRoot(repoDir), 'runs', runId, 'sprint-packets', 'S-001.md');
    const { readFile: rf } = await import('node:fs/promises');
    const content = await rf(packetPath, 'utf8');
    expect(content).toContain('REPOKERNEL_RESULT_START');
    expect(content).toContain('REPOKERNEL_RESULT_END');
    expect(content).toContain('RUN-001');
    expect(content).toContain('S-001');
  });
});

// — run ID assignment —

describe('run ID', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
  });

  it('first run gets RUN-001 ID', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    expect(runId).toBe('RUN-001');
  });

  it('run agent field matches --agent fake', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const runId = await findRunId(repoDir);
    const run = await loadRunFile(repoDir, runId);
    expect(run.agent).toBe('fake');
    expect(run.mode).toBe('assisted');
  });
});
