import { describe, expect, it } from 'vitest';
import { planParallelWaves } from '../src/resolver/index.js';

function sprint(
  id: string,
  opts: {
    status?: string;
    epicId?: string;
    deps?: readonly string[];
    paths?: readonly string[];
  } = {},
): unknown {
  return {
    id,
    epic_id: opts.epicId ?? 'E-001',
    lane: 'main',
    status: opts.status ?? 'queued',
    depends_on: opts.deps ?? [],
    blocked_by: [],
    allowed_paths: opts.paths ?? [],
    denied_paths: [],
    generated_paths: [],
    review_required: true,
  };
}

function graph(sprints: Array<ReturnType<typeof sprint>>): unknown {
  const map = new Map();
  for (const s of sprints) map.set((s as { id: string }).id, s);
  return { sprints: map, reviews: new Map(), epics: new Map(), queuesByLane: new Map() };
}

describe('planParallelWaves', () => {
  it('groups dependency-independent sprints with disjoint paths into one wave', () => {
    const g = graph([
      sprint('S-001', { paths: ['apps/web/**'] }),
      sprint('S-002', { paths: ['apps/server/**'] }),
    ]);
    const plan = planParallelWaves(g as never);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]?.entries.map((e) => e.sprint_id)).toEqual(['S-001', 'S-002']);
    expect(plan.skipped).toEqual([]);
  });

  it('splits a wave when allowed_paths overlap', () => {
    const g = graph([
      sprint('S-001', { paths: ['apps/web/**'] }),
      sprint('S-002', { paths: ['apps/web/page.tsx'] }),
    ]);
    const plan = planParallelWaves(g as never);
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0]?.entries.map((e) => e.sprint_id)).toEqual(['S-001']);
    expect(plan.waves[1]?.entries.map((e) => e.sprint_id)).toEqual(['S-002']);
  });

  it('respects dependency order across waves', () => {
    const g = graph([
      sprint('S-001', { paths: ['apps/a/**'] }),
      sprint('S-002', { paths: ['apps/b/**'], deps: ['S-001'] }),
    ]);
    const plan = planParallelWaves(g as never);
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0]?.entries.map((e) => e.sprint_id)).toEqual(['S-001']);
    expect(plan.waves[1]?.entries.map((e) => e.sprint_id)).toEqual(['S-002']);
  });

  it('produces a deterministic plan on repeated runs', () => {
    const g = graph([
      sprint('S-003', { paths: ['apps/c/**'] }),
      sprint('S-001', { paths: ['apps/a/**'] }),
      sprint('S-002', { paths: ['apps/b/**'] }),
    ]);
    const a = planParallelWaves(g as never);
    const b = planParallelWaves(g as never);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.waves[0]?.entries.map((e) => e.sprint_id)).toEqual(['S-001', 'S-002', 'S-003']);
  });

  it('reports unschedulable sprints as skipped (unmet dep)', () => {
    const g = graph([sprint('S-010', { deps: ['S-999'], paths: ['apps/a/**'] })]);
    const plan = planParallelWaves(g as never);
    expect(plan.waves).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.sprint_id).toBe('S-010');
    expect(plan.skipped[0]?.reason).toMatch(/S-999/);
  });

  it('honors sprintIds filter', () => {
    const g = graph([
      sprint('S-001', { paths: ['apps/a/**'] }),
      sprint('S-002', { paths: ['apps/b/**'] }),
      sprint('S-003', { paths: ['apps/c/**'] }),
    ]);
    const plan = planParallelWaves(g as never, { sprintIds: ['S-001', 'S-003'] });
    expect(plan.waves[0]?.entries.map((e) => e.sprint_id)).toEqual(['S-001', 'S-003']);
  });

  it('treats empty allowed_paths as overlapping with everything', () => {
    const g = graph([sprint('S-001', { paths: [] }), sprint('S-002', { paths: ['apps/a/**'] })]);
    const plan = planParallelWaves(g as never);
    expect(plan.waves).toHaveLength(2);
  });
});
