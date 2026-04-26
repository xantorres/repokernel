/**
 * E2E: parallel run with fake agent
 *
 * Uses a real git repo — no mocks. Proves the full parallel wave flow:
 *   rk run E-001 --agent fake          (parallel epic → wave 1: S-001 + S-002)
 *   (pause: awaiting_reviews)
 *   rk review-verdict R-001 accepted
 *   rk review-verdict R-002 accepted
 *   rk run --resume RUN-001
 *   → both sprints merged + shipped, run epic_completed
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReviewVerdictCommand } from '../src/commands/lifecycle.js';
import { runRunCommand } from '../src/commands/run.js';

const execFileAsync = promisify(execFile);

// — helpers —

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '--allow-empty', '-m', message]);
}

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-e2e-par-'));
  await execFileAsync('git', ['init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@repokernel.test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'RepoKernel Test']);
  await commitAll(dir, 'chore: init');
  return dir;
}

function configYaml(worktreesRoot: string): string {
  return `schemaVersion: 1
projectId: e2e-par-test
projectName: E2E Parallel Test
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
worktrees:
  root: ${worktreesRoot}
  baseBranch: main
policies:
  requireReviewForShipped: false
`;
}

function epicYaml(): string {
  return `---
id: "E-001"
title: "Parallel E2E Epic"
status: "planned"
execution_strategy: "parallel"
sprints:
  - "S-001"
  - "S-002"
---
`;
}

function sprintYaml(id: string, title: string, path: string): string {
  return `---
id: "${id}"
title: "${title}"
epic_id: "E-001"
status: "queued"
lane: "main"
review_required: false
allowed_paths:
  - "${path}"
---
`;
}

function queueYaml(): string {
  return `---
lane: "main"
slots:
  - id: "Q-001"
    sprint_id: "S-001"
    order: 0
  - id: "Q-002"
    sprint_id: "S-002"
    order: 1
---
`;
}

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

// — tests —

describe('E2E: parallel fake agent run', () => {
  let repoDir: string;
  let worktreesDir: string;

  beforeEach(async () => {
    repoDir = await makeGitRepo();
    worktreesDir = await mkdtemp(join(tmpdir(), 'rk-e2e-wt-'));

    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(repoDir, 'epics'), { recursive: true });
    await mkdir(join(repoDir, 'sprints'), { recursive: true });
    await mkdir(join(repoDir, 'reviews'), { recursive: true });
    await mkdir(join(repoDir, 'queues'), { recursive: true });
    await mkdir(join(repoDir, 'lanes'), { recursive: true });
    await mkdir(join(repoDir, '.repokernel'), { recursive: true });

    await writeFile(join(repoDir, 'repokernel.config.yaml'), configYaml(worktreesDir), 'utf8');
    await writeFile(join(repoDir, 'epics/E-001.md'), epicYaml(), 'utf8');
    await writeFile(
      join(repoDir, 'sprints/S-001.md'),
      sprintYaml('S-001', 'Alpha Sprint', 'workspace/alpha'),
      'utf8',
    );
    await writeFile(
      join(repoDir, 'sprints/S-002.md'),
      sprintYaml('S-002', 'Beta Sprint', 'workspace/beta'),
      'utf8',
    );
    await writeFile(join(repoDir, 'queues/main.md'), queueYaml(), 'utf8');
    await commitAll(repoDir, 'chore: repokernel project files');
  });

  afterEach(async () => {
    // prune stale worktree refs before deleting dirs
    await execFileAsync('git', ['-C', repoDir, 'worktree', 'prune']).catch(() => null);
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreesDir, { recursive: true, force: true });
    // also clean up any sprint worktrees adjacent to the worktreesDir
    const wt = join(worktreesDir, '..', `.rk-e2e-wt-${basename(worktreesDir)}`);
    await rm(wt, { recursive: true, force: true }).catch(() => null);
  });

  it('runs two sprints in parallel, pauses for reviews, resumes to shipped', async () => {
    // 1. Start the parallel run — should pause at awaiting_reviews
    const result1 = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    expect(
      result1.exitCode,
      `run failed:\nstdout: ${result1.stdout}\nstderr: ${result1.stderr}`,
    ).toBe(0);

    // 2. Find run ID and review IDs from run state
    const opRoot = join(repoDir, '.git', 'repokernel');
    const runsDir = join(opRoot, 'runs');
    const runFiles = await readdir(runsDir);
    const runId = runFiles.find((f) => f.endsWith('.json'))?.replace('.json', '');
    expect(runId).toMatch(/^RUN-\d+$/);

    const runJson = JSON.parse(await readFile(join(runsDir, `${runId}.json`), 'utf8'));
    expect(runJson.halt_reason).toBe('awaiting_reviews');

    const reviewIds: string[] = runJson.pending_wave?.awaiting_reviews ?? [];
    expect(reviewIds).toHaveLength(2);

    // 3. Verify fake agent committed output files into sprint worktrees
    //    (branches exist in the main repo at this point)
    const sprintBranches: string[] = Object.values(runJson.pending_wave?.branches ?? {});
    expect(sprintBranches).toHaveLength(2);
    for (const branch of sprintBranches) {
      const log = await git(repoDir, 'log', '--oneline', branch);
      expect(log).toContain('fake implementation');
    }

    // 4. Set verdict to accepted on both reviews
    for (const reviewId of reviewIds) {
      const verdictResult = await runReviewVerdictCommand(reviewId, 'accepted', {
        cwd: repoDir,
        dryRun: false,
        json: false,
      });
      expect(
        verdictResult.exitCode,
        `verdict failed for ${reviewId}: ${verdictResult.stderr}`,
      ).toBe(0);
    }

    // 5. Resume — should merge both sprint branches, close sprints, epic_completed
    const result2 = await runRunCommand({
      cwd: repoDir,
      agent: 'fake',
      resume: runId!,
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
    });

    expect(
      result2.exitCode,
      `resume failed:\nstdout: ${result2.stdout}\nstderr: ${result2.stderr}`,
    ).toBe(0);

    // 6. Verify both sprints are shipped in the main repo working tree
    const sprint1Data = await readFm(join(repoDir, 'sprints/S-001.md'));
    const sprint2Data = await readFm(join(repoDir, 'sprints/S-002.md'));

    expect(sprint1Data.status).toBe('shipped');
    expect(sprint1Data.end_sha).toBeTruthy();
    expect(sprint1Data.closed_at).toBeTruthy();

    expect(sprint2Data.status).toBe('shipped');
    expect(sprint2Data.end_sha).toBeTruthy();
    expect(sprint2Data.closed_at).toBeTruthy();

    // 7. Verify run file shows completed with 2 sprints
    const finalRunJson = JSON.parse(await readFile(join(runsDir, `${runId}.json`), 'utf8'));
    expect(finalRunJson.status).toBe('completed');
    expect(finalRunJson.halt_reason).toBe('epic_completed');
    expect(finalRunJson.completed_sprints).toHaveLength(2);

    const completedIds = finalRunJson.completed_sprints.map((r: { id: string }) => r.id).sort();
    expect(completedIds).toEqual(['S-001', 'S-002']);

    // 8. Verify fake output files are in the main repo's git log (merged)
    const mainLog = await git(repoDir, 'log', '--oneline', '-10');
    expect(mainLog).toContain('fake implementation');
  });
});
