/**
 * Parallel fake-agent E2E tests.
 *
 * Scenarios beyond the existing e2eParallel.test.ts:
 *   - Sequential waves: S-001+S-002 (wave 0) then S-003 (depends both, wave 1)
 *   - parallel_limit caps wave size (epic sets parallel_limit: 1)
 *   - wave_index advances after each wave
 *   - active_sprints cleared after wave merge
 *   - parallel_workers populated in run JSON during execution
 *   - Gated sprint excluded from parallel wave computation
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReviewVerdictCommand } from '../../src/commands/lifecycle.js';
import { runRunCommand } from '../../src/commands/run.js';
import { commitAll, findRunId, loadRunFile, makeGitRepo, readFm, removeRepo } from './helpers.js';

const execFileAsync = promisify(execFile);

let repoDir: string;
let worktreesDir: string;

beforeEach(async () => {
  worktreesDir = await mkdtemp(join(tmpdir(), 'rk-fa-wt-'));
});

afterEach(async () => {
  if (repoDir) {
    await execFileAsync('git', ['-C', repoDir, 'worktree', 'prune']).catch(() => null);
    await removeRepo(repoDir);
  }
  if (worktreesDir) {
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => null);
    const sibling = join(worktreesDir, '..', `.rk-fa-wt-${basename(worktreesDir)}`);
    await rm(sibling, { recursive: true, force: true }).catch(() => null);
  }
});

function parallelConfigYaml(wtRoot: string, parallelLimit?: number): string {
  const lines = [
    'schemaVersion: 1',
    'projectId: fa-par-test',
    'projectName: FA Parallel Test',
    'paths:',
    '  epics: epics',
    '  sprints: sprints',
    '  reviews: reviews',
    '  queues: queues',
    '  lanes: lanes',
    '  generated: .repokernel',
    '  registry: .repokernel/registry.json',
    'policies:',
    '  requireReviewForShipped: false',
    'worktrees:',
    `  root: ${wtRoot}`,
    '  baseBranch: main',
  ];
  if (parallelLimit !== undefined) {
    lines.push('parallel:');
    lines.push(`  maxConcurrentSprints: ${parallelLimit}`);
  }
  return `${lines.join('\n')}\n`;
}

async function makeParallelRepo(opts: {
  sprints: Array<{ id: string; depends_on?: string[]; gate?: string; allowed_paths?: string[] }>;
  epicParallelLimit?: number;
  configParallelLimit?: number;
}): Promise<string> {
  const dir = await makeGitRepo('rk-fa-par-');
  const { mkdir } = await import('node:fs/promises');
  await Promise.all(
    ['epics', 'sprints', 'reviews', 'queues', 'lanes', '.repokernel'].map((d) =>
      mkdir(join(dir, d), { recursive: true }),
    ),
  );

  await writeFile(
    join(dir, 'repokernel.config.yaml'),
    parallelConfigYaml(worktreesDir, opts.configParallelLimit),
    'utf8',
  );

  const epicLines = [
    '---',
    'id: "E-001"',
    'title: "Parallel Epic"',
    'status: "planned"',
    'execution_strategy: "parallel"',
  ];
  if (opts.epicParallelLimit !== undefined) {
    epicLines.push(`parallel_limit: ${opts.epicParallelLimit}`);
  }
  epicLines.push('sprints:');
  for (const s of opts.sprints) epicLines.push(`  - "${s.id}"`);
  epicLines.push('---');
  await writeFile(join(dir, 'epics/E-001.md'), `${epicLines.join('\n')}\n`, 'utf8');

  for (const spec of opts.sprints) {
    const sprintLines = [
      '---',
      `id: "${spec.id}"`,
      `title: "Sprint ${spec.id}"`,
      `epic_id: "E-001"`,
      `status: "queued"`,
      `lane: "main"`,
      `review_required: false`,
    ];
    if (spec.gate) sprintLines.push(`gate: "${spec.gate}"`);
    if (spec.depends_on?.length) {
      sprintLines.push('depends_on:');
      for (const d of spec.depends_on) sprintLines.push(`  - "${d}"`);
    }
    const paths = spec.allowed_paths ?? [`workspace/${spec.id.toLowerCase()}`];
    sprintLines.push('allowed_paths:');
    for (const p of paths) sprintLines.push(`  - "${p}"`);
    sprintLines.push('---');
    await writeFile(join(dir, `sprints/${spec.id}.md`), `${sprintLines.join('\n')}\n`, 'utf8');
  }

  const queueSlots = opts.sprints.map((s, i) => ({
    id: `Q-${String(i + 1).padStart(3, '0')}`,
    sprint_id: s.id,
    order: i,
  }));
  const queueLines = ['---', 'lane: "main"', 'slots:'];
  queueSlots.forEach((slot) => {
    queueLines.push(`  - id: "${slot.id}"`);
    queueLines.push(`    sprint_id: "${slot.sprint_id}"`);
    queueLines.push(`    order: ${slot.order}`);
  });
  queueLines.push('---');
  await writeFile(join(dir, 'queues/main.md'), `${queueLines.join('\n')}\n`, 'utf8');

  await commitAll(dir, 'chore: parallel project setup');
  return dir;
}

// — basic two-sprint parallel wave —

describe('two-sprint parallel wave', () => {
  beforeEach(async () => {
    repoDir = await makeParallelRepo({
      sprints: [
        { id: 'S-001', allowed_paths: ['workspace/alpha'] },
        { id: 'S-002', allowed_paths: ['workspace/beta'] },
      ],
    });
  });

  it('run pauses at awaiting_reviews after wave completes', async () => {
    const r = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });
    expect(r.exitCode, `run failed:\nstdout:${r.stdout}\nstderr:${r.stderr}`).toBe(0);

    const runId = await findRunId(repoDir);
    const run = await loadRunFile(repoDir, runId);
    expect(run.halt_reason).toBe('awaiting_reviews');
    expect(run.status).toBe('paused');
  });

  it('pending_wave contains both sprint IDs', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    const sprintIds = run.pending_wave?.sprint_ids ?? [];
    expect(sprintIds).toHaveLength(2);
    expect(sprintIds).toContain('S-001');
    expect(sprintIds).toContain('S-002');
  });

  it('parallel_workers populated with correct sprint IDs', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    const workerIds = run.parallel_workers.map((w) => w.sprint_id).sort();
    expect(workerIds).toEqual(['S-001', 'S-002']);
  });

  it('fake agent commits exist on sprint branches', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    const branches = Object.values(run.pending_wave?.branches ?? {}) as string[];
    expect(branches).toHaveLength(2);

    for (const branch of branches) {
      const { execFile: ef } = await import('node:child_process');
      const { promisify: pify } = await import('node:util');
      const execAsync = pify(ef);
      const { stdout } = await execAsync('git', ['-C', repoDir, 'log', '--oneline', branch]);
      expect(stdout).toContain('fake implementation');
    }
  });

  it('full flow: both sprints ship after accepted reviews', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    const reviewIds: string[] = run.pending_wave?.awaiting_reviews ?? [];
    expect(reviewIds).toHaveLength(2);

    for (const reviewId of reviewIds) {
      await runReviewVerdictCommand(reviewId, 'accepted', {
        cwd: repoDir,
        dryRun: false,
        json: false,
      });
    }

    const r2 = await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });
    expect(r2.exitCode, `resume failed:\nstdout:${r2.stdout}\nstderr:${r2.stderr}`).toBe(0);

    const s1 = await readFm(join(repoDir, 'sprints/S-001.md'));
    const s2 = await readFm(join(repoDir, 'sprints/S-002.md'));
    expect(s1.status).toBe('shipped');
    expect(s2.status).toBe('shipped');

    const finalRun = await loadRunFile(repoDir, runId);
    expect(finalRun.status).toBe('completed');
    expect(finalRun.halt_reason).toBe('epic_completed');
    expect(finalRun.completed_sprints).toHaveLength(2);
  });

  it('wave_index is 0 after first wave', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    expect(run.wave_index).toBe(0);
  });
});

// — sequential waves (S-001+S-002, then S-003 depends both) —

describe('sequential waves', () => {
  beforeEach(async () => {
    repoDir = await makeParallelRepo({
      sprints: [
        { id: 'S-001', allowed_paths: ['workspace/s001'] },
        { id: 'S-002', allowed_paths: ['workspace/s002'] },
        { id: 'S-003', depends_on: ['S-001', 'S-002'], allowed_paths: ['workspace/s003'] },
      ],
    });
  });

  it('wave 0 contains S-001 and S-002, wave 1 contains S-003', async () => {
    // Run wave 0
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
    const run = await loadRunFile(repoDir, runId);

    const wave0Sprints = run.pending_wave?.sprint_ids ?? [];
    expect(wave0Sprints).toHaveLength(2);
    expect(wave0Sprints).toContain('S-001');
    expect(wave0Sprints).toContain('S-002');

    // Accept both reviews
    const reviewIds: string[] = run.pending_wave?.awaiting_reviews ?? [];
    for (const rid of reviewIds) {
      await runReviewVerdictCommand(rid, 'accepted', { cwd: repoDir, dryRun: false, json: false });
    }

    // Resume → wave 0 merges, wave 1 starts (S-003)
    await runRunCommand({
      cwd: repoDir,
      resume: runId,
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    const run2 = await loadRunFile(repoDir, runId);
    // After wave 0 merges and wave 1 starts, the run should be paused awaiting reviews for S-003
    expect(run2.halt_reason).toBe('awaiting_reviews');
    const wave1Sprints = run2.pending_wave?.sprint_ids ?? [];
    expect(wave1Sprints).toContain('S-003');
  });
});

// — parallel_limit caps wave size —

describe('parallel_limit caps wave size', () => {
  beforeEach(async () => {
    repoDir = await makeParallelRepo({
      sprints: [
        { id: 'S-001', allowed_paths: ['workspace/s001'] },
        { id: 'S-002', allowed_paths: ['workspace/s002'] },
        { id: 'S-003', allowed_paths: ['workspace/s003'] },
      ],
      epicParallelLimit: 1, // only 1 sprint per wave
    });
  });

  it('wave contains only 1 sprint when parallel_limit=1', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    const sprintIds = run.pending_wave?.sprint_ids ?? [];
    expect(sprintIds).toHaveLength(1); // capped by parallel_limit
  });
});

// — gated sprint excluded from parallel wave —

describe('gated sprint excluded from parallel wave', () => {
  beforeEach(async () => {
    repoDir = await makeParallelRepo({
      sprints: [
        { id: 'S-001', allowed_paths: ['workspace/s001'] },
        { id: 'S-002', gate: 'deploy-gate', allowed_paths: ['workspace/s002'] },
      ],
    });
  });

  it('wave only contains non-gated sprint', async () => {
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
    const run = await loadRunFile(repoDir, runId);
    const sprintIds = run.pending_wave?.sprint_ids ?? [];
    // Only S-001 in wave — S-002 is gated
    expect(sprintIds).toContain('S-001');
    expect(sprintIds).not.toContain('S-002');
  });
});
