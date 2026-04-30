import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runRunsCommand } from '../src/commands/runs.js';

const execFileAsync = promisify(execFile);

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRkRepo(): Promise<string> {
  // Canonicalize via realpath: on macOS, mkdtemp returns the symlinked
  // /var/folders path while git's --git-common-dir realpath-resolves to
  // /private/var/folders. Without canonicalizing here, our manual writes
  // to <cwd>/.git/repokernel/runs/* land on a different filesystem
  // location than runRunsCommand reads from (cf. PR1 normalizeGitPath).
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'rk-runs-cmd-')));
  tracked.push(cwd);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 't@rk.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'T']);
  await writeFile(
    join(cwd, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: pr9
projectName: PR9 runs cmd fixture
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
    'utf8',
  );
  for (const p of ['epics', 'sprints', 'reviews', 'queues', 'lanes']) {
    await mkdir(join(cwd, p), { recursive: true });
  }
  return cwd;
}

function makeRun(id: string, status: 'running' | 'paused' | 'completed' | 'aborted' | 'failed') {
  return {
    id,
    epic_id: 'E-001',
    lane: 'main',
    status,
    mode: 'assisted',
    agent: 'fake',
    worktree: '/tmp/wt',
    branch: 'rk/RUN-001',
    started_at: '2026-04-25T10:00:00Z',
    ended_at: null,
    current_sprint: null,
    completed_sprints: [],
    halt_reason: null,
    limit: null,
    sprint_count: 0,
  };
}

describe('runRunsCommand (PR9 backfill)', () => {
  it('returns "(no runs found)" when no runs/ directory exists', async () => {
    const cwd = await makeRkRepo();
    const r = await runRunsCommand({ cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(no runs found)');
  });

  it('returns empty runs array under --json when none exist', async () => {
    const cwd = await makeRkRepo();
    const r = await runRunsCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { runs: unknown[] };
    expect(parsed.runs).toEqual([]);
  });

  it('lists a healthy run as JSON when present', async () => {
    const cwd = await makeRkRepo();
    const opRoot = join(cwd, '.git', 'repokernel');
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, 'RUN-001.json'),
      JSON.stringify(makeRun('RUN-001', 'completed')),
      'utf8',
    );
    const r = await runRunsCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { runs: Array<{ id: string }> };
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.id).toBe('RUN-001');
  });

  it('filters by status when supplied', async () => {
    const cwd = await makeRkRepo();
    const opRoot = join(cwd, '.git', 'repokernel');
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, 'RUN-001.json'),
      JSON.stringify(makeRun('RUN-001', 'completed')),
      'utf8',
    );
    await writeFile(
      join(runsDir, 'RUN-002.json'),
      JSON.stringify(makeRun('RUN-002', 'paused')),
      'utf8',
    );

    const completed = await runRunsCommand({ cwd, status: 'completed', json: true });
    const completedParsed = JSON.parse(completed.stdout) as { runs: Array<{ id: string }> };
    expect(completedParsed.runs.map((x) => x.id)).toEqual(['RUN-001']);

    const paused = await runRunsCommand({ cwd, status: 'paused', json: true });
    const pausedParsed = JSON.parse(paused.stdout) as { runs: Array<{ id: string }> };
    expect(pausedParsed.runs.map((x) => x.id)).toEqual(['RUN-002']);
  });

  it('renders a table-shaped stdout when --json is false and runs exist', async () => {
    const cwd = await makeRkRepo();
    const opRoot = join(cwd, '.git', 'repokernel');
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, 'RUN-001.json'),
      JSON.stringify(makeRun('RUN-001', 'completed')),
      'utf8',
    );
    const r = await runRunsCommand({ cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('RUN-ID');
    expect(r.stdout).toContain('RUN-001');
  });
});
