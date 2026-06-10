import { type Config, ConfigSchema, RepoKernelError } from '@repokernel/core';
import { describe, expect, it } from 'vitest';
import {
  sprintWorktreeBranch,
  sprintWorktreePath,
  worktreeBranch,
  worktreePath,
} from '../src/lifecycle/worktree.js';
import { sid } from './helpers/brand.js';

const BASE_CONFIG_INPUT = {
  schemaVersion: 1,
  projectId: 'demo',
  projectName: 'Demo',
  paths: {
    epics: 'epics',
    sprints: 'sprints',
    reviews: 'reviews',
    queues: 'queues',
    lanes: 'lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  },
} as const;

const CONFIG: Config = ConfigSchema.parse(BASE_CONFIG_INPUT);

function configWithWorktrees(worktrees: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    ...BASE_CONFIG_INPUT,
    worktrees,
  });
}

function configWithPattern(pattern: string): Config {
  return configWithWorktrees({ branchPattern: pattern });
}

describe('worktree naming', () => {
  it('uses distinct branch namespaces for epic and sprint worktrees', () => {
    expect(worktreeBranch('E-001', CONFIG)).toBe('rk/epic/E-001');
    expect(sprintWorktreeBranch('E-001', sid('S-001'), CONFIG)).toBe('rk/sprint/E-001/S-001');
  });

  it('keeps sprint worktrees outside the epic worktree directory', () => {
    const path = sprintWorktreePath('E-001', sid('S-001'), CONFIG, '/tmp/my-repo');
    expect(path).toMatch(
      /^\/tmp\/\.repokernel-worktrees\/my-repo-[0-9a-f]{8}\/E-001-sprints\/S-001$/,
    );
  });

  it('namespaces same-basename repos to distinct worktree roots', () => {
    const sharedRoot = configWithWorktrees({ root: '/shared/wt' });
    const alice = worktreePath('E-001', sharedRoot, '/home/alice/myapp');
    const bob = worktreePath('E-001', sharedRoot, '/home/bob/myapp');
    expect(alice).not.toBe(bob);
    expect(alice).toMatch(/^\/shared\/wt\/myapp-[0-9a-f]{8}\/E-001$/);
    expect(bob).toMatch(/^\/shared\/wt\/myapp-[0-9a-f]{8}\/E-001$/);
  });
});

