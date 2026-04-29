import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { runContextCommand } from '../src/commands/context.js';
import {
  EXIT_BUDGET_EXCEEDED,
  EXIT_BUDGET_TOO_SMALL,
  EXIT_OK,
  EXIT_RUNTIME,
} from '../src/exitCodes.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);

afterAll(cleanupAllFixtures);

async function gitInit(cwd: string): Promise<void> {
  await execFileAsync('git', ['-C', cwd, 'init', '-q']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@test.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'test']);
  await execFileAsync('git', ['-C', cwd, 'add', '.']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-q', '-m', 'init']);
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
    expect(result.stdout).toContain('rk start S-001');
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
          status: 'planned',
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
          status: 'planned',
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
          status: 'planned',
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
    expect(parsed.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect((parsed.properties as Record<string, unknown>).profile).toEqual({
      const: 'implement',
    });
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
      expect((parsed.properties as Record<string, unknown>).profile).toEqual({ const: profile });
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
