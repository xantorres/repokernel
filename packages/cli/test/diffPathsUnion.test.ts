import { describe, expect, it } from 'vitest';
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
