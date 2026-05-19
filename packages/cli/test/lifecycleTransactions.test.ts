import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runCreateQueueCommand } from '../src/commands/create.js';
import { runEpicAddSprintCommand } from '../src/commands/epic.js';
import { runGatesCommand } from '../src/commands/gates.js';
import { runPlanCommand } from '../src/commands/plan.js';
import { runRegistryCommand } from '../src/commands/registry.js';
import { runReviewSprintCommand } from '../src/commands/reviewSprint.js';
import { runShipCommand } from '../src/commands/ship.js';
import { runWaveCommand } from '../src/commands/wave.js';
import { journalRoot, operationalRootBestEffort } from '../src/lifecycle/controlPaths.js';
import { ambientJournalWrite } from '../src/lifecycle/journal.js';
import { withLifecycleScope } from '../src/lifecycle/transaction.js';
import {
  cleanupAllFixtures,
  defaultConfigYaml,
  fm,
  makeFixture,
  resetTrustForTest,
  seedTrustForCwd,
} from './helpers/fixture.js';

vi.mock('../src/lifecycle/git.js', () => ({
  getCurrentSha: vi.fn().mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd'),
  isWorkingTreeClean: vi.fn().mockResolvedValue(true),
  changedFilesSince: vi.fn().mockResolvedValue(['src/app.ts']),
}));
vi.mock('../src/lifecycle/worktree.js', () => ({
  findSprintWorktreePath: vi.fn().mockResolvedValue(null),
}));

import { changedFilesSince, getCurrentSha, isWorkingTreeClean } from '../src/lifecycle/git.js';
import { findSprintWorktreePath } from '../src/lifecycle/worktree.js';

afterAll(cleanupAllFixtures);

let originalTrustEnv: string | undefined;
afterEach(() => {
  vi.mocked(getCurrentSha).mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd');
  vi.mocked(isWorkingTreeClean).mockResolvedValue(true);
  vi.mocked(changedFilesSince).mockResolvedValue(['src/app.ts']);
  vi.mocked(findSprintWorktreePath).mockResolvedValue(null);
  resetTrustForTest(originalTrustEnv);
  originalTrustEnv = undefined;
});

async function journalState(cwd: string): Promise<{
  pending: string[];
  done: string[];
  envelopes: Array<Record<string, unknown>>;
}> {
  const opRoot = await operationalRootBestEffort(cwd);
  const dir = journalRoot(opRoot);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const done = entries.filter((entry) => entry.endsWith('.done.json')).sort();
  const pending = entries.filter((entry) => entry.endsWith('.pending.json')).sort();
  const envelopes = await Promise.all(
    done.map(async (entry) => JSON.parse(await readFile(join(dir, entry), 'utf8'))),
  );
  return { pending, done, envelopes };
}

async function readFm(cwd: string, path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(cwd, path), 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

function config(extra = ''): string {
  return `${defaultConfigYaml()}automation:
  defaultReviewer: codex
${extra}`;
}

function activeShipFixture(): Parameters<typeof makeFixture>[0] {
  return [
    { path: 'repokernel.config.yaml', content: config() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Ship flow', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Implement feature',
        epic_id: 'E-001',
        status: 'active',
        lane: 'main',
        allowed_paths: ['src'],
        base_sha: 'abc1234',
        started_at: '2026-05-18T08:00:00Z',
      }),
    },
    {
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
    },
  ];
}

