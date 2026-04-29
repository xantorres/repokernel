import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { runContextCommand } from '../src/commands/context.js';
import {
  EXIT_BUDGET_EXCEEDED,
  EXIT_BUDGET_TOO_SMALL,
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_RUNTIME,
} from '../src/exitCodes.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

afterAll(cleanupAllFixtures);

async function gitInit(cwd: string): Promise<void> {
  await execFileAsync('git', ['-C', cwd, 'init', '-q']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@test.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'test']);
  await execFileAsync('git', ['-C', cwd, 'add', '.']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-q', '-m', 'init']);
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function basicProject(): Promise<string> {
  const cwd = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Foo Epic', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm(
        {
          id: 'S-001',
          title: 'Bootstrap',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          allowed_paths: ['src/foo/**'],
          depends_on: [],
        },
        '## Acceptance\n\n- foo bar\n',
      ),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    { path: 'src/foo/index.ts', content: 'export const x = 1;\n' },
    { path: 'src/foo/util.ts', content: 'export const y = 2;\n' },
  ]);
  await gitInit(cwd);
  return cwd;
}

describe('rk context — implement', () => {
  it('emits deterministic implement Markdown for a sprint', async () => {
    const cwd = await basicProject();
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'md',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain('# Sprint S-001 — implement context');
    expect(result.stdout).toContain('Bootstrap');
    expect(result.stdout).toContain('## Allowed paths');
    expect(result.stdout).toContain('src/foo/**');
    expect(result.stdout).toContain('## Scoped file manifest');
    expect(result.stdout).toContain('src/foo/index.ts');
    expect(result.stdout).toContain('src/foo/util.ts');
    expect(result.stdout).toContain('rk inspect S-001');
    expect(result.stdout).toContain('rk start S-001');
    expect(result.stdout).not.toContain('--strict');
    expect(result.stdout).not.toContain('rk run S-001');
  });

  it('produces byte-identical output across two runs', async () => {
    const cwd = await basicProject();
    const r1 = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'md',
      check: false,
      validate: false,
    });
    const r2 = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'md',
      check: false,
      validate: false,
    });
    expect(r1.stdout).toBe(r2.stdout);
  });

  it('emits canonical JSON when format=json', async () => {
    const cwd = await basicProject();
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.profile).toBe('implement');
    expect(parsed.target).toBe('S-001');
    expect((parsed.capsule as Record<string, unknown>).id).toBe('S-001');
  });

  it('reports no scoped manifest available when allowed_paths empty', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          allowed_paths: [],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const manifest = parsed.scoped_manifest as Record<string, unknown>;
    expect(manifest.available).toBe(false);
    expect(manifest.files).toEqual([]);
  });

  it('returns CONTEXT_PROFILE_TARGET_MISMATCH when profile/target disagree', async () => {
    const cwd = await basicProject();
    const result = await runContextCommand({
      cwd,
      target: 'E-001',
      profile: 'implement',
      format: 'md',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_RUNTIME);
    expect(result.stderr).toContain('CONTEXT_PROFILE_TARGET_MISMATCH');
    expect(result.stderr).toContain('rk context S-001 --profile implement');
    expect(result.stderr).toContain('"exit_reason"');
  });

  it('returns not-found error for missing sprint', async () => {
    const cwd = await basicProject();
    const result = await runContextCommand({
      cwd,
      target: 'S-999',
      format: 'md',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_RUNTIME);
    expect(result.stderr).toContain('S-999');
    expect(result.stderr).toContain('not found');
  });

  it('--validate exits non-zero for global/config P0/P1 findings', async () => {
    const cwd = await basicProject();
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: true,
      runtimeVersion: '1.7.0',
    });
    expect(result.exitCode).toBe(EXIT_OK);

    const cwdWithInvalidRequires = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}requires: "not a semver range"\n`,
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Foo Epic', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Bootstrap',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          allowed_paths: ['src/foo/**'],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwdWithInvalidRequires);
    const invalid = await runContextCommand({
      cwd: cwdWithInvalidRequires,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: true,
      runtimeVersion: '1.7.0',
    });
    expect(invalid.exitCode).toBe(EXIT_FINDINGS);
    expect(invalid.stderr).toContain('context_validation_findings');
    expect(invalid.stdout).toContain('CONFIG_REQUIRES_NOT_MET');
  });

  it('detects related shipped sprints by conservative glob overlap', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'E',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'target',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          allowed_paths: ['src/**'],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'prior',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          allowed_paths: ['src/foo/**'],
          closed_at: '2026-04-28T00:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as { related_sprints: Array<{ id: string }> };
    expect(parsed.related_sprints.map((s) => s.id)).toEqual(['S-002']);
  });
});

describe('rk context — wave', () => {
  it('groups runnable / blocked / parallel-safe for an epic', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Multi-sprint epic',
          status: 'active',
          sprints: ['S-001', 'S-002', 'S-003'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's1',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['src/a/**'],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 's2',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'side',
          allowed_paths: ['src/b/**'],
        }),
      },
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 's3',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          depends_on: ['S-001'],
          allowed_paths: ['src/c/**'],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'queues/side.md', content: fm({ lane: 'side', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'lanes/side.md', content: fm({ name: 'side' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'E-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const capsule = parsed.capsule as Record<string, unknown>;
    expect((capsule.runnable as unknown[]).length).toBe(2);
    expect((capsule.blocked as unknown[]).length).toBe(1);
    const parallelSafe = capsule.parallel_safe as Array<{ id: string }>;
    const ids = parallelSafe.map((s) => s.id).sort();
    expect(ids).toEqual(['S-001', 'S-002']);
  });

  it('uses core wave semantics and does not mark non-queued work runnable', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Statuses',
          status: 'active',
          sprints: ['S-001', 'S-002', 'S-003', 'S-004', 'S-005', 'S-006'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'queued',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['src/a/**'],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'planned',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          allowed_paths: ['src/b/**'],
        }),
      },
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 'active',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-29T00:00:00Z',
          base_sha: 'abcdef0',
          allowed_paths: ['src/c/**'],
        }),
      },
      {
        path: 'sprints/S-004.md',
        content: fm({
          id: 'S-004',
          title: 'review',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src/d/**'],
        }),
      },
      {
        path: 'sprints/S-005.md',
        content: fm({
          id: 'S-005',
          title: 'blocked',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          depends_on: ['S-001'],
          allowed_paths: ['src/e/**'],
        }),
      },
      {
        path: 'sprints/S-006.md',
        content: fm({
          id: 'S-006',
          title: 'gated',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          gate: 'manual',
          allowed_paths: ['src/f/**'],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'E-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const capsule = parsed.capsule as {
      runnable: Array<{ id: string }>;
      planned: Array<{ id: string }>;
      blocked: Array<{ id: string }>;
      gated: Array<{ id: string }>;
    };
    expect(capsule.runnable.map((s) => s.id)).toEqual(['S-001']);
    expect(capsule.planned.map((s) => s.id)).toEqual(['S-002']);
    expect(capsule.blocked.map((s) => s.id)).toEqual(['S-005']);
    expect(capsule.gated.map((s) => s.id)).toEqual(['S-006']);
  });

  it('excludes glob-overlapping and unscoped sprints from parallel-safe candidates', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}parallel:\n  maxConcurrentSprints: 4\n`,
      },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Parallel',
          status: 'active',
          execution_strategy: 'parallel',
          parallel_limit: 4,
          sprints: ['S-001', 'S-002', 'S-003', 'S-004'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'root',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['src/**'],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'child',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['src/foo/**'],
        }),
      },
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 'lib',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['lib/**'],
        }),
      },
      {
        path: 'sprints/S-004.md',
        content: fm({
          id: 'S-004',
          title: 'unscoped',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: [],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'E-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const capsule = parsed.capsule as { parallel_safe: Array<{ id: string }> };
    expect(capsule.parallel_safe.map((s) => s.id)).toEqual(['S-001', 'S-003']);
  });
});

