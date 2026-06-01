import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloseCommand, runReviewCommand } from '../src/commands/lifecycle.js';
import { runReReviewCommand } from '../src/commands/review.js';
import { runReviewCreateCommand } from '../src/commands/reviewCreate.js';
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

function configYaml(withReviewer: boolean): string {
  if (!withReviewer) return defaultConfigYaml();
  return `${defaultConfigYaml()}automation:
  defaultReviewer: codex
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
}): Promise<{ readonly cwd: string; readonly codexHome: string }> {
  const cwd = await realpath(
    await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(opts.withReviewer !== false) },
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
  it('moves the sprint to review and records the gate verdict', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    const r = await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.stdout).toContain('moved to review');
    expect(r.stdout).toContain('accepted');
    const data = await reviewData(b.cwd);
    expect(data.verdict).toBe('accepted');
    expect(data.review_attempt).toBe(1);
  });

  it('behaves exactly as before when no reviewer gate is configured', async () => {
    const b = await build({ command: ACCEPT, withReviewer: false });
    process.env.CODEX_HOME = b.codexHome;
    const r = await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.stdout).toContain('moved to review');
    expect(r.stdout).not.toContain('Verdict');
    expect((await reviewData(b.cwd)).verdict).toBe('pending');
  });
});

describe('rk re-review', () => {
  it('resets the verdict to pending and increments review_attempt', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect((await reviewData(b.cwd)).review_attempt).toBe(1);

    const r = await runReReviewCommand({ cwd: b.cwd, sprintId: 'S-001', json: true });
    const out = JSON.parse(r.stdout) as { review_attempt: number; verdict: string };
    expect(out.review_attempt).toBe(2);
    expect((await reviewData(b.cwd)).review_attempt).toBe(2);
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
    expect((await reviewData(b.cwd)).verdict).toBe('changes_requested');
  });
});

describe('rk close verdict binding', () => {
  it('blocks close when code changed after the gate accepted', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect((await reviewData(b.cwd)).verdict).toBe('accepted');
    // Sneak a code change in after the accept.
    await writeFile(join(b.cwd, 'src/foo.ts'), 'export const v = 2;\n', 'utf8');
    git(b.cwd, ['add', '.']);
    commit(b.cwd, 'sneaky');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/changed since|re-review/i);
  });

  it('allows close when nothing changed after the accept', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    // The binding must not block (only this sprint's rk metadata changed since review).
    expect(r.stderr).not.toMatch(/changed since|re-review|REVIEW_STALE/i);
    const sprint = matter(await readFile(join(b.cwd, 'sprints/S-001.md'), 'utf8')).data;
    expect(sprint.status).toBe('shipped');
  });
});