describe('lifecycle transactions', () => {
  it('leaves a pending journal when an apply block throws after a write', async () => {
    const cwd = await makeFixture([{ path: 'repokernel.config.yaml', content: config() }]);
    const target = join(cwd, '.repokernel', 'transaction-fixture.txt');

    await mkdir(join(cwd, '.repokernel'), { recursive: true });
    await expect(
      withLifecycleScope({ cwd, command: 'test-apply-failure' }, async () => {
        await ambientJournalWrite(target, 'partial\n');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const journals = await journalState(cwd);
    expect(journals.pending).toHaveLength(1);
    expect(journals.done).toEqual([]);
  });

  it('journals review-sprint mutation and registry refresh as one command', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Review flow', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Reviewable',
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
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runReviewSprintCommand('S-001', { cwd, dryRun: false, json: true });

    expect(result.exitCode).toBe(0);
    expect((await readFm(cwd, 'reviews/R-001.md')).verdict).toBe('accepted');
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toHaveLength(1);
    expect(journals.envelopes[0]?.command).toBe('review-sprint');
  });

  it('journals gates evidence as one outer command', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: config('  checksCmd: "node -e \\"process.exit(0)\\""\n'),
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Gates flow', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Run gates',
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
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const registry = await runRegistryCommand({ cwd, write: true, check: false, json: false });
    expect(registry.exitCode).toBe(0);
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    await seedTrustForCwd(cwd, { checks_cmd: true });

    const result = await runGatesCommand('S-001', { cwd, json: false });

    expect(result.exitCode).toBe(0);
    const review = await readFm(cwd, 'reviews/R-001.md');
    expect(review.command_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'configured-checks', status: 'passed' }),
        expect.objectContaining({ label: 'registry-check', status: 'passed' }),
      ]),
    );
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toHaveLength(1);
    expect(journals.envelopes[0]?.command).toBe('gates');
    const steps = journals.envelopes[0]?.steps as Array<{ subCommand?: string }>;
    expect(steps.map((step) => step.subCommand).filter(Boolean)).toContain('review-evidence');
  });

  it('wave preflight blocks stale queue candidates before any mutation or journal', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Wave stale queue',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Eligible first',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Already queued by file only',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-002', order: 0 }] }),
      },
    ]);

    const result = await runWaveCommand('E-001', {
      cwd,
      apply: true,
      createSprint: false,
      enqueue: true,
      json: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('already present in a queue');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('planned');
    const queue = await readFm(cwd, 'queues/main.md');
    expect(queue.slots).toEqual([{ id: 'Q-001', sprint_id: 'S-002', order: 0 }]);
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toEqual([]);
  });

  it('wave applies queue and sprint writes under one transaction', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Wave success',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Eligible one',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Eligible two',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runWaveCommand('E-001', {
      cwd,
      apply: true,
      createSprint: false,
      enqueue: true,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('queued');
    expect((await readFm(cwd, 'sprints/S-002.md')).status).toBe('queued');
    const queue = await readFm(cwd, 'queues/main.md');
    expect(queue.slots).toEqual([
      expect.objectContaining({ sprint_id: 'S-001' }),
      expect.objectContaining({ sprint_id: 'S-002' }),
    ]);
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toHaveLength(1);
    expect(journals.envelopes[0]?.command).toBe('wave');
  });

  it('plan-created sprint, counter, and epic update share the create-sprint transaction', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Plan into sprint', status: 'active', sprints: [] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runPlanCommand('E-001', {
      cwd,
      createSprint: true,
      enqueue: false,
      singleSprint: true,
      split: false,
      noSprint: false,
      allowedPaths: ['src'],
      yes: true,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { sprintId: string; file: string };
    expect(payload.sprintId).toBe('S-001');
    expect((await readFm(cwd, 'epics/E-001.md')).sprints).toEqual(['S-001']);
    expect((await readFm(cwd, payload.file)).status).toBe('planned');
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toHaveLength(1);
    expect(journals.envelopes[0]?.command).toBe('create-sprint');
  });

  it('create queue writes the queue and registry under one transaction', async () => {
    const cwd = await makeFixture([{ path: 'repokernel.config.yaml', content: config() }]);

    const result = await runCreateQueueCommand({ cwd, lane: 'main', json: true });

    expect(result.exitCode).toBe(0);
    expect((await readFm(cwd, 'queues/main.md')).lane).toBe('main');
    await expect(readFile(join(cwd, '.repokernel/registry.json'), 'utf8')).resolves.toContain(
      '"queue"',
    );
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toHaveLength(1);
    expect(journals.envelopes[0]?.command).toBe('create-queue');
  });

  it('epic add-sprint updates epic and registry under one transaction', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Manual epic link', status: 'active', sprints: [] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Unlinked sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runEpicAddSprintCommand('E-001', 'S-001', {
      cwd,
      dryRun: false,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    expect((await readFm(cwd, 'epics/E-001.md')).sprints).toEqual(['S-001']);
    await expect(readFile(join(cwd, '.repokernel/registry.json'), 'utf8')).resolves.toContain(
      '"epics"',
    );
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toHaveLength(1);
    expect(journals.envelopes[0]?.command).toBe('epic-add-sprint');
  });

  it('ship registry preflight failure leaves sprint, review files, and journal untouched', async () => {
    const cwd = await makeFixture(activeShipFixture());

    const result = await runShipCommand('S-001', { cwd, dryRun: false, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('registry drift detected');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('active');
    await expect(readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toEqual([]);
  });

  it('ship active-sprint review preflight failure leaves no journal', async () => {
    vi.mocked(changedFilesSince).mockResolvedValue([]);
    const cwd = await makeFixture(activeShipFixture());
    const registry = await runRegistryCommand({ cwd, write: true, check: false, json: false });
    expect(registry.exitCode).toBe(0);

    const result = await runShipCommand('S-001', { cwd, dryRun: false, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('no changes since base_sha');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('active');
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toEqual([]);
  });

  it('ship applies review, evidence, close, and registry refresh under one outer journal', async () => {
    const cwd = await makeFixture(activeShipFixture());
    const registry = await runRegistryCommand({ cwd, write: true, check: false, json: false });
    expect(registry.exitCode).toBe(0);

    const result = await runShipCommand('S-001', { cwd, dryRun: false, json: false });

    expect(result.exitCode).toBe(0);
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('shipped');
    const journals = await journalState(cwd);
    expect(journals.pending).toEqual([]);
    expect(journals.done).toHaveLength(1);
    const envelope = journals.envelopes[0]!;
    expect(envelope.command).toBe('ship');
    const steps = envelope.steps as Array<{ subCommand?: string }>;
    expect(steps.map((step) => step.subCommand).filter(Boolean)).toEqual(
      expect.arrayContaining(['review', 'review-sprint', 'review-evidence', 'close']),
    );
  });
});
