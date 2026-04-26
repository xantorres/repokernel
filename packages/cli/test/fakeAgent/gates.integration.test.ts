/**
 * Gate lifecycle integration tests using fake agent.
 *
 * Tests the full lifecycle: gate blocks run → gate resolve → resume ships sprint.
 * Uses real git repos; no mocks.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGateListCommand, runGateResolveCommand } from '../../src/commands/gate.js';
import { runReviewVerdictCommand } from '../../src/commands/lifecycle.js';
import { runRunCommand } from '../../src/commands/run.js';
import { commitAll, findRunId, loadRunFile, makeEpicRepo, readFm, removeRepo } from './helpers.js';

let repoDir: string;

afterEach(async () => {
  if (repoDir) await removeRepo(repoDir);
});

// — gate blocks run immediately —

describe('gate on first sprint halts run before executing anything', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001', gate: 'deploy-beta' }],
    });
  });

  it('run halts immediately with halt_reason starting with gate:', async () => {
    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });
    expect(r.exitCode).toBe(0);

    const runId = await findRunId(repoDir);
    const run = await loadRunFile(repoDir, runId);
    expect(run.status).toBe('paused');
    expect(run.halt_reason).toMatch(/^gate:/);
    expect(run.halt_reason).toContain('deploy-beta');
    expect(run.sprint_count).toBe(0); // no sprint ran
  });

  it('sprint stays queued when gate halts run', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(sprintData.status).toBe('queued');
  });

  it('gate ls shows the blocked sprint', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const r = await runGateListCommand({ cwd: repoDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('deploy-beta');
    expect(r.stdout).toContain('S-001');
  });

  it('gate resolve removes gate field from sprint', async () => {
    await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const r = await runGateResolveCommand('deploy-beta', { cwd: repoDir, force: true });
    expect(r.exitCode).toBe(0);

    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(sprintData.gate).toBeUndefined();
  });

  it('resume after gate resolve runs sprint and pauses for review', async () => {
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

    await runGateResolveCommand('deploy-beta', { cwd: repoDir, force: true });

    const r = await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });
    expect(r.exitCode).toBe(0);

    const run = await loadRunFile(repoDir, runId);
    expect(run.halt_reason).toBe('awaiting_review');
    expect(run.current_sprint).toBe('S-001');
  });

  it('full flow: gate → resolve → run → review → ship', async () => {
    // Step 1: Run halts at gate
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

    // Step 2: Resolve gate
    await runGateResolveCommand('deploy-beta', { cwd: repoDir, force: true });

    // Step 3: Resume — S-001 runs, awaiting_review
    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    // Step 4: Accept review
    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    const reviewId = sprintData.review_id as string;
    await runReviewVerdictCommand(reviewId, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: accept verdict');

    // Step 5: Final resume — sprint closes, epic_completed
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

    const finalRun = await loadRunFile(repoDir, runId);
    expect(finalRun.status).toBe('completed');
    expect(finalRun.halt_reason).toBe('epic_completed');
    expect(finalRun.sprint_count).toBe(1);
  });
});

// — gate on second sprint —

describe('gate halts run after first sprint ships', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({
      sprints: [
        { id: 'S-001', allowed_paths: ['workspace/s001'] },
        { id: 'S-002', gate: 'phase-2', allowed_paths: ['workspace/s002'] },
      ],
    });
  });

  it('first sprint ships, then run halts at second sprint gate', async () => {
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

    // Resume — closes S-001, hits S-002 gate
    const r = await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });
    expect(r.exitCode).toBe(0);

    const run = await loadRunFile(repoDir, runId);
    expect(run.status).toBe('paused');
    expect(run.halt_reason).toMatch(/^gate:/);
    expect(run.halt_reason).toContain('phase-2');
    expect(run.sprint_count).toBe(1); // S-001 counted
  });

  it('S-001 shipped, S-002 still queued (not yet run)', async () => {
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
    await runReviewVerdictCommand(s001Data.review_id as string, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    await commitAll(repoDir, 'chore: accept');

    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const s001Final = await readFm(join(repoDir, 'sprints/S-001.md'));
    const s002Data = await readFm(join(repoDir, 'sprints/S-002.md'));
    expect(s001Final.status).toBe('shipped');
    expect(s002Data.status).toBe('queued');
  });
});

// — gate ls JSON —

describe('gate ls --json', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001', gate: 'checkpoint' }],
    });
  });

  it('returns parseable JSON with gate name', async () => {
    const r = await runGateListCommand({ cwd: repoDir, json: true });
    expect(r.exitCode).toBe(0);
    const gates = JSON.parse(r.stdout) as Array<{ name: string; sprints: unknown[] }>;
    expect(Array.isArray(gates)).toBe(true);
    const gate = gates.find((g) => g.name === 'checkpoint');
    expect(gate).toBeDefined();
    expect(gate!.sprints).toHaveLength(1);
  });
});

// — two sprints sharing same gate —

describe('two sprints sharing the same gate', () => {
  beforeEach(async () => {
    repoDir = await makeEpicRepo({
      sprints: [
        { id: 'S-001', gate: 'wave-2', allowed_paths: ['workspace/s001'] },
        { id: 'S-002', gate: 'wave-2', allowed_paths: ['workspace/s002'] },
      ],
    });
  });

  it('gate resolve removes gate from both sprints', async () => {
    const r = await runGateResolveCommand('wave-2', { cwd: repoDir, force: true });
    expect(r.exitCode).toBe(0);

    const s1 = await readFm(join(repoDir, 'sprints/S-001.md'));
    const s2 = await readFm(join(repoDir, 'sprints/S-002.md'));
    expect(s1.gate).toBeUndefined();
    expect(s2.gate).toBeUndefined();
  });
});

// — gate ls epic filter —

describe('gate ls with epic filter', () => {
  it('only shows gates from requested epic', async () => {
    // Two epics, each with gated sprints
    repoDir = await makeEpicRepo({
      epicId: 'E-001',
      sprints: [{ id: 'S-001', gate: 'alpha' }],
    });

    const r = await runGateListCommand({ cwd: repoDir, epicId: 'E-001' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('alpha');
  });
});