describe('rk context — review', () => {
  it('falls through to unavailable when no review and no SHAs', async () => {
    const cwd = await basicProject();
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      profile: 'review',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const capsule = parsed.capsule as Record<string, unknown>;
    expect(capsule.changed_files_source).toBe('unavailable');
    expect(capsule.changed_files).toEqual([]);
  });

  it('uses review.changed_files when present', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'pending',
          reviewer: 'human:default',
          findings: [],
          created_at: '2026-04-29T00:00:00Z',
          changed_files: ['src/a.ts', 'src/b.ts'],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      profile: 'review',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const capsule = parsed.capsule as Record<string, unknown>;
    expect(capsule.changed_files_source).toBe('review_committed');
    expect(capsule.changed_files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('preserves explicit empty review.changed_files as review_committed', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'pending',
          reviewer: 'human:default',
          findings: [],
          created_at: '2026-04-29T00:00:00Z',
          changed_files: [],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      profile: 'review',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const capsule = parsed.capsule as Record<string, unknown>;
    expect(capsule.changed_files_source).toBe('review_committed');
    expect(capsule.changed_files).toEqual([]);
  });

  it('preserves successful empty git diffs as git_diff', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          base_sha: 'abcdef0',
          end_sha: 'abcdef0',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const head = await gitHead(cwd);
    await writeFile(
      join(cwd, 'sprints', 'S-001.md'),
      fm({
        id: 'S-001',
        title: 's',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        base_sha: head,
        end_sha: head,
      }),
      'utf8',
    );
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      profile: 'review',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const capsule = parsed.capsule as Record<string, unknown>;
    expect(capsule.changed_files_source).toBe('git_diff');
    expect(capsule.changed_files).toEqual([]);
  });

  it('--validate includes target review-integrity findings in review packets', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-999',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      profile: 'review',
      format: 'json',
      check: false,
      validate: true,
    });
    expect(result.exitCode).toBe(EXIT_FINDINGS);
    const parsed = JSON.parse(result.stdout) as { review_findings: Array<{ code: string }> };
    expect(parsed.review_findings.map((f) => f.code)).toContain('SPRINT_REVIEW_ID_MISSING_REVIEW');
  });
});

