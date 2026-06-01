import { describe, expect, it } from 'vitest';
import { classifySprintDiff, uncommittedInScopePaths } from '../src/lifecycle/diffClassifier.js';
import { validateChangedFilesForSprint } from '../src/lifecycle/pathPolicy.js';

describe('diff-paths accepts allowed_paths ∪ generated_paths', () => {
  const sprint = {
    id: 'S-001',
    allowed_paths: ['apps/web/**'],
    denied_paths: [],
    generated_paths: ['.repokernel/registry.json'],
  } as never;

  it('allows changes that match generated_paths even when not in allowed_paths', () => {
    const result = validateChangedFilesForSprint(sprint, [
      'apps/web/page.tsx',
      '.repokernel/registry.json',
    ]);
    expect(result).toBeNull();
  });

  it('still blocks files outside both allowed_paths and generated_paths', () => {
    const result = validateChangedFilesForSprint(sprint, ['apps/server/foo.ts']);
    expect(result?.code).toBe('OUT_OF_SCOPE_PATH');
  });

  it('emits a suggestion message that names both surface sets', () => {
    const result = validateChangedFilesForSprint(sprint, ['apps/server/foo.ts']);
    expect(result?.suggestion).toContain('generated_paths');
  });

  it('exempts RK-owned state files via rkOwnedGlobs', () => {
    const result = validateChangedFilesForSprint(
      sprint,
      [
        'apps/web/page.tsx',
        '.repokernel/plan/reviews/R-999.md',
        '.repokernel/plan/sprints/S-002.md',
      ],
      [],
      undefined,
      ['.repokernel/plan/reviews', '.repokernel/plan/sprints'],
    );
    expect(result).toBeNull();
  });

  it('still blocks product paths outside scope even with rkOwnedGlobs set', () => {
    const result = validateChangedFilesForSprint(sprint, ['apps/server/foo.ts'], [], undefined, [
      '.repokernel/plan/reviews',
    ]);
    expect(result?.code).toBe('OUT_OF_SCOPE_PATH');
  });
});

describe('classifySprintDiff', () => {
  const config = {
    paths: {
      registry: '.repokernel/registry.json',
      queues: 'queues',
      lanes: 'lanes',
      sprints: 'sprints',
      reviews: 'reviews',
      epics: 'epics',
      generated: '.repokernel',
    },
  } as never;

  const sprint = {
    id: 'S-001',
    allowed_paths: ['src'],
    denied_paths: [],
    generated_paths: ['generated/report.json'],
  } as never;

  it('blocks committed out-of-scope files but reports external dirty files separately', () => {
    const result = classifySprintDiff({
      config,
      sprint,
      changed: {
        files: ['src/app.ts', 'server/api.ts', 'scratch.txt'],
        committed: ['src/app.ts', 'server/api.ts'],
        staged: [],
        unstaged: ['scratch.txt'],
        untracked: [],
      },
    });

    expect(result.blockers).toEqual([
      expect.objectContaining({
        category: 'out_of_scope_committed',
        scope: 'sprint',
        paths: ['server/api.ts'],
      }),
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        category: 'external_dirty',
        scope: 'workspace',
        paths: ['scratch.txt'],
      }),
    ]);
  });

  it('classifies generated and lifecycle-owned files without blocking', () => {
    const result = classifySprintDiff({
      config,
      sprint,
      changed: {
        files: ['generated/report.json', 'reviews/R-001.md', '.repokernel/registry.json'],
        committed: ['generated/report.json', 'reviews/R-001.md', '.repokernel/registry.json'],
        staged: [],
        unstaged: [],
        untracked: [],
      },
      exemptPaths: ['reviews/R-001.md', '.repokernel/registry.json'],
    });

    expect(result.blockers).toEqual([]);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'generated/report.json', category: 'generated' }),
        expect.objectContaining({ path: 'reviews/R-001.md', category: 'rk_owned' }),
      ]),
    );
  });
});

describe('uncommittedInScopePaths', () => {
  const config = {
    paths: {
      registry: '.repokernel/registry.json',
      queues: 'queues',
      lanes: 'lanes',
      sprints: 'sprints',
      reviews: 'reviews',
      epics: 'epics',
      generated: '.repokernel',
    },
  } as never;

  const sprint = {
    id: 'S-001',
    allowed_paths: ['src'],
    denied_paths: [],
    generated_paths: [],
  } as never;

  it('flags in-scope files that have uncommitted edits', () => {
    const classification = classifySprintDiff({
      config,
      sprint,
      changed: {
        files: ['src/app.ts'],
        committed: [],
        staged: [],
        unstaged: ['src/app.ts'],
        untracked: [],
      },
    });
    expect(uncommittedInScopePaths(classification)).toEqual(['src/app.ts']);
  });

  it('ignores in-scope files that are only committed', () => {
    const classification = classifySprintDiff({
      config,
      sprint,
      changed: {
        files: ['src/app.ts'],
        committed: ['src/app.ts'],
        staged: [],
        unstaged: [],
        untracked: [],
      },
    });
    expect(uncommittedInScopePaths(classification)).toEqual([]);
  });

  it('ignores out-of-scope dirty files so they no longer block ship', () => {
    const classification = classifySprintDiff({
      config,
      sprint,
      changed: {
        files: ['scratch.txt', 'other/foo.ts'],
        committed: [],
        staged: [],
        unstaged: ['scratch.txt'],
        untracked: ['other/foo.ts'],
      },
    });
    expect(uncommittedInScopePaths(classification)).toEqual([]);
  });

  it('returns only the in-scope uncommitted paths from a mixed tree', () => {
    const classification = classifySprintDiff({
      config,
      sprint,
      changed: {
        files: ['src/a.ts', 'src/b.ts', 'scratch.txt'],
        committed: ['src/a.ts'],
        staged: ['src/b.ts'],
        unstaged: ['scratch.txt'],
        untracked: [],
      },
    });
    expect(uncommittedInScopePaths(classification)).toEqual(['src/b.ts']);
  });
});
