import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const RK_BIN = resolve(__dirname, '..', 'dist', 'index.js');

beforeAll(async () => {
  // Ensure dist/index.js is built. The CLI repros below shell out to it.
  try {
    await execFileAsync('node', [RK_BIN, '--version']);
  } catch (cause) {
    throw new Error(
      `dist/index.js not found at ${RK_BIN}. Run \`pnpm -r build\` before this file. ${(cause as Error).message}`,
    );
  }
});

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface RkResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function rk(cwd: string, args: readonly string[]): Promise<RkResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [RK_BIN, ...args], { cwd });
    return { exitCode: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function makeRkRepo(): Promise<{ cwd: string; opRoot: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-recover-'));
  tracked.push(cwd);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'r@rk.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'R']);
  await writeFile(
    join(cwd, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: pr6
projectName: PR6 Recovery Fixture
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
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-m', 'init']);
  const opRoot = join(cwd, '.git', 'repokernel');
  await mkdir(opRoot, { recursive: true });
  return { cwd, opRoot };
}

describe('rk recover (PR6 finding 11)', () => {
  it('preview reports a corrupt worktrees.json without modifying anything', async () => {
    const { cwd, opRoot } = await makeRkRepo();
    const wt = join(opRoot, 'worktrees.json');
    await writeFile(wt, 'this is { not valid json', 'utf8');

    const r = await rk(cwd, ['recover', '--preview', '--json']);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      findings: Array<{ kind: string; path: string }>;
      actions: unknown[];
    };
    expect(parsed.findings.some((f) => f.kind === 'corrupt_worktrees_json')).toBe(true);
    expect(parsed.actions).toEqual([]);
    // File untouched.
    expect(await readFile(wt, 'utf8')).toBe('this is { not valid json');
  });

  it('apply quarantines corrupt worktrees.json and rebuilds from git worktree list', async () => {
    const { cwd, opRoot } = await makeRkRepo();
    const wt = join(opRoot, 'worktrees.json');
    await writeFile(wt, '{"truncated": [', 'utf8');

    const r = await rk(cwd, ['recover', '--apply', '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      findings: Array<{ kind: string }>;
      actions: Array<{ kind: string; path: string }>;
    };
    expect(parsed.findings.some((f) => f.kind === 'corrupt_worktrees_json')).toBe(true);
    expect(parsed.actions.some((a) => a.kind === 'quarantine_worktrees_json')).toBe(true);
    expect(parsed.actions.some((a) => a.kind === 'rebuild_worktrees_json')).toBe(true);

    const entries = await readdir(opRoot);
    expect(entries.some((e) => e.startsWith('worktrees.json.corrupt.'))).toBe(true);
    // Rebuilt file is valid JSON.
    const rebuilt = JSON.parse(await readFile(wt, 'utf8'));
    expect(Array.isArray(rebuilt.worktrees)).toBe(true);
  });

  it('reports a corrupt RUN-NNN.json file but never silently hides it', async () => {
    const { cwd, opRoot } = await makeRkRepo();
    const runsDir = join(opRoot, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-001.json'), 'not json at all', 'utf8');

    const preview = await rk(cwd, ['recover', '--preview', '--json']);
    expect(preview.exitCode).toBe(1);
    const previewParsed = JSON.parse(preview.stdout) as {
      findings: Array<{ kind: string; path: string }>;
    };
    const finding = previewParsed.findings.find((f) => f.kind === 'corrupt_run_file');
    expect(finding).toBeDefined();
    expect(finding?.path.endsWith('RUN-001.json')).toBe(true);

    // The run is NOT silently hidden by `rk runs --json` — it would
    // continue to be skipped from the table (legacy behavior), but
    // recover surfaces the corruption.
    const apply = await rk(cwd, ['recover', '--apply', '--json']);
    expect(apply.exitCode).toBe(0);
    const applyParsed = JSON.parse(apply.stdout) as {
      actions: Array<{ kind: string }>;
    };
    expect(applyParsed.actions.some((a) => a.kind === 'quarantine_run_file')).toBe(true);
    const after = await readdir(runsDir);
    expect(after.some((f) => f.startsWith('RUN-001.json.corrupt.'))).toBe(true);
    expect(after.some((f) => f === 'RUN-001.json')).toBe(false);
  });

  it('reports a stale lane claim whose owning pid is dead, and releases on apply', async () => {
    const { cwd, opRoot } = await makeRkRepo();
    const lanesDir = join(opRoot, 'lanes');
    await mkdir(lanesDir, { recursive: true });
    // PID 1 is init — assume not the running process. Use 2_000_001 which is
    // outside any reasonable PID range.
    await writeFile(
      join(lanesDir, 'main.json'),
      JSON.stringify({
        lane: 'main',
        run_id: 'RUN-999',
        epic_id: 'E-001',
        worktree: '/wt',
        branch: 'rk/RUN-999',
        claimed_at: new Date().toISOString(),
        pid: 2_000_001,
      }),
      'utf8',
    );

    const preview = await rk(cwd, ['recover', '--preview', '--json']);
    expect(preview.exitCode).toBe(1);
    const parsed = JSON.parse(preview.stdout) as {
      findings: Array<{ kind: string }>;
    };
    expect(
      parsed.findings.some((f) => f.kind === 'orphan_lane_pid' || f.kind === 'stale_lane_claim'),
    ).toBe(true);

    const apply = await rk(cwd, ['recover', '--apply', '--json']);
    expect(apply.exitCode).toBe(0);
    const applyParsed = JSON.parse(apply.stdout) as {
      actions: Array<{ kind: string }>;
    };
    expect(applyParsed.actions.some((a) => a.kind === 'release_stale_lane')).toBe(true);
  });

  it('healthy operational state returns zero findings', async () => {
    const { cwd, opRoot } = await makeRkRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '{"worktrees": []}', 'utf8');

    const r = await rk(cwd, ['recover', '--preview', '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { findings: unknown[] };
    expect(parsed.findings).toEqual([]);
  });

  it('rk doctor surfaces corrupt worktrees.json as a problem', async () => {
    const { cwd, opRoot } = await makeRkRepo();
    await writeFile(join(opRoot, 'worktrees.json'), '!!!', 'utf8');

    const r = await rk(cwd, ['doctor', '--json']);
    expect(r.exitCode).not.toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      problems: Array<{ title: string; fix: string[] }>;
    };
    const op = parsed.problems.find((p) => p.title.includes('Corrupt operational state'));
    expect(op).toBeDefined();
    expect(op?.fix.some((f) => f.startsWith('rk recover'))).toBe(true);
  });
});