describe('worktree naming — branchPattern', () => {
  it('renders {epicId} for epic-level branches', () => {
    const config = configWithPattern('feature/{epicId}');
    expect(worktreeBranch('E-001', config)).toBe('feature/E-001');
  });

  it('renders {branchPrefix} verbatim from worktrees.branchPrefix', () => {
    const config = configWithPattern('{branchPrefix}claude/{epicId}');
    expect(worktreeBranch('E-042', config)).toBe('rk/claude/E-042');
  });

  it('uses a {sprintId} branchPattern for sprints while keeping epic default safe', () => {
    const config = configWithPattern('wip/{epicId}/{sprintId}');
    expect(worktreeBranch('E-001', config)).toBe('rk/epic/E-001');
    expect(sprintWorktreeBranch('E-001', sid('S-003'), config)).toBe('wip/E-001/S-003');
  });

  it('supports explicit epic and sprint branch patterns', () => {
    const config = configWithWorktrees({
      epicBranchPattern: 'feature/epic/{epicId}',
      sprintBranchPattern: 'feature/sprint/{epicId}/{sprintId}',
    });
    expect(worktreeBranch('E-001', config)).toBe('feature/epic/E-001');
    expect(sprintWorktreeBranch('E-001', sid('S-003'), config)).toBe('feature/sprint/E-001/S-003');
  });

  it('rejects explicit epic/sprint patterns that collide in git refs', () => {
    expect(() =>
      configWithWorktrees({
        epicBranchPattern: 'feature/{epicId}',
        sprintBranchPattern: 'feature/{epicId}/{sprintId}',
      }),
    ).toThrow();
  });

  it('treats branchPattern without {sprintId} as epic-only shorthand', () => {
    const config = configWithPattern('feature/{epicId}');
    expect(worktreeBranch('E-001', config)).toBe('feature/E-001');
    expect(sprintWorktreeBranch('E-001', sid('S-001'), config)).toBe('rk/sprint/E-001/S-001');
  });

  it('still uses default scheme when branchPattern is unset', () => {
    expect(worktreeBranch('E-007', CONFIG)).toBe('rk/epic/E-007');
    expect(sprintWorktreeBranch('E-007', sid('S-002'), CONFIG)).toBe('rk/sprint/E-007/S-002');
  });

  it('rejects {ticket} token at render time (reserved for v1.14)', () => {
    const config = configWithPattern('feature/{ticket}-{epicId}');
    expect(() => worktreeBranch('E-001', config)).toThrow(RepoKernelError);
    expect(() => worktreeBranch('E-001', config)).toThrow(/v1\.14/);
  });

  it('rejects {slug} token at render time (reserved for v1.14)', () => {
    const config = configWithPattern('feature/{slug}-{epicId}');
    expect(() => worktreeBranch('E-001', config)).toThrow(RepoKernelError);
    expect(() => worktreeBranch('E-001', config)).toThrow(/v1\.14/);
  });

  it('rejects unknown tokens at render time', () => {
    const config = configWithPattern('feature/{nope}/{epicId}');
    expect(() => worktreeBranch('E-001', config)).toThrow(RepoKernelError);
    expect(() => worktreeBranch('E-001', config)).toThrow(/unknown token/);
  });

  it('rejects malformed patterns at config load — whitespace', () => {
    expect(() => configWithPattern('feature/{epicId} dirty')).toThrow();
  });

  it('rejects malformed patterns at config load — `..` traversal', () => {
    expect(() => configWithPattern('feature/../{epicId}')).toThrow();
  });

  it('rejects malformed patterns at config load — leading slash', () => {
    expect(() => configWithPattern('/feature/{epicId}')).toThrow();
  });

  it('rejects malformed patterns at config load — trailing slash', () => {
    expect(() => configWithPattern('feature/{epicId}/')).toThrow();
  });

  it('rejects malformed patterns at config load — trailing dot', () => {
    expect(() => configWithPattern('feature/{epicId}.')).toThrow();
  });

  it('rejects malformed patterns at config load — trailing .lock', () => {
    expect(() => configWithPattern('feature/{epicId}.lock')).toThrow();
  });

  it('rejects malformed patterns at config load — backslash', () => {
    expect(() => configWithPattern('feature\\{epicId}')).toThrow();
  });

  it('rejects malformed patterns at config load — `@{` reflog syntax', () => {
    expect(() => configWithPattern('feature/{epicId}@{0}')).toThrow();
  });

  it('rejects malformed patterns at config load — `~`', () => {
    expect(() => configWithPattern('feature/~{epicId}')).toThrow();
  });

  it('rejects malformed patterns at config load — `:` colon', () => {
    expect(() => configWithPattern('feature:{epicId}')).toThrow();
  });

  it('rejects malformed patterns at config load — `*` glob', () => {
    expect(() => configWithPattern('feature/*{epicId}')).toThrow();
  });

  it('rejects malformed patterns at config load — `?`', () => {
    expect(() => configWithPattern('feature/?{epicId}')).toThrow();
  });

  it('rejects malformed patterns at config load — unmatched brace', () => {
    expect(() => configWithPattern('feature/{epicId')).toThrow();
  });

  it('rejects malformed patterns at config load — `//` double slash', () => {
    expect(() => configWithPattern('feature//{epicId}')).toThrow();
  });

  it('rejects rendered refs with unsafe token adjacency', () => {
    expect(() => configWithPattern('{branchPrefix}/{epicId}')).toThrow();
  });

  it('rejects rendered refs with leading-dot components', () => {
    expect(() => configWithPattern('feature/.hidden/{epicId}')).toThrow();
  });

  it('rejects rendered refs with .lock components', () => {
    expect(() => configWithPattern('feature/cache.lock/{epicId}')).toThrow();
  });

  it('rejects unsafe branchPrefix when used by a pattern', () => {
    expect(() =>
      configWithWorktrees({ branchPrefix: 'rk//', branchPattern: '{branchPrefix}{epicId}' }),
    ).toThrow();
  });

  it('rejects unsafe branchPrefix even when custom patterns omit it', () => {
    expect(() =>
      configWithWorktrees({
        branchPrefix: 'rk//',
        epicBranchPattern: 'feature/epic/{epicId}',
        sprintBranchPattern: 'feature/sprint/{epicId}/{sprintId}',
      }),
    ).toThrow();
  });

  it('rejects empty pattern', () => {
    expect(() => configWithPattern('')).toThrow();
  });

  it('accepts hyphens, underscores, dots, and digits in static segments', () => {
    const config = configWithPattern('feat-2026.q2/{epicId}_a');
    expect(worktreeBranch('E-001', config)).toBe('feat-2026.q2/E-001_a');
  });
});
