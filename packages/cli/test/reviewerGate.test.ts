import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewerGateConfigSchema } from '@repokernel/core';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED } from '../src/exitCodes.js';
import {
  buildReviewerArgs,
  buildReviewPacket,
  computeOutOfScope,
  type ReviewerGateInput,
  resolveReviewerEnv,
  runReviewerGate,
} from '../src/lifecycle/reviewerGate.js';
import {
  cleanupAllFixtures,
  defaultConfigYaml,
  fm,
  makeFixture,
  resetTrustForTest,
  seedTrustForCwd,
} from './helpers/fixture.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');

afterAll(cleanupAllFixtures);

// ─── pure helpers ────────────────────────────────────────────────────────────

const EXEMPT = [
  'sprints/S-001.md',
  'reviews/R-001.md',
  'queues/main.md',
  '.repokernel/registry.json',
];

describe('computeOutOfScope', () => {
  it('returns nothing when the sprint is unscoped (empty allowed_paths)', () => {
    expect(computeOutOfScope(['anything.ts'], [], EXEMPT)).toEqual([]);
  });
  it('passes in-scope files', () => {
    expect(computeOutOfScope(['src/a.ts', 'src/sub/b.ts'], ['src/**'], EXEMPT)).toEqual([]);
  });
  it('flags committed files outside allowed_paths', () => {
    expect(computeOutOfScope(['src/a.ts', 'lib/x.ts'], ['src/**'], EXEMPT)).toEqual(['lib/x.ts']);
  });
  it("exempts only this sprint's own rk files", () => {
    const committed = [
      'reviews/R-001.md',
      'sprints/S-001.md',
      '.repokernel/registry.json',
      'src/a.ts',
    ];
    expect(computeOutOfScope(committed, ['src/**'], EXEMPT)).toEqual([]);
  });
  it("flags ANOTHER sprint's control file (not exempt)", () => {
    expect(computeOutOfScope(['sprints/S-999.md', 'src/a.ts'], ['src/**'], EXEMPT)).toEqual([
      'sprints/S-999.md',
    ]);
  });
});

describe('buildReviewPacket', () => {
  const packet = buildReviewPacket({
    sprintId: 'S-001',
    reviewId: 'R-001',
    title: 'Add widget',
    objective: 'Implement the widget\nwith two lines',
    allowedPaths: ['src/**'],
    changedFiles: ['src/widget.ts'],
    diff: 'diff --git a/src/widget.ts b/src/widget.ts\n+const x = 1;',
    diffTruncated: false,
    rubricExtras: 'Prefer composition over inheritance.',
  });
  it('labels sprint metadata and diff as untrusted data', () => {
    expect(packet).toContain('BEGIN UNTRUSTED DATA');
    expect(packet).toContain('[sprint-metadata]');
    expect(packet).toContain('[diff]');
    expect(packet).toContain('END UNTRUSTED DATA');
  });
  it('includes the diff, objective, and project rubric extras', () => {
    expect(packet).toContain('+const x = 1;');
    expect(packet).toContain('with two lines');
    expect(packet).toContain('Prefer composition over inheritance.');
  });
  it('asks for the sentinel block', () => {
    expect(packet).toContain('REPOKERNEL_RESULT_START');
    expect(packet).toContain('REPOKERNEL_RESULT_END');
  });
  it('marks a truncated diff', () => {
    const p = buildReviewPacket({
      sprintId: 'S-001',
      reviewId: 'R-001',
      title: 't',
      objective: 'o',
      allowedPaths: [],
      changedFiles: [],
      diff: 'x',
      diffTruncated: true,
    });
    expect(p).toContain('[diff truncated');
  });
});

describe('buildReviewerArgs', () => {
  it('puts only the packet path + fixed flags in argv — never diff content', () => {
    const args = buildReviewerArgs({
      grantArgs: ['exec', '--sandbox', 'read-only'],
      cwd: '/work',
      model: 'gpt-5.5',
      packetPath: '/tmp/x/R-001.packet.md',
    });
    expect(args.slice(0, 3)).toEqual(['exec', '--sandbox', 'read-only']);
    expect(args).toContain('--cd');
    expect(args).toContain('/work');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args.some((a) => a.includes('/tmp/x/R-001.packet.md'))).toBe(true);
    expect(args.join(' ')).not.toContain('diff --git');
  });
  it('omits --model when no model is configured', () => {
    const args = buildReviewerArgs({ grantArgs: [], cwd: '/w', packetPath: '/p' });
    expect(args).not.toContain('--model');
  });
});

