import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const RK_BIN = resolve(__dirname, '..', 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(RK_BIN)) {
    throw new Error(
      `dist/index.js not found at ${RK_BIN}. Run \`pnpm -r build\` (or \`pnpm test\` from repo root) before running this file directly.`,
    );
  }
});

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface MakeProjectOptions {
  /** How many epics to scaffold. Default 1. Use a high value (>50) to drive
   *  rk JSON output past the OS pipe buffer (~16-64 KiB), which is required
   *  to actually exercise the stdout-flush race condition Fix 1 closes. */
  readonly epicCount?: number;
}

async function makeProject(opts: MakeProjectOptions = {}): Promise<string> {
  const epicCount = opts.epicCount ?? 1;
  const dir = await mkdtemp(join(tmpdir(), 'rk-cwd-'));
  tracked.push(dir);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@rk.test']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'RK Test']);

  await writeFile(
    join(dir, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: cwd-test
projectName: CWD Resolution Test
paths:
  epics: .agents/plan/epics
  sprints: .agents/plan/sprints
  reviews: .agents/plan/reviews
  queues: .agents/plan/queues
  lanes: .agents/plan/lanes
  generated: .agents
  registry: .agents/registry.json
`,
    'utf8',
  );
  for (const p of [
    '.agents/plan/epics',
    '.agents/plan/sprints',
    '.agents/plan/reviews',
    '.agents/plan/queues',
    '.agents/plan/lanes',
  ]) {
    await mkdir(join(dir, p), { recursive: true });
    await writeFile(join(dir, p, '.gitkeep'), '', 'utf8');
  }
  for (let i = 1; i <= epicCount; i++) {
    const id = `E-${String(i).padStart(3, '0')}`;
    await writeFile(
      join(dir, `.agents/plan/epics/${id}.md`),
      `---
id: ${id}
title: Epic ${id} for cwd-resolution stress test (long title to push JSON payload above pipe buffer)
status: active
adr_links: []
sprints: []
---

# ${id}: Epic ${id}
`,
      'utf8',
    );
  }
  await writeFile(join(dir, '.agents/registry.json'), '{}', 'utf8');
  await execFileAsync('git', ['-C', dir, 'add', '-A']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

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

/**
 * Wraps `expect(rkResult.exitCode).toBe(0)` so the failure message includes
 * the captured stderr — without this, a crashed `rk` invocation reports only
 * `exitCode: 1` and the operator has to guess.
 */
function expectExit0(r: RkResult, hint = ''): void {
  if (r.exitCode === 0) return;
  const where = hint ? `(${hint}) ` : '';
  throw new Error(
    `${where}rk exited ${r.exitCode}\nstderr:\n${r.stderr || '(empty)'}\nstdout:\n${r.stdout || '(empty)'}`,
  );
}

describe('CLI: stdout flushed before exit (Fix 1)', () => {
  it('rk ls epics --json with 100 epics survives pipe-buffer truncation', async () => {
    // 100 epics × ~250 bytes/epic ≈ 25 KiB, comfortably above macOS/Linux
    // default pipe buffer (16-64 KiB). On pre-Fix-1 code this assertion
    // would fail because process.exit() truncates the unflushed tail of
    // stdout when the buffer cannot drain synchronously.
    const dir = await makeProject({ epicCount: 100 });
    const r = await rk(dir, ['ls', 'epics', '--json']);
    expectExit0(r, 'large fixture');
    expect(r.stdout.length).toBeGreaterThan(16 * 1024);
    const parsed = JSON.parse(r.stdout) as { epics: { id: string }[] };
    expect(parsed.epics.length).toBe(100);
    // Last entry intact == no tail truncation.
    expect(parsed.epics.at(-1)?.id).toBe('E-100');
  });

  it('rk create epic writes a file AND emits non-empty stdout', async () => {
    const dir = await makeProject();
    const r = await rk(dir, ['create', 'epic', 'flush-test']);
    expectExit0(r);
    expect(r.stdout.length).toBeGreaterThan(0);
    // File should exist on disk after the command returns.
    const ls = await execFileAsync('ls', [join(dir, '.agents/plan/epics')]);
    expect(ls.stdout).toMatch(/E-\d{3}.*\.md/);
  });

  it('mutation-guard rejection is flushed to stderr (RuntimeError → main catch)', async () => {
    // Pre-fix: the RepoKernelError thrown by mutateSprintFrontmatter
    // bubbled to main()'s catch block which did stderr.write + process.exit
    // synchronously — under a pipe, the message was truncated. Post-fix,
    // main() routes through exitWithResult so the message survives.
    const dir = await makeProject();
    // Trigger a usage error path that goes through main's catcher.
    const r = await rk(dir, ['validate', '--fail-on', 'BOGUS']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stderr).toMatch(/invalid --fail-on value/);
  });
});

describe('CLI: nested subcommands resolve config from a subdirectory (Fix 5)', () => {
  it('rk validate works from a deep subdirectory', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/epics');
    const r = await rk(deep, ['validate', '--fail-on', 'P0,P1', '--json']);
    expectExit0(r, 'validate from subdir');
    const parsed = JSON.parse(r.stdout) as { configPath: string; findings: unknown[] };
    // Positive assertion: validate actually loaded the project's config from
    // the parent dir (not "no error message in stderr").
    expect(parsed.configPath).toMatch(/repokernel\.config\.yaml$/);
    expect(parsed.findings).toEqual([]);
  });

  it('rk epic status works from a deep subdirectory (two-level subcommand)', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/sprints');
    const r = await rk(deep, ['epic', 'status', 'E-001', '--json']);
    expectExit0(r, 'epic status from subdir');
    const data = JSON.parse(r.stdout) as { id: string; title: string };
    expect(data.id).toBe('E-001');
    expect(data.title).toContain('Epic E-001');
  });

  it('rk epic ls works from a deep subdirectory', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/reviews');
    const r = await rk(deep, ['epic', 'ls', '--json']);
    expectExit0(r, 'epic ls from subdir');
    const data = JSON.parse(r.stdout) as { epics: { id: string }[] };
    expect(data.epics.some((e) => e.id === 'E-001')).toBe(true);
  });

  it('rk ls epics --unshipped works from a deep subdirectory', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/queues');
    const r = await rk(deep, ['ls', 'epics', '--unshipped', '--json']);
    expectExit0(r, 'ls epics --unshipped from subdir');
    const data = JSON.parse(r.stdout) as { epics: { id: string }[] };
    expect(data.epics.some((e) => e.id === 'E-001')).toBe(true);
  });

  it('rk runs (single-level subcommand from subdir) works', async () => {
    const dir = await makeProject();
    const deep = join(dir, '.agents/plan/epics');
    const r = await rk(deep, ['runs', '--json']);
    expectExit0(r, 'runs from subdir');
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe('CLI: usage errors map to EXIT_USAGE (64)', () => {
  it('rk ls epics --unshipped --status active errors with EXIT_USAGE', async () => {
    const dir = await makeProject();
    const r = await rk(dir, ['ls', 'epics', '--unshipped', '--status', 'active']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  it('rk ls epics --status bogus errors with EXIT_USAGE (post-validation)', async () => {
    const dir = await makeProject();
    const r = await rk(dir, ['ls', 'epics', '--status', 'bogus']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/invalid --status/);
  });

  it('rk run --mode autonomus exits EXIT_USAGE (no silent fallback)', async () => {
    const dir = await makeProject();
    const r = await rk(dir, ['run', 'E-001', '--mode', 'autonomus', '--dry-run', '--no-worktree']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/invalid --mode value "autonomus"/);
  });

  it('rk runs --status nope --json exits EXIT_USAGE', async () => {
    const dir = await makeProject();
    const r = await rk(dir, ['runs', '--status', 'nope', '--json']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/invalid --status value "nope"/);
  });

  it('rk runs --status running --json accepts a valid status', async () => {
    const dir = await makeProject();
    const r = await rk(dir, ['runs', '--status', 'running', '--json']);
    expectExit0(r, 'runs filtered by status');
    const parsed = JSON.parse(r.stdout) as { runs: unknown[] };
    expect(Array.isArray(parsed.runs)).toBe(true);
  });
});
