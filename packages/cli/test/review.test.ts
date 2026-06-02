import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloseCommand, runReviewCommand } from '../src/commands/lifecycle.js';
import { runReviewCreateCommand } from '../src/commands/reviewCreate.js';
import { runReviewGateCommand } from '../src/commands/reviewGate.js';
import { runReviewSprintCommand } from '../src/commands/reviewSprint.js';
import {
  cleanupAllFixtures,
  defaultConfigYaml,
  fm,
  makeFixture,
  resetTrustForTest,
  seedTrustForCwd,
} from './helpers/fixture.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');
const ACCEPT = join(FIXTURES, 'accept.sh');
const CHANGES = join(FIXTURES, 'changes.sh');

afterAll(cleanupAllFixtures);

function configYaml(withReviewer: boolean, defaultReviewer = 'codex'): string {
  if (!withReviewer) return defaultConfigYaml();
  return `${defaultConfigYaml()}automation:
  defaultReviewer: ${defaultReviewer}
  reviewers:
    codex:
      authMode: chatgpt
`;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}
function commit(cwd: string, message: string): void {
  git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message]);
}
function sprintFm(extra: Record<string, unknown>): string {
  return fm({
    id: 'S-001',
    title: 'Sprint One',
    epic_id: 'E-001',
    status: 'active',
    lane: 'main',
    allowed_paths: ['src/**'],
    review_required: true,
    ...extra,
  });
}

async function build(opts: {
  readonly command: string;
  readonly withReviewer?: boolean;
  readonly defaultReviewer?: string;
}): Promise<{ readonly cwd: string; readonly codexHome: string }> {
  const cwd = await realpath(
    await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: configYaml(opts.withReviewer !== false, opts.defaultReviewer),
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      { path: 'sprints/S-001.md', content: sprintFm({}) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'src/foo.ts', content: 'export const v = 0;\n' },
    ]),
  );

  git(cwd, ['init', '-q']);
  // Repo-local identity so rk's own metadata commit (rk review auto-commit) has
  // an author/committer in CI, where no global git identity is configured.
  git(cwd, ['config', 'user.email', 'test@repokernel.test']);
  git(cwd, ['config', 'user.name', 'rk-test']);
  git(cwd, ['add', '.']);
  commit(cwd, 'base');
  const baseSha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD']).toString().trim();

  await writeFile(join(cwd, 'sprints/S-001.md'), sprintFm({ base_sha: baseSha }), 'utf8');
  await writeFile(join(cwd, 'src/foo.ts'), 'export const v = 1;\n', 'utf8');
  git(cwd, ['add', '.']);
  commit(cwd, 'work');

  await seedTrustForCwd(cwd, {
    reviewers: {
      codex: {
        command: opts.command,
        args: [],
        env_passthrough: ['CODEX_HOME'],
        timeout_seconds: 10,
      },
    },
  });

  const codexHome = await mkdtemp(join(tmpdir(), 'rk-codexhome-'));
  await writeFile(
    join(codexHome, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }),
    'utf8',
  );
  return { cwd, codexHome };
}

async function reviewData(cwd: string): Promise<Record<string, unknown>> {
  return matter(await readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).data;
}

async function gateOf(cwd: string): Promise<Record<string, unknown> | undefined> {
  return (await reviewData(cwd)).reviewer_gate as Record<string, unknown> | undefined;
}

let originalTrust: string | undefined;
let originalCodexHome: string | undefined;
beforeEach(() => {
  originalTrust = process.env.REPOKERNEL_TRUST_FILE;
  originalCodexHome = process.env.CODEX_HOME;
});
afterEach(() => {
  resetTrustForTest(originalTrust);
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe('rk review (with reviewer gate)', () => {
  it('moves the sprint to review and records the gate verdict + reviewed snapshot', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    const r = await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.stdout).toContain('moved to review');
    expect(r.stdout).toContain('accepted');
    const data = await reviewData(b.cwd);
    // The gate decision + reviewed range are recorded in the signed snapshot,
    // not in review.verdict/end_sha.
    expect(data.verdict).toBe('pending');
    const gate = data.reviewer_gate as Record<string, unknown>;
    expect(gate.verdict).toBe('accepted');
    expect(typeof gate.end_sha).toBe('string');
  });

  it('behaves exactly as before when no reviewer gate is configured', async () => {
    const b = await build({ command: ACCEPT, withReviewer: false });
    process.env.CODEX_HOME = b.codexHome;
    const r = await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.stdout).toContain('moved to review');
    expect(r.stdout).not.toContain('Verdict');
    expect((await reviewData(b.cwd)).verdict).toBe('pending');
  });

  it('gates a review stamped with a configured NON-default reviewer', async () => {
    // defaultReviewer=manual has no gate, but the review is stamped codex (configured).
    const b = await build({ command: ACCEPT, defaultReviewer: 'manual' });
    process.env.CODEX_HOME = b.codexHome;
    await runReviewCreateCommand({ cwd: b.cwd, sprintId: 'S-001', json: false, reviewer: 'codex' });
    const r = await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.stdout).toContain('moved to review');
    expect(r.stdout).toContain('accepted'); // codex gate ran despite default=manual
    expect((await gateOf(b.cwd))?.verdict).toBe('accepted');
  });
});

describe('rk review-create', () => {
  it('is allocation-only by default (no gate, verdict stays pending)', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    const r = await runReviewCreateCommand({ cwd: b.cwd, sprintId: 'S-001', json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Created R-001');
    expect(r.stdout).not.toContain('Verdict');
    expect((await reviewData(b.cwd)).verdict).toBe('pending');
  });

  it('runs the gate with --gate', async () => {
    const b = await build({ command: CHANGES });
    process.env.CODEX_HOME = b.codexHome;
    const r = await runReviewCreateCommand({
      cwd: b.cwd,
      sprintId: 'S-001',
      json: false,
      gate: true,
    });
    expect(r.stdout).toContain('Created R-001');
    expect(r.stdout).toContain('changes_requested');
    expect((await gateOf(b.cwd))?.verdict).toBe('changes_requested');
  });
});

describe('rk close binding (gate end_sha)', () => {
  it('blocks close when the SAME in-scope file is edited after accept', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect((await gateOf(b.cwd))?.verdict).toBe('accepted');
    // Built-in lane must also be green for close to reach the gate freshness
    // check (most-restrictive-wins composition).
    await runReviewSprintCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    // Same filename, new content — a file-SET guard misses this; the gate
    // end_sha content binding must catch it.
    await writeFile(join(b.cwd, 'src/foo.ts'), 'export const v = 99;\n', 'utf8');
    git(b.cwd, ['add', '.']);
    commit(b.cwd, 'sneaky same-file edit');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/changed since|review-gate|REVIEWER_GATE_STALE/i);
  });
});

describe('rk review-gate', () => {
  it('re-runs the configured gate against a linked review', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await runReviewCreateCommand({ cwd: b.cwd, sprintId: 'S-001', json: false });
    expect((await reviewData(b.cwd)).verdict).toBe('pending');
    const r = await runReviewGateCommand('S-001', { cwd: b.cwd, json: false });
    expect(r.stdout).toContain('accepted');
    expect((await gateOf(b.cwd))?.verdict).toBe('accepted');
  });

  it('blocks when the review reviewer has no configured gate', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await runReviewCreateCommand({ cwd: b.cwd, sprintId: 'S-001', json: false, reviewer: 'ghost' });
    const r = await runReviewGateCommand('S-001', { cwd: b.cwd, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/ghost|no gate/i);
  });
});