describe('resolveReviewerEnv', () => {
  async function writeAuth(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rk-codexhome-'));
    await writeFile(join(dir, 'auth.json'), content, 'utf8');
    return dir;
  }

  it('apikey: errors when OPENAI_API_KEY is absent', async () => {
    const r = await resolveReviewerEnv('apikey', ['OPENAI_API_KEY'], {});
    expect('error' in r && r.error).toMatch(/OPENAI_API_KEY in the environment/);
  });
  it('apikey: errors when the key is present but not granted', async () => {
    const r = await resolveReviewerEnv('apikey', [], { OPENAI_API_KEY: 'sk-x' });
    expect('error' in r && r.error).toMatch(/grant env_passthrough/);
  });
  it('apikey: passes the granted key through', async () => {
    const r = await resolveReviewerEnv('apikey', ['OPENAI_API_KEY'], { OPENAI_API_KEY: 'sk-x' });
    expect('envPassthrough' in r && r.envPassthrough).toContain('OPENAI_API_KEY');
  });
  it('chatgpt: errors when auth.json is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-codexhome-'));
    const r = await resolveReviewerEnv('chatgpt', ['CODEX_HOME'], { CODEX_HOME: dir });
    expect('error' in r && r.error).toMatch(/could not read/);
  });
  it('chatgpt: errors when auth_mode is not chatgpt', async () => {
    const dir = await writeAuth(JSON.stringify({ auth_mode: 'apikey', tokens: { a: 1 } }));
    const r = await resolveReviewerEnv('chatgpt', ['CODEX_HOME'], { CODEX_HOME: dir });
    expect('error' in r && r.error).toMatch(/auth_mode "chatgpt"/);
  });
  it('chatgpt: succeeds and strips OPENAI_* from passthrough', async () => {
    const dir = await writeAuth(
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }),
    );
    const r = await resolveReviewerEnv('chatgpt', ['CODEX_HOME', 'OPENAI_API_KEY'], {
      CODEX_HOME: dir,
    });
    expect('envPassthrough' in r).toBe(true);
    if ('envPassthrough' in r) {
      expect(r.envPassthrough).toContain('CODEX_HOME');
      expect(r.envPassthrough).not.toContain('OPENAI_API_KEY');
    }
  });
});

// ─── integration: runReviewerGate ─────────────────────────────────────────────

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

interface Built {
  readonly cwd: string;
  readonly baseSha: string;
  readonly codexHome: string;
}

async function buildProject(opts: {
  readonly command: string;
  readonly outOfScope?: boolean;
  readonly authValid?: boolean;
  readonly grantReviewer?: boolean;
}): Promise<Built> {
  const cwd = await realpath(
    await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Sprint One',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-001',
          allowed_paths: ['src/**'],
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'pending',
          reviewer: 'codex',
          created_at: '2026-06-01T00:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'src/foo.ts', content: 'export const v = 0;\n' },
    ]),
  );

  git(cwd, ['init', '-q']);
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  const baseSha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD']).toString().trim();

  // sprint work
  await writeFile(join(cwd, 'src/foo.ts'), 'export const v = 1;\n', 'utf8');
  if (opts.outOfScope) await writeFile(join(cwd, 'lib_evil.ts'), 'export const e = 1;\n', 'utf8');
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work']);

  if (opts.grantReviewer !== false) {
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
  }

  const codexHome = await mkdtemp(join(tmpdir(), 'rk-codexhome-'));
  if (opts.authValid !== false) {
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }),
      'utf8',
    );
  }
  return { cwd, baseSha, codexHome };
}

function gateInput(b: Built, overrides: Partial<ReviewerGateInput> = {}): ReviewerGateInput {
  return {
    cwd: b.cwd,
    reviewerName: 'codex',
    config: ReviewerGateConfigSchema.parse({ authMode: 'chatgpt' }),
    sprint: {
      id: 'S-001',
      file: 'sprints/S-001.md',
      base_sha: b.baseSha,
      allowed_paths: ['src/**'],
      title: 'Sprint One',
      body: 'do the work',
    },
    review: { id: 'R-001', file: 'reviews/R-001.md' },
    exemptFiles: [
      'sprints/S-001.md',
      'reviews/R-001.md',
      'queues/main.md',
      '.repokernel/registry.json',
    ],
    ...overrides,
  };
}