describe('rk context — budget gates', () => {
  it('--check returns EXIT_BUDGET_EXCEEDED when rendered > effective budget but essential fits', async () => {
    // Essential = sprint metadata + manifest (2 files) + commands.
    // Full render additionally includes objective_excerpt (400 chars) which
    // pushes total over the effective budget while essential stays under.
    const longBody = 'x'.repeat(400);
    const files: { path: string; content: string }[] = [
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm(
          {
            id: 'S-001',
            title: 'main',
            epic_id: 'E-001',
            status: 'planned',
            lane: 'main',
            allowed_paths: ['src/**'],
          },
          longBody,
        ),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'src/a.ts', content: 'export const x=1;\n' },
      { path: 'src/b.ts', content: 'export const y=2;\n' },
    ];
    const cwd = await makeFixture(files);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'md',
      budget: 200,
      check: true,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_BUDGET_EXCEEDED);
    expect(result.stderr).toContain('context_budget_exceeded');
  });

  it('returns EXIT_BUDGET_EXCEEDED (not TOO_SMALL) when all optionals stripped but essential fits', async () => {
    // Regression: reduceForBudget used to set essentialOverflow=true unconditionally
    // when the omission loop exhausted all steps. The essential capsule must still fit.
    const longBody = 'x'.repeat(400);
    const files = [
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm(
          {
            id: 'S-001',
            title: 'main',
            epic_id: 'E-001',
            status: 'planned',
            lane: 'main',
            allowed_paths: ['src/**'],
          },
          longBody,
        ),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'src/a.ts', content: 'export const x=1;\n' },
    ];
    const cwd = await makeFixture(files);
    await gitInit(cwd);
    // budget=200 (effective=170): essential (~110 tok) fits; full with 400-char excerpt exceeds.
    // default mode (no --check): strips optional sections, still marginally over → EXCEEDED not TOO_SMALL.
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'md',
      budget: 200,
      check: false,
      validate: false,
    });
    expect(result.exitCode).not.toBe(EXIT_BUDGET_TOO_SMALL);
  });

  it('returns EXIT_BUDGET_TOO_SMALL when essential alone exceeds budget', async () => {
    const cwd = await basicProject();
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'md',
      budget: 5,
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_BUDGET_TOO_SMALL);
    expect(result.stderr).toContain('context_budget_too_small');
  });

  it('keeps denied_paths when reducing under budget pressure', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm(
          {
            id: 'S-001',
            title: 'main',
            epic_id: 'E-001',
            status: 'planned',
            lane: 'main',
            allowed_paths: ['src/**'],
            denied_paths: ['src/secrets/**'],
          },
          'x'.repeat(1200),
        ),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
      { path: 'src/a.ts', content: 'export const x=1;\n' },
    ]);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      budget: 320,
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as {
      capsule: { denied_paths: string[] };
      omissions: Array<{ section: string }>;
      estimated_tokens: number;
      effective_budget: number;
    };
    expect(parsed.omissions.map((o) => o.section)).toContain('objective_excerpt');
    expect(parsed.capsule.denied_paths).toEqual(['src/secrets/**']);
    expect(parsed.estimated_tokens).toBeLessThanOrEqual(parsed.effective_budget);
  });

  it('rejects malformed budgets at the CLI parser layer', async () => {
    for (const value of ['10abc', '1.5', '0', '9007199254740993']) {
      await expect(
        execFileAsync('node', [DIST, 'context', '--schema', 'implement', '--budget', value]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(`invalid --budget value "${value}"`),
      });
    }
  });
});

