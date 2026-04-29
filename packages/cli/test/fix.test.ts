import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runFixCommand } from '../src/commands/fix.js';
import { commitAll, makeGitRepo, opRoot, removeRepo } from './fakeAgent/helpers.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const tracked: string[] = [];
afterAll(async () => {
  await cleanupAllFixtures();
  await Promise.all(tracked.map(removeRepo));
});

interface FixPreviewJson {
  readonly schemaVersion: number;
  readonly safeFixes: readonly { title: string; detail: string }[];
  readonly manualSuggestions: readonly { title: string; detail: string }[];
}

async function shippedSprintInQueueFixture(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001', 'S-002'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'shipped sprint still in queue',
        epic_id: 'E-001',
        status: 'shipped',
        lane: 'main',
        base_sha: 'a'.repeat(40),
        end_sha: 'b'.repeat(40),
        closed_at: '2026-04-29T12:00:00Z',
      }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({
        id: 'S-002',
        title: 'still planned',
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
      }),
    },
    {
      path: 'queues/main.md',
      content: fm({
        lane: 'main',
        slots: [
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          { id: 'Q-002', sprint_id: 'S-002', order: 1 },
        ],
      }),
    },
  ]);
}

describe('runFixCommand — SHIPPED_SPRINT_IN_QUEUE', () => {
  it('--preview surfaces a safe fix (not just a manual suggestion)', async () => {
    const cwd = await shippedSprintInQueueFixture();
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout) as FixPreviewJson;

    const removeFromQueue = preview.safeFixes.find((f) => /remove S-001 from queue/i.test(f.title));
    expect(removeFromQueue, 'safe fix for shipped-in-queue is missing').toBeDefined();

    const inManual = preview.manualSuggestions.find((f) =>
      /remove S-001 from queue/i.test(f.title),
    );
    expect(
      inManual,
      'shipped-in-queue should not be a manual suggestion when remediation is mechanical',
    ).toBeUndefined();
  });

  it('--apply removes the shipped sprint slot and renumbers remaining slots', async () => {
    const cwd = await shippedSprintInQueueFixture();
    const result = await runFixCommand({
      cwd,
      preview: false,
      apply: true,
      yes: true,
      json: true,
    });
    expect(result.exitCode).toBe(0);

    const queueRaw = await readFile(join(cwd, 'queues/main.md'), 'utf8');
    const fmEnd = queueRaw.indexOf('\n---', 4);
    const yamlBlock = queueRaw.slice(4, fmEnd);
    const data = parseYaml(yamlBlock) as {
      lane: string;
      slots: { sprint_id: string; order: number }[];
    };
    expect(data.slots.map((s) => s.sprint_id)).toEqual(['S-002']);
    expect(data.slots[0]?.order).toBe(0);
  });
});

