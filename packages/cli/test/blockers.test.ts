import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runBlockersCommand } from '../src/commands/blockers.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

vi.mock('../src/lifecycle/git.js', () => ({
  changedFilesForSprint: vi.fn().mockResolvedValue({
    files: [],
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
  }),
}));

import { changedFilesForSprint } from '../src/lifecycle/git.js';

afterAll(cleanupAllFixtures);

afterEach(() => {
  vi.mocked(changedFilesForSprint).mockResolvedValue({
    files: [],
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
  });
});

async function project(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Blockers', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Scoped sprint',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        allowed_paths: ['src'],
        base_sha: 'abc1234',
        review_id: 'R-001',
      }),
    },
    {
      path: 'reviews/R-001.md',
      content: fm({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'pending',
        reviewer: 'codex',
        findings: [],
        created_at: '2026-05-18T08:00:00Z',
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

describe('runBlockersCommand', () => {
  it('reports durable blockers and external dirty warnings as structured JSON', async () => {
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['src/app.ts', 'server/api.ts', 'scratch.txt'],
      committed: ['src/app.ts', 'server/api.ts'],
      staged: [],
      unstaged: ['scratch.txt'],
      untracked: [],
    });
    const cwd = await project();

    const result = await runBlockersCommand('S-001', { cwd, json: true });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      blockers: unknown[];
      warnings: unknown[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.blockers).toEqual([
      expect.objectContaining({
        category: 'out_of_scope_committed',
        paths: ['server/api.ts'],
        owner: 'sprint',
      }),
    ]);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        category: 'external_dirty',
        paths: ['scratch.txt'],
        owner: 'workspace',
      }),
    ]);
  });
});
