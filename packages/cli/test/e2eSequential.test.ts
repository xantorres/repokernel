/**
 * E2E: sequential run with fake agent
 *
 * Uses a real git repo — no mocks. Proves the full sequential flow:
 *   rk run E-001 --agent fake --limit 1
 *   (commit metadata)
 *   rk review-verdict R-001 accepted
 *   (commit verdict)
 *   rk run --resume RUN-001
 *   → sprint shipped, run completed
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const dir = await mkdtemp(join(tmpdir(), 'rk-e2e-'));
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@repokernel.test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'RepoKernel Test']);
  // Initial commit so HEAD exists
  await commitAll(dir, 'chore: init');
  return dir;
}

function configYaml(): string {
  return `schemaVersion: 1
projectId: e2e-test
projectName: E2E Test
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
policies:
  requireReviewForShipped: false
`;
}

function epicYaml(): string {
  return `---
id: "E-001"
title: "E2E Epic"
status: "planned"
sprints:
  - "S-001"
---
`;
}

function sprintYaml(): string {
  return `---
id: "S-001"
title: "E2E Sprint"
epic_id: "E-001"
status: "queued"
lane: "main"
review_required: false
allowed_paths:
  - "workspace"
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
---
`;
}

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

// — tests —

describe('E2E: sequential fake agent run', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeGitRepo();

    // Write project files
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(repoDir, 'epics'), { recursive: true });
    await mkdir(join(repoDir, 'sprints'), { recursive: true });
    await mkdir(join(repoDir, 'reviews'), { recursive: true });
    await mkdir(join(repoDir, 'queues'), { recursive: true });
    await mkdir(join(repoDir, 'lanes'), { recursive: true });
    await mkdir(join(repoDir, '.repokernel'), { recursive: true });

    await writeFile(join(repoDir, 'repokernel.config.yaml'), configYaml(), 'utf8');
    await writeFile(join(repoDir, 'epics/E-001.md'), epicYaml(), 'utf8');
    await writeFile(join(repoDir, 'sprints/S-001.md'), sprintYaml(), 'utf8');
    await writeFile(join(repoDir, 'queues/main.md'), queueYaml(), 'utf8');
    await commitAll(repoDir, 'chore: repokernel project files');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('runs sprint to awaiting_review, resumes to shipped', async () => {
    // 1. Start the run — should pause at awaiting_review
    const result1 = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'assisted',
      limit: 1,
      worktree: false,
      dryRun: false,
    });

    expect(result1.exitCode, `run failed: ${result1.stderr}`).toBe(0);

    // 2. Verify sprint moved to review status
    const sprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(sprintData.status).toBe('review');
    expect(sprintData.review_id).toMatch(/^R-\d+$/);

    const reviewId = sprintData.review_id as string;

    // 3. Verify fake agent committed an output file
    const log = await git(repoDir, 'log', '--oneline', '-5');
    expect(log).toContain('fake implementation');

    // 4. Commit the metadata changes left by rk review
    //    (sprint frontmatter, review stub, registry — not committed by lifecycle commands)
    await commitAll(repoDir, 'chore: review metadata');

    // 5. Set verdict to accepted
    const verdictResult = await runReviewVerdictCommand(reviewId, 'accepted', {
      cwd: repoDir,
      dryRun: false,
      json: false,
    });
    expect(verdictResult.exitCode, `verdict failed: ${verdictResult.stderr}`).toBe(0);

    // 6. Commit verdict update
    await commitAll(repoDir, 'chore: accepted verdict');

    // 7. Find the run ID
    const opRoot = join(repoDir, '.git', 'repokernel');
    const runsDir = join(opRoot, 'runs');
    const runFiles = await readdir(runsDir);
    const runId = runFiles.find((f) => f.endsWith('.json'))?.replace('.json', '');
    expect(runId).toMatch(/^RUN-\d+$/);

    // 8. Resume — should close S-001 and complete (epic_completed or limit_reached)
    const result2 = await runRunCommand({
      cwd: repoDir,
      agent: 'fake',
      resume: runId!,
      mode: 'assisted',
      worktree: false,
      dryRun: false,
    });

    expect(result2.exitCode, `resume failed: ${result2.stderr}`).toBe(0);

    // 9. Verify sprint is shipped
    const finalSprintData = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(finalSprintData.status).toBe('shipped');
    expect(finalSprintData.end_sha).toBeTruthy();
    expect(finalSprintData.closed_at).toBeTruthy();

    // 10. Verify run file shows completed
    const runJson = JSON.parse(await readFile(join(runsDir, `${runId}.json`), 'utf8'));
    expect(['completed', 'paused']).toContain(runJson.status);
    expect(runJson.completed_sprints).toHaveLength(1);
    expect(runJson.completed_sprints[0].id).toBe('S-001');
    expect(runJson.completed_sprints[0].verdict).toBe('accepted');
  });
});
