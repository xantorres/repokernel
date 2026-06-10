import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGraph,
  ConfigSchema,
  generateRegistry,
  type Registry,
  type Run,
} from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { getTeamStatus } from '../src/lifecycle/runState.js';
import { eid, runId, sid } from './helpers/brand.js';

const CONFIG = ConfigSchema.parse({
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

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-team-'));
  tracked.push(dir);
  return dir;
}

function emptyRegistry(): Registry {
  return generateRegistry({
    graph: buildGraph({
      sprints: [],
      epics: [],
      reviews: [],
      queues: [],
      lanes: [],
      nextMd: null,
      findings: [],
    }),
    config: CONFIG,
    findings: [],
    now: () => '2026-04-25T10:00:00.000Z',
  });
}

async function writeRunFile(opRoot: string, run: Run): Promise<void> {
  const dir = join(opRoot, 'runs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

function buildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: runId('RUN-001'),
    epic_id: eid('E-001'),
    lane: 'core',
    status: 'running',
    mode: 'autonomous',
    agent: 'claude',
    worktree: '/tmp/wt',
    branch: 'main',
    started_at: '2026-04-25T10:00:00.000Z',
    ended_at: null,
    current_sprint: sid('S-1'),
    completed_sprints: [],
    halt_reason: null,
    limit: null,
    sprint_count: 1,
    execution_strategy: 'sequential',
    wave_index: -1,
    active_sprints: [],
    parallel_workers: [],
    abort_requested: false,
    ...overrides,
  };
}

describe('getTeamStatus', () => {
  it('returns an empty snapshot when no runs and no entities exist', async () => {
    const dir = await tmp();
    const opRoot = join(dir, '.git', 'repokernel');

    const status = await getTeamStatus({
      opRoot,
      registry: emptyRegistry(),
      now: () => new Date('2026-04-25T10:30:00.000Z'),
    });

    expect(status.timestamp).toBe('2026-04-25T10:30:00.000Z');
    expect(status.runs).toEqual([]);
    expect(status.sprints).toEqual([]);
    expect(status.bottlenecks).toEqual([]);
    expect(status.registry).toEqual({
      files_changed: 0,
      conflicts: 0,
      ready_to_merge: true,
      health: 'OK',
    });
    expect(status.schemaVersion).toBe(2);
    expect(status.operational).toEqual({
      live_claims: [],
      corrupt_run_files: [],
      leaked_worktrees: [],
      active_worktree_count: 0,
      collection_errors: [],
    });
  });

  it('exposes run state and computes ETA from elapsed work', async () => {
    const dir = await tmp();
    const opRoot = join(dir, '.git', 'repokernel');
    await writeRunFile(opRoot, buildRun({ active_sprints: ['S-1'].map(sid) }));

    const reg: Registry = {
      ...emptyRegistry(),
      epics: [
        {
          id: eid('E-001'),
          title: 'Epic',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: ['S-1'].map(sid),
          file: 'E-001.md',
        },
      ],
      sprints: [
        {
          id: sid('S-1'),
          title: 'Build feature',
          epic_id: eid('E-001'),
          status: 'active',
          lane: 'core',
          gate: null,
          depends_on: [],
          blocked_by: [],
          allowed_paths: [],
          denied_paths: [],
          generated_paths: [],
          review_required: true,
          review_id: null,
          started_at: '2026-04-25T10:00:00.000Z',
          closed_at: null,
          base_sha: null,
          end_sha: null,
          file: 'S-1.md',
        },
      ],
    };

    const status = await getTeamStatus({
      opRoot,
      registry: reg,
      now: () => new Date('2026-04-25T11:00:00.000Z'),
    });

    expect(status.runs).toHaveLength(1);
    expect(status.runs[0]?.run_id).toBe('RUN-001');
    expect(status.runs[0]?.states.active).toBe(1);
    expect(status.runs[0]?.eta).not.toBeNull();
    expect(status.sprints).toHaveLength(1);
    expect(status.sprints[0]?.agent).toBe('claude');
    expect(status.sprints[0]?.run_id).toBe('RUN-001');
  });

  it('flags review-state and blocked sprints as bottlenecks', async () => {
    const dir = await tmp();
    const opRoot = join(dir, '.git', 'repokernel');
    const reg: Registry = {
      ...emptyRegistry(),
      sprints: [
        {
          id: sid('S-1'),
          title: 'awaiting review',
          epic_id: eid('E-001'),
          status: 'review',
          lane: 'core',
          gate: null,
          depends_on: [],
          blocked_by: [],
          allowed_paths: [],
          denied_paths: [],
          generated_paths: [],
          review_required: true,
          review_id: null,
          started_at: null,
          closed_at: null,
          base_sha: null,
          end_sha: null,
          file: 'S-1.md',
        },
        {
          id: sid('S-2'),
          title: 'blocked',
          epic_id: eid('E-001'),
          status: 'pending',
          lane: 'core',
          gate: null,
          depends_on: ['S-1'].map(sid),
          blocked_by: ['S-1'].map(sid),
          allowed_paths: [],
          denied_paths: [],
          generated_paths: [],
          review_required: true,
          review_id: null,
          started_at: null,
          closed_at: null,
          base_sha: null,
          end_sha: null,
          file: 'S-2.md',
        },
      ],
    };

    const status = await getTeamStatus({
      opRoot,
      registry: reg,
      now: () => new Date('2026-04-25T10:30:00.000Z'),
    });

    expect(status.bottlenecks).toEqual(['S-1: awaiting_review', 'S-2: blocked_by S-1']);
  });

  it('filters sprints to a single id when sprintId is set', async () => {
    const dir = await tmp();
    const opRoot = join(dir, '.git', 'repokernel');
    const reg: Registry = {
      ...emptyRegistry(),
      sprints: [
        {
          id: sid('S-1'),
          title: 'one',
          epic_id: eid('E-001'),
          status: 'planned',
          lane: 'core',
          gate: null,
          depends_on: [],
          blocked_by: [],
          allowed_paths: [],
          denied_paths: [],
          generated_paths: [],
          review_required: true,
          review_id: null,
          started_at: null,
          closed_at: null,
          base_sha: null,
          end_sha: null,
          file: 'S-1.md',
        },
        {
          id: sid('S-2'),
          title: 'two',
          epic_id: eid('E-001'),
          status: 'planned',
          lane: 'core',
          gate: null,
          depends_on: [],
          blocked_by: [],
          allowed_paths: [],
          denied_paths: [],
          generated_paths: [],
          review_required: true,
          review_id: null,
          started_at: null,
          closed_at: null,
          base_sha: null,
          end_sha: null,
          file: 'S-2.md',
        },
      ],
    };

    const status = await getTeamStatus({
      opRoot,
      registry: reg,
      now: () => new Date('2026-04-25T10:00:00.000Z'),
      sprintId: 'S-2',
    });

    expect(status.sprints.map((s) => s.id)).toEqual(['S-2']);
  });

  it('surfaces corrupt run files as degraded status bottlenecks', async () => {
    const dir = await tmp();
    const opRoot = join(dir, '.git', 'repokernel');
    await mkdir(join(opRoot, 'runs'), { recursive: true });
    await writeFile(join(opRoot, 'runs', 'RUN-999.json'), '{not-json', 'utf8');

    const status = await getTeamStatus({
      opRoot,
      registry: emptyRegistry(),
      now: () => new Date('2026-04-25T10:00:00.000Z'),
    });

    expect(status.registry.ready_to_merge).toBe(false);
    expect(status.registry.health).toBe('DEGRADED');
    expect(status.operational.corrupt_run_files).toHaveLength(1);
    // Corrupt files live in operational only; not duplicated into bottlenecks.
    expect(status.bottlenecks.some((line) => line.includes('corrupt run state'))).toBe(false);
  });
});