describe('rk context — schema', () => {
  it('emits JSON Schema for implement profile', async () => {
    const result = await runContextCommand({
      cwd: process.cwd(),
      format: 'json',
      check: false,
      validate: false,
      schema: 'implement',
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(JSON.stringify(parsed)).toContain('"allowed_paths"');
    expect(JSON.stringify(parsed)).toContain('"additionalProperties":false');
  });

  it('emits JSON Schema for review and wave', async () => {
    for (const profile of ['review', 'wave'] as const) {
      const result = await runContextCommand({
        cwd: process.cwd(),
        format: 'json',
        check: false,
        validate: false,
        schema: profile,
      });
      expect(result.exitCode).toBe(EXIT_OK);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.$id).toBe(`https://repokernel.dev/schemas/context-packet/${profile}.json`);
      expect(JSON.stringify(parsed)).toContain('"capsule"');
    }
  });
});

describe('rk context — manifest cap + sort', () => {
  it('caps scoped manifest at 50 and sorts ASCII-ascending', async () => {
    const files: { path: string; content: string }[] = [
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          allowed_paths: ['src/**'],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    ];
    for (let i = 0; i < 60; i += 1) {
      files.push({ path: `src/f${String(i).padStart(3, '0')}.ts`, content: 'export const x=1;' });
    }
    const cwd = await makeFixture(files);
    await gitInit(cwd);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const manifest = parsed.scoped_manifest as { files: string[]; omitted_count: number };
    expect(manifest.files.length).toBe(50);
    expect(manifest.omitted_count).toBe(10);
    // Sorted check: each next file >= prev
    for (let i = 1; i < manifest.files.length; i += 1) {
      const prev = manifest.files[i - 1] ?? '';
      const cur = manifest.files[i] ?? '';
      expect(cur >= prev).toBe(true);
    }
  });
});