async function readReview(cwd: string): Promise<Record<string, unknown>> {
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

describe('runReviewerGate', () => {
  it('records an accepted verdict (exit 0) and stamps review_attempt', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh') });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(gateInput(b));
    expect(out.kind).toBe('recorded');
    if (out.kind === 'recorded') {
      expect(out.verdict).toBe('accepted');
      expect(out.exitCode).toBe(0);
      expect(out.attempt).toBe(1);
    }
    const fmData = await readReview(b.cwd);
    expect(fmData.verdict).toBe('accepted');
    expect(fmData.review_attempt).toBe(1);
  });

  it('records changes_requested (exit non-zero) with findings', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'changes.sh') });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(gateInput(b));
    expect(out.kind === 'recorded' && out.verdict).toBe('changes_requested');
    expect(out.kind === 'recorded' && out.exitCode).not.toBe(0);
    const fmData = await readReview(b.cwd);
    expect(fmData.verdict).toBe('changes_requested');
    expect(Array.isArray(fmData.findings) && (fmData.findings as unknown[]).length).toBe(1);
  });

  it('records rejected', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'reject.sh') });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(gateInput(b));
    expect(out.kind === 'recorded' && out.verdict).toBe('rejected');
  });

  it('increments review_attempt on a re-review', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh') });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(
      gateInput(b, { review: { id: 'R-001', file: 'reviews/R-001.md', review_attempt: 1 } }),
    );
    expect(out.kind === 'recorded' && out.attempt).toBe(2);
    expect((await readReview(b.cwd)).review_attempt).toBe(2);
  });

  it('hard-blocks an out-of-scope commit before spawning, leaving the verdict pending', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh'), outOfScope: true });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(gateInput(b));
    expect(out.kind).toBe('blocked');
    if (out.kind === 'blocked') {
      expect(out.exitCode).toBe(EXIT_BLOCKED);
      expect(out.reason).toContain('lib_evil.ts');
    }
    expect((await readReview(b.cwd)).verdict).toBe('pending');
  });

  it('fails soft to changes_requested on invalid sentinel output', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'badjson.sh') });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(gateInput(b));
    expect(out.kind === 'recorded' && out.verdict).toBe('changes_requested');
    expect(out.kind === 'recorded' && out.failSoft).toBeTruthy();
    expect((await readReview(b.cwd)).verdict).toBe('changes_requested');
  });

  it('blocks (fail closed) when chatgpt auth.json is missing — no spawn', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh'), authValid: false });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(gateInput(b));
    expect(out.kind).toBe('blocked');
    expect(out.kind === 'blocked' && out.reason).toMatch(/auth/i);
    expect((await readReview(b.cwd)).verdict).toBe('pending');
  });

  it('blocks when the reviewer has no trust grant', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh'), grantReviewer: false });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(gateInput(b));
    expect(out.kind).toBe('blocked');
    expect(out.kind === 'blocked' && out.reason).toMatch(/trust|grant/i);
  });

  it('blocks when the sprint has no base_sha', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh') });
    process.env.CODEX_HOME = b.codexHome;
    const out = await runReviewerGate(
      gateInput(b, {
        sprint: {
          id: 'S-001',
          file: 'sprints/S-001.md',
          allowed_paths: ['src/**'],
          title: 't',
          body: 'b',
        },
      }),
    );
    expect(out.kind).toBe('blocked');
    expect(out.kind === 'blocked' && out.reason).toMatch(/base_sha/);
  });

  it('reads authoritative allowed_paths from the sprint file at base_sha, not HEAD', async () => {
    // Sprint file at base allows only src/**; a later HEAD commit widens it to **,
    // and commits an out-of-scope file. The gate must use the base_sha scope and block.
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh') });
    process.env.CODEX_HOME = b.codexHome;
    // base commit already has sprints/S-001.md with allowed_paths src/** (from buildProject).
    // Tamper at HEAD: widen allowed_paths and commit an out-of-scope file.
    await writeFile(
      join(b.cwd, 'sprints/S-001.md'),
      fm({
        id: 'S-001',
        title: 'Sprint One',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        review_id: 'R-001',
        allowed_paths: ['**'],
      }),
      'utf8',
    );
    await writeFile(join(b.cwd, 'lib_evil.ts'), 'export const e = 1;\n', 'utf8');
    git(b.cwd, ['add', '.']);
    git(b.cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'tamper']);

    const out = await runReviewerGate(
      gateInput(b, {
        sprint: {
          id: 'S-001',
          file: 'sprints/S-001.md',
          base_sha: b.baseSha,
          allowed_paths: ['**'], // HEAD value — must be ignored in favor of base
          title: 'Sprint One',
          body: 'do the work',
        },
      }),
    );
    expect(out.kind).toBe('blocked');
    expect(out.kind === 'blocked' && out.reason).toContain('lib_evil.ts');
  });

  it('uses the original base_sha from git history and flags a moved base_sha', async () => {
    const b = await buildProject({ command: join(FIXTURES, 'accept.sh') });
    process.env.CODEX_HOME = b.codexHome;
    const headSha = execFileSync('git', ['-C', b.cwd, 'rev-parse', 'HEAD']).toString().trim();
    const writeSprint = (baseSha: string) =>
      writeFile(
        join(b.cwd, 'sprints/S-001.md'),
        fm({
          id: 'S-001',
          title: 'Sprint One',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-001',
          allowed_paths: ['src/**'],
          base_sha: baseSha,
        }),
        'utf8',
      );
    // Stamp the genuine base_sha (commit), then move it forward to HEAD (commit) as tampering would.
    await writeSprint(b.baseSha);
    git(b.cwd, ['add', '.']);
    git(b.cwd, [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '-m',
      'stamp base_sha',
    ]);
    await writeSprint(headSha);
    git(b.cwd, ['add', '.']);
    git(b.cwd, [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '-m',
      'move base_sha',
    ]);

    const out = await runReviewerGate(
      gateInput(b, {
        sprint: {
          id: 'S-001',
          file: 'sprints/S-001.md',
          base_sha: headSha, // tampered (moved forward); gate must use the original from history
          allowed_paths: ['src/**'],
          title: 'Sprint One',
          body: 'do the work',
        },
      }),
    );
    expect(out.kind).toBe('recorded');
    if (out.kind === 'recorded') {
      expect(out.verdict).toBe('accepted');
      expect(out.findings.some((f) => /base_sha changed/.test(f.message))).toBe(true);
    }
  });
});
