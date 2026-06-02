import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runCloseCommand,
  runReReviewCommand,
  runReviewCommand,
  runReviewVerdictCommand,
} from '../src/commands/lifecycle.js';
import { runReviewCreateCommand } from '../src/commands/reviewCreate.js';
import { runReviewSprintCommand } from '../src/commands/reviewSprint.js';
import { closeAfterMerge } from '../src/lifecycle/parallelRunner.js';
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

function gatedConfig(defaultReviewer = 'codex', secondReviewer = false): string {
  return `${defaultConfigYaml()}automation:
  defaultReviewer: ${defaultReviewer}
  reviewers:
    codex:
      authMode: chatgpt
${secondReviewer ? '    codex2:\n      authMode: chatgpt\n' : ''}`;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}
function commit(cwd: string, message: string): void {
  git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message]);
}
function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  commit(cwd, message);
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
  readonly gated?: boolean;
  readonly defaultReviewer?: string;
  readonly secondReviewer?: boolean;
}): Promise<{ readonly cwd: string; readonly codexHome: string }> {
  const cwd = await realpath(
    await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content:
          opts.gated === false
            ? defaultConfigYaml()
            : gatedConfig(opts.defaultReviewer, opts.secondReviewer),
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

/** Drive the full gated path to an about-to-close state: gate + built-in green, committed. */
async function reviewAndSprint(cwd: string): Promise<void> {
  await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
  await runReviewSprintCommand('S-001', { cwd, dryRun: false, json: false });
  commitAll(cwd, 'record review-sprint verdict');
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

describe('reviewer-gate enforcement at close', () => {
  it('allows close when the gate snapshot AND the built-in verdict are both accepted', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd);
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
  });

  it('blocks close when review-sprint accepts but the gate snapshot is changes_requested', async () => {
    const b = await build({ command: CHANGES });
    process.env.CODEX_HOME = b.codexHome;
    // gate → changes_requested snapshot; review-sprint built-in → accepted verdict.
    await reviewAndSprint(b.cwd);
    expect((await reviewData(b.cwd)).verdict).toBe('accepted');
    expect((await reviewData(b.cwd)).reviewer_gate as Record<string, unknown>).toMatchObject({
      verdict: 'changes_requested',
    });
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_NOT_ACCEPTED|gate verdict/i);
  });

  it('blocks close when the snapshot signature is tampered (forgery)', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd);
    // Forge: flip the signature in the committed review file.
    const file = join(b.cwd, 'reviews/R-001.md');
    const parsed = matter(await readFile(file, 'utf8'));
    const gate = parsed.data.reviewer_gate as Record<string, unknown>;
    gate.signature = 'f'.repeat(64);
    await writeFile(file, matter.stringify(parsed.content, parsed.data), 'utf8');
    commitAll(b.cwd, 'tamper signature');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_SIGNATURE_INVALID|forged/i);
  });

  it('blocks close when re-review bumps the attempt past the gated snapshot', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    // Gate accepted at attempt 1 (snapshot signed for attempt 1).
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect((await reviewData(b.cwd)).reviewer_gate as Record<string, unknown>).toMatchObject({
      review_attempt: 1,
    });
    // Force a non-accepted verdict so re-review will reopen, bumping to attempt 2.
    await runReviewVerdictCommand('R-001', 'changes_requested', {
      cwd: b.cwd,
      dryRun: false,
      json: false,
    });
    await runReReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    await runReviewSprintCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    commitAll(b.cwd, 'reopen + re-eval');
    // Built-in verdict is accepted again, but the gate snapshot is still attempt 1.
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_ATTEMPT_MISMATCH|attempt/i);
  });

  it('blocks close when the gate snapshot is cleared and only review.verdict is set', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd);
    // Strip the snapshot, leaving review.verdict accepted — the classic
    // "trust review.verdict alone" bypass the snapshot model closes.
    const file = join(b.cwd, 'reviews/R-001.md');
    const parsed = matter(await readFile(file, 'utf8'));
    delete parsed.data.reviewer_gate;
    await writeFile(file, matter.stringify(parsed.content, parsed.data), 'utf8');
    commitAll(b.cwd, 'strip snapshot, keep accepted verdict');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_MISSING|reviewer gate/i);
  });

  it('blocks close when the review reviewer has no configured gate (reviewer dodge)', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    // Stamp an ungated reviewer; project still configures the codex gate.
    await runReviewCreateCommand({ cwd: b.cwd, sprintId: 'S-001', json: false, reviewer: 'ghost' });
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    await runReviewVerdictCommand('R-001', 'accepted', { cwd: b.cwd, dryRun: false, json: false });
    commitAll(b.cwd, 'ungated reviewer');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_MISSING|ghost|no configured/i);
  });

  it('does not let --skip-checks bypass a stale gate snapshot', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd);
    await writeFile(join(b.cwd, 'src/foo.ts'), 'export const v = 42;\n', 'utf8');
    commitAll(b.cwd, 'edit after gate');
    const r = await runCloseCommand('S-001', {
      cwd: b.cwd,
      dryRun: false,
      json: false,
      skipChecks: true,
    });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_STALE|changed since/i);
  });

  it('migration: a non-gated project with a legacy accepted review still closes', async () => {
    const b = await build({ command: ACCEPT, gated: false });
    process.env.CODEX_HOME = b.codexHome;
    // No reviewer gate configured ⇒ legacy verdict-only path, no snapshot required.
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    await runReviewSprintCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    commitAll(b.cwd, 'legacy verdict');
    expect((await reviewData(b.cwd)).reviewer_gate).toBeUndefined();
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
  });

  it('blocks close of a sprint that links another sprint signed review (cross-sprint lift)', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd); // S-001 + R-001 snapshot signed for sprint_id S-001
    const head = execFileSync('git', ['-C', b.cwd, 'rev-parse', 'HEAD']).toString().trim();
    await writeFile(
      join(b.cwd, 'sprints/S-002.md'),
      fm({
        id: 'S-002',
        title: 'Two',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        allowed_paths: ['src/**'],
        review_required: true,
        review_id: 'R-001',
        base_sha: head,
      }),
      'utf8',
    );
    commitAll(b.cwd, 'S-002 points at R-001');
    const r = await runCloseCommand('S-002', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/targets sprint S-001|REVIEWER_GATE/i);
  });

  it('blocks close when the snapshot reviewer differs from the stamped reviewer', async () => {
    const b = await build({ command: ACCEPT, secondReviewer: true });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd); // snapshot.reviewer = codex
    const file = join(b.cwd, 'reviews/R-001.md');
    const parsed = matter(await readFile(file, 'utf8'));
    parsed.data.reviewer = 'codex2'; // configured, but not who signed the snapshot
    await writeFile(file, matter.stringify(parsed.content, parsed.data), 'utf8');
    commitAll(b.cwd, 're-stamp reviewer');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(
      /produced by "codex"|REVIEWER_GATE_SIGNATURE_INVALID/i,
    );
  });

  it('enforces a gate stamped with a configured non-default reviewer (ungated default)', async () => {
    const b = await build({ command: CHANGES, defaultReviewer: 'manual' });
    process.env.CODEX_HOME = b.codexHome;
    // default reviewer "manual" has no gate, but the review is stamped codex (gated).
    await runReviewCreateCommand({ cwd: b.cwd, sprintId: 'S-001', json: false, reviewer: 'codex' });
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    await runReviewSprintCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    commitAll(b.cwd, 'gated by non-default reviewer');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_NOT_ACCEPTED|gate verdict/i);
  });

  it('blocks close when the sprint scope changed after the gate', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd);
    const sf = join(b.cwd, 'sprints/S-001.md');
    const parsed = matter(await readFile(sf, 'utf8'));
    parsed.data.allowed_paths = ['**']; // widen scope post-gate
    await writeFile(sf, matter.stringify(parsed.content, parsed.data), 'utf8');
    commitAll(b.cwd, 'widen scope');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/different scope|REVIEWER_GATE_STALE/i);
  });

  it('blocks close when the project config changed after the gate', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd);
    await writeFile(join(b.cwd, 'repokernel.config.yaml'), `${gatedConfig()}# touched\n`, 'utf8');
    commitAll(b.cwd, 'touch config');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/config .*changed|REVIEWER_GATE_STALE/i);
  });

  // Parallel autonomous close path: must honor BOTH lanes, not bypass them.
  it('closeAfterMerge fails closed when the gate snapshot is not accepted', async () => {
    const b = await build({ command: CHANGES });
    process.env.CODEX_HOME = b.codexHome;
    // Built-in verdict accepted (review-sprint), but the gate snapshot is
    // changes_requested — the gate lane must still block.
    await reviewAndSprint(b.cwd);
    await expect(closeAfterMerge('S-001', 'R-001', b.cwd)).rejects.toThrow(
      /reviewer gate blocked/i,
    );
  });

  it('closeAfterMerge fails closed when the built-in verdict is not accepted', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    // Gate accepted, but review.verdict left pending (no review-sprint) — the
    // built-in lane must block (closeAfterMerge must not ship a pending review).
    await runReviewCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    await expect(closeAfterMerge('S-001', 'R-001', b.cwd)).rejects.toThrow(/not accepted/i);
  });

  it('closeAfterMerge ships when both the gate and the built-in verdict are accepted', async () => {
    const b = await build({ command: ACCEPT });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd);
    await expect(closeAfterMerge('S-001', 'R-001', b.cwd)).resolves.toBeDefined();
  });

  it('a recorded snapshot is enforced even if config later opts out of review', async () => {
    const b = await build({ command: CHANGES });
    process.env.CODEX_HOME = b.codexHome;
    await reviewAndSprint(b.cwd); // changes_requested snapshot recorded
    // Opt out of review at the project level AFTER the gate ran, keeping the
    // reviewer config so only the requirement is weakened.
    await writeFile(
      join(b.cwd, 'repokernel.config.yaml'),
      `${gatedConfig()}policies:\n  requireReviewForShipped: false\n`,
      'utf8',
    );
    commitAll(b.cwd, 'opt out of review post-gate');
    const r = await runCloseCommand('S-001', { cwd: b.cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/REVIEWER_GATE_NOT_ACCEPTED|gate verdict/i);
  });
});