describe('runFixCommand — leaked worktree records', () => {
  async function makeProjectWithGhostWorktree(): Promise<{ repo: string; ghostPath: string }> {
    const repo = await makeGitRepo('rk-fix-ghost-');
    tracked.push(repo);
    const dirs = ['epics', 'sprints', 'reviews', 'queues', 'lanes', '.repokernel'];
    for (const d of dirs) await mkdir(join(repo, d), { recursive: true });
    await writeFile(join(repo, 'repokernel.config.yaml'), defaultConfigYaml(), 'utf8');
    await writeFile(
      join(repo, 'epics', 'E-099.md'),
      fm({ id: 'E-099', title: 'closed', status: 'done', sprints: ['S-099'] }),
      'utf8',
    );
    await writeFile(
      join(repo, 'sprints', 'S-099.md'),
      fm({
        id: 'S-099',
        title: 'closed sprint',
        epic_id: 'E-099',
        status: 'shipped',
        lane: 'main',
        base_sha: 'a'.repeat(40),
        end_sha: 'b'.repeat(40),
        closed_at: '2026-04-29T12:00:00Z',
      }),
      'utf8',
    );
    await writeFile(join(repo, 'queues', 'main.md'), fm({ lane: 'main', slots: [] }), 'utf8');

    // Plant a worktrees.json record pointing at a path that doesn't exist —
    // this simulates the case where the worktree directory was removed
    // out-of-band but the record persists.
    await mkdir(opRoot(repo), { recursive: true });
    const ghostPath = join(repo, 'no-such-worktree-here');
    const worktreesJson = {
      worktrees: [
        {
          epicId: 'E-099',
          path: ghostPath,
          branch: 'rk/epic/E-099',
          type: 'epic',
        },
      ],
    };
    await writeFile(
      join(opRoot(repo), 'worktrees.json'),
      JSON.stringify(worktreesJson, null, 2),
      'utf8',
    );
    await commitAll(repo, 'chore: scaffold');
    return { repo, ghostPath };
  }

  it('--preview surfaces a safe fix to prune ghost worktree records (path absent)', async () => {
    const { repo } = await makeProjectWithGhostWorktree();
    const result = await runFixCommand({
      cwd: repo,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout) as FixPreviewJson;
    const ghost = preview.safeFixes.find((f) =>
      /Prune ghost worktree record for E-099/i.test(f.title),
    );
    expect(ghost, 'ghost worktree record should be a safe fix').toBeDefined();
  });

  it('--apply removes the ghost record from worktrees.json', async () => {
    const { repo, ghostPath } = await makeProjectWithGhostWorktree();
    const result = await runFixCommand({
      cwd: repo,
      preview: false,
      apply: true,
      yes: true,
      json: true,
    });
    expect(result.exitCode).toBe(0);

    const after = JSON.parse(await readFile(join(opRoot(repo), 'worktrees.json'), 'utf8')) as {
      worktrees: { path: string }[];
    };
    expect(after.worktrees.find((w) => w.path === ghostPath)).toBeUndefined();
  });

  it('--preview emits a manualSuggestion with copy-paste git command when path exists', async () => {
    const repo = await makeGitRepo('rk-fix-leaked-');
    tracked.push(repo);
    const dirs = ['epics', 'sprints', 'reviews', 'queues', 'lanes', '.repokernel'];
    for (const d of dirs) await mkdir(join(repo, d), { recursive: true });
    await writeFile(join(repo, 'repokernel.config.yaml'), defaultConfigYaml(), 'utf8');
    await writeFile(
      join(repo, 'epics', 'E-100.md'),
      fm({ id: 'E-100', title: 'done', status: 'done', sprints: ['S-100'] }),
      'utf8',
    );
    await writeFile(
      join(repo, 'sprints', 'S-100.md'),
      fm({
        id: 'S-100',
        title: 's',
        epic_id: 'E-100',
        status: 'shipped',
        lane: 'main',
        base_sha: 'c'.repeat(40),
        end_sha: 'd'.repeat(40),
        closed_at: '2026-04-29T12:00:00Z',
      }),
      'utf8',
    );
    await writeFile(join(repo, 'queues', 'main.md'), fm({ lane: 'main', slots: [] }), 'utf8');

    // Existing dir, but not a real git worktree — the finder only checks
    // worktrees.json + activeEpic membership; on-disk directory presence is
    // checked by `rk fix`'s safe/manual classifier.
    const presentPath = join(repo, 'leaked-dir');
    await mkdir(presentPath, { recursive: true });

    await mkdir(opRoot(repo), { recursive: true });
    await writeFile(
      join(opRoot(repo), 'worktrees.json'),
      JSON.stringify(
        {
          worktrees: [
            { epicId: 'E-100', path: presentPath, branch: 'rk/epic/E-100', type: 'epic' },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    await commitAll(repo, 'chore: scaffold');

    const result = await runFixCommand({
      cwd: repo,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout) as FixPreviewJson;
    const manual = preview.manualSuggestions.find((f) =>
      /Remove leaked worktree for E-100/i.test(f.title),
    );
    expect(manual, 'present-path leaked worktree should be a manual suggestion').toBeDefined();
    expect(manual?.detail).toContain(`git worktree remove "${presentPath}"`);
    expect(manual?.detail).toContain('rk fix --apply');

    // Nothing safe-fixable for this case — no auto-prune since path is on disk.
    const safe = preview.safeFixes.find((f) =>
      /Prune ghost worktree record for E-100/i.test(f.title),
    );
    expect(safe).toBeUndefined();
  });
});

describe('runFixCommand — CANCELLED_SPRINT_IN_QUEUE', () => {
  it('--preview surfaces a safe fix for a cancelled sprint sitting in queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'cancelled',
          epic_id: 'E-001',
          status: 'cancelled',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout) as FixPreviewJson;
    const removeFromQueue = preview.safeFixes.find((f) => /remove S-001 from queue/i.test(f.title));
    expect(removeFromQueue, 'cancelled-in-queue should be a safe fix').toBeDefined();
  });
});
