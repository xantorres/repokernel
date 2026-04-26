import { type Config, ConfigSchema } from '@repokernel/core';
import { describe, expect, it } from 'vitest';
import {
  sprintWorktreeBranch,
  sprintWorktreePath,
  worktreeBranch,
} from '../src/lifecycle/worktree.js';

const CONFIG: Config = ConfigSchema.parse({
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
});

describe('worktree naming', () => {
  it('uses distinct branch namespaces for epic and sprint worktrees', () => {
    expect(worktreeBranch('E-001', CONFIG)).toBe('rk/epic/E-001');
    expect(sprintWorktreeBranch('E-001', 'S-001', CONFIG)).toBe('rk/sprint/E-001/S-001');
  });

  it('keeps sprint worktrees outside the epic worktree directory', () => {
    const path = sprintWorktreePath('E-001', 'S-001', CONFIG, '/tmp/my-repo');
    expect(path).toBe('/tmp/.repokernel-worktrees/my-repo/E-001-sprints/S-001');
  });
});
