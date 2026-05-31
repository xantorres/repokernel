import { describe, expect, it } from 'vitest';
import {
  effectivePathPolicyForSprint,
  validateChangedFilesForSprint,
} from '../src/lifecycle/pathPolicy.js';

const paths = {
  registry: '.repokernel/registry.json',
  queues: 'queues',
  lanes: 'lanes',
  sprints: 'sprints',
  reviews: 'reviews',
  epics: 'epics',
  generated: '.repokernel',
};

const sprint = {
  id: 'S-001',
  allowed_paths: ['packages/shared/**'],
  denied_paths: [],
  generated_paths: [],
} as never;

function configWith(pathPolicy: { alwaysAllowed: string[]; alwaysGenerated: string[] }) {
  return { paths, pathPolicy } as never;
}

describe('project-level pathPolicy merges into effective sprint policy', () => {
  it('alwaysGenerated exempts a cross-cutting file (root lockfile) for a scoped sprint', () => {
    const policy = effectivePathPolicyForSprint({
      config: configWith({ alwaysGenerated: ['pnpm-lock.yaml'], alwaysAllowed: [] }),
      sprint,
    });
    expect(policy.generated).toContain('pnpm-lock.yaml');
    const result = validateChangedFilesForSprint(
      sprint,
      ['packages/shared/index.ts', 'pnpm-lock.yaml'],
      [],
      policy,
    );
    expect(result).toBeNull();
  });

  it('alwaysAllowed widens scope for a restricted sprint', () => {
    const policy = effectivePathPolicyForSprint({
      config: configWith({ alwaysGenerated: [], alwaysAllowed: ['.gitignore'] }),
      sprint,
    });
    expect(policy.allowed).toContain('.gitignore');
    const result = validateChangedFilesForSprint(
      sprint,
      ['packages/shared/index.ts', '.gitignore'],
      [],
      policy,
    );
    expect(result).toBeNull();
  });

  it('without pathPolicy the same cross-cutting file is out of scope (regression guard)', () => {
    const policy = effectivePathPolicyForSprint({
      config: configWith({ alwaysGenerated: [], alwaysAllowed: [] }),
      sprint,
    });
    const result = validateChangedFilesForSprint(sprint, ['pnpm-lock.yaml'], [], policy);
    expect(result?.code).toBe('OUT_OF_SCOPE_PATH');
  });

  it('alwaysGenerated cannot smuggle a RepoKernel control path into scope', () => {
    const policy = effectivePathPolicyForSprint({
      config: configWith({ alwaysGenerated: ['.repokernel/registry.json'], alwaysAllowed: [] }),
      sprint,
    });
    expect(policy.generated).not.toContain('.repokernel/registry.json');
  });
});
