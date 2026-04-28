import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/graph/types.js';
import { buildExecutionWaves, buildWavePreview } from '../src/graph/waves.js';
import type { Epic } from '../src/schemas/epic.js';
import type { Sprint } from '../src/schemas/sprint.js';

// --- test helpers ---

function sprint(
  id: string,
  opts: {
    status?: Sprint['status'];
    depends_on?: string[];
    blocked_by?: string[];
    gate?: string;
    epic_id?: string;
    allowed_paths?: string[];
  } = {},
): Sprint {
  return {
    id,
    title: id,
    epic_id: opts.epic_id ?? 'E-001',
    status: opts.status ?? 'queued',
    lane: 'main',
    gate: opts.gate,
    depends_on: opts.depends_on ?? [],
    blocked_by: opts.blocked_by ?? [],
    allowed_paths: opts.allowed_paths ?? [],
    denied_paths: [],
    generated_paths: [],
    review_required: true,
    review_id: undefined,
    started_at: undefined,
    closed_at: undefined,
    base_sha: undefined,
    end_sha: undefined,
    adr_links: [],
    extras: {},
    file: `sprints/${id}.md`,
    body: '',
  };
}

function epic(id: string, sprintIds: string[]): Epic {
  return {
    id,
    title: id,
    status: 'active',
    sprints: sprintIds,
    adr_links: [],
    extras: {},
    file: `epics/${id}.md`,
    body: '',
  };
}

function graph(epics: Epic[], sprints: Sprint[]): Pick<Graph, 'epics' | 'sprints' | 'dependsOn'> {
  return {
    epics: new Map(epics.map((e) => [e.id, e])),
    sprints: new Map(sprints.map((s) => [s.id, s])),
    dependsOn: new Map(sprints.map((s) => [s.id, s.depends_on])),
  };
}

const noShipped = new Set<string>();

const ids = (waves: readonly { readonly sprints: readonly { readonly id: string }[] }[]) =>
  waves.map((w) => w.sprints.map((s) => s.id));

// --- buildExecutionWaves ---

describe('buildExecutionWaves', () => {
  it('returns [] for unknown epic', () => {
    const g = graph([], []);
    expect(buildExecutionWaves(g as Graph, 'E-999', noShipped, 4)).toEqual([]);
  });

  it('returns [] when epic has no queued sprints', () => {
    const g = graph([epic('E-001', ['S-001'])], [sprint('S-001', { status: 'planned' })]);
    expect(buildExecutionWaves(g as Graph, 'E-001', noShipped, 4)).toEqual([]);
  });

  it('rejects non-positive wave limits', () => {
    const g = graph([epic('E-001', ['S-001'])], [sprint('S-001')]);
    expect(() => buildExecutionWaves(g as Graph, 'E-001', noShipped, 0)).toThrow(RangeError);
  });

  it('single sprint → single wave', () => {
    const g = graph([epic('E-001', ['S-001'])], [sprint('S-001')]);
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    expect(ids(waves)).toEqual([['S-001']]);
    expect(waves[0]!.canParallelize).toBe(false);
    expect(waves[0]!.index).toBe(0);
  });

  it('linear chain: S-001 → S-002 → S-003 gives 3 waves', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [
        sprint('S-001'),
        sprint('S-002', { depends_on: ['S-001'] }),
        sprint('S-003', { depends_on: ['S-002'] }),
      ],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    expect(ids(waves)).toEqual([['S-001'], ['S-002'], ['S-003']]);
    for (const w of waves) expect(w.canParallelize).toBe(false);
  });

  it('diamond: S-001 S-002 independent, S-003 depends on both → 2 waves', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [sprint('S-001'), sprint('S-002'), sprint('S-003', { depends_on: ['S-001', 'S-002'] })],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    expect(ids(waves)).toEqual([['S-001', 'S-002'], ['S-003']]);
    expect(waves[0]!.canParallelize).toBe(true);
    expect(waves[1]!.canParallelize).toBe(false);
  });

  it('fork: S-001 independent, S-002 S-003 both depend on S-001 → 2 waves', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [
        sprint('S-001'),
        sprint('S-002', { depends_on: ['S-001'] }),
        sprint('S-003', { depends_on: ['S-001'] }),
      ],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    expect(ids(waves)).toEqual([['S-001'], ['S-002', 'S-003']]);
    expect(waves[1]!.canParallelize).toBe(true);
  });

  it('wide: 5 fully independent sprints → single wave', () => {
    const sprintIds = ['S-001', 'S-002', 'S-003', 'S-004', 'S-005'];
    const g = graph(
      [epic('E-001', sprintIds)],
      sprintIds.map((id) => sprint(id)),
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 10);
    expect(ids(waves)).toEqual([['S-001', 'S-002', 'S-003', 'S-004', 'S-005']]);
    expect(waves[0]!.canParallelize).toBe(true);
  });

  it('limit splits wide wave into sub-waves', () => {
    const sprintIds = ['S-001', 'S-002', 'S-003', 'S-004', 'S-005'];
    const g = graph(
      [epic('E-001', sprintIds)],
      sprintIds.map((id) => sprint(id)),
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 2);
    // Natural wave has 5, split into ceil(5/2)=3 sub-waves: [2, 2, 1]
    expect(ids(waves)).toEqual([['S-001', 'S-002'], ['S-003', 'S-004'], ['S-005']]);
    expect(waves[0]!.index).toBe(0);
    expect(waves[1]!.index).toBe(1);
    expect(waves[2]!.index).toBe(2);
    expect(waves[2]!.canParallelize).toBe(false);
  });

  it('when lane-scoped, only considers queued sprints from that lane queue and epic', () => {
    const base = graph(
      [epic('E-001', ['S-001', 'S-002']), epic('E-002', ['S-003'])],
      [
        sprint('S-001', { epic_id: 'E-001' }),
        sprint('S-002', { epic_id: 'E-001' }),
        sprint('S-003', { epic_id: 'E-002' }),
      ],
    );
    const g = {
      ...base,
      queuesByLane: new Map([
        [
          'main',
          [
            { id: 'Q-003', sprint_id: 'S-003', order: 0 },
            { id: 'Q-001', sprint_id: 'S-001', order: 1 },
          ],
        ],
      ]),
    };
    const waves = buildExecutionWaves(g as unknown as Graph, 'E-001', noShipped, 4, {
      lane: 'main',
    });
    expect(ids(waves)).toEqual([['S-001']]);
  });

  it('already-shipped dep is satisfied', () => {
    const g = graph([epic('E-001', ['S-002'])], [sprint('S-002', { depends_on: ['S-001'] })]);
    const shipped = new Set(['S-001']);
    const waves = buildExecutionWaves(g as Graph, 'E-001', shipped, 4);
    expect(ids(waves)).toEqual([['S-002']]);
  });

  it('gated sprint excluded from all waves', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002'])],
      [sprint('S-001'), sprint('S-002', { gate: 'APPROVAL' })],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    // S-002 is gated → only S-001 in waves
    expect(ids(waves)).toEqual([['S-001']]);
  });

  it('sprint depending on gated sprint also excluded', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [
        sprint('S-001'),
        sprint('S-002', { gate: 'GATE' }),
        sprint('S-003', { depends_on: ['S-002'] }),
      ],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    // S-002 gated, S-003 blocked by S-002 → only S-001
    expect(ids(waves)).toEqual([['S-001']]);
  });

  it('non-queued sprints are excluded', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [
        sprint('S-001'),
        sprint('S-002', { status: 'planned' }),
        sprint('S-003', { status: 'shipped' }),
      ],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    expect(ids(waves)).toEqual([['S-001']]);
  });

  it('canonical order from epic.sprints used for determinism', () => {
    // S-003 listed before S-001 in epic.sprints — both independent
    // Result should still be sorted by sprint ID within wave
    const g = graph(
      [epic('E-001', ['S-003', 'S-001', 'S-002'])],
      [sprint('S-001'), sprint('S-002'), sprint('S-003')],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    // sorted by id within wave
    expect(ids(waves)).toEqual([['S-001', 'S-002', 'S-003']]);
  });

  it('lane-scoped wave preserves queue slot order, not sprint-ID order', () => {
    // Queue order: S-003, S-001, S-002 — all independent, all in E-001
    const base = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [sprint('S-001'), sprint('S-002'), sprint('S-003')],
    );
    const g = {
      ...base,
      queuesByLane: new Map([
        [
          'main',
          [
            { id: 'Q-003', sprint_id: 'S-003', order: 0 },
            { id: 'Q-001', sprint_id: 'S-001', order: 1 },
            { id: 'Q-002', sprint_id: 'S-002', order: 2 },
          ],
        ],
      ]),
    };
    const waves = buildExecutionWaves(g as unknown as Graph, 'E-001', noShipped, 4, {
      lane: 'main',
    });
    // Queue order [S-003, S-001, S-002] must be preserved, not sorted by ID
    expect(ids(waves)).toEqual([['S-003', 'S-001', 'S-002']]);
  });

  it('all blocked by unsatisfied dep → returns []', () => {
    const g = graph([epic('E-001', ['S-002'])], [sprint('S-002', { depends_on: ['S-EXTERNAL'] })]);
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    expect(waves).toEqual([]);
  });

  it('blocked_by gates wave selection just like depends_on', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002'])],
      [sprint('S-001'), sprint('S-002', { blocked_by: ['S-001'] })],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    // S-002 has blocked_by S-001 → must wait until S-001 is in willBeShipped
    expect(ids(waves)).toEqual([['S-001'], ['S-002']]);
  });

  it('blocked_by combines with depends_on — both must clear', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [
        sprint('S-001'),
        sprint('S-002'),
        sprint('S-003', { depends_on: ['S-001'], blocked_by: ['S-002'] }),
      ],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 4);
    expect(ids(waves)).toEqual([['S-001', 'S-002'], ['S-003']]);
  });

  it('blocked_by on already-shipped sprint is satisfied', () => {
    const g = graph([epic('E-001', ['S-002'])], [sprint('S-002', { blocked_by: ['S-001'] })]);
    const shipped = new Set(['S-001']);
    const waves = buildExecutionWaves(g as Graph, 'E-001', shipped, 4);
    expect(ids(waves)).toEqual([['S-002']]);
  });

  it('wave indices are sequential across natural waves and chunks', () => {
    // 3 natural waves: [S-001,S-002], [S-003], [S-004]
    // limit = 1 → each becomes its own sub-wave
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003', 'S-004'])],
      [
        sprint('S-001'),
        sprint('S-002'),
        sprint('S-003', { depends_on: ['S-001'] }),
        sprint('S-004', { depends_on: ['S-003'] }),
      ],
    );
    const waves = buildExecutionWaves(g as Graph, 'E-001', noShipped, 1);
    expect(waves.map((w) => w.index)).toEqual([0, 1, 2, 3]);
    expect(ids(waves)).toEqual([['S-001'], ['S-002'], ['S-003'], ['S-004']]);
  });
});

// --- buildWavePreview ---

describe('buildWavePreview', () => {
  it('returns [] for unknown epic', () => {
    const g = graph([], []);
    expect(buildWavePreview(g as Graph, 'E-999', noShipped)).toEqual([]);
  });

  it('shows runnable sprints in wave, planned sprints in planned field', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002'])],
      [sprint('S-001'), sprint('S-002', { status: 'planned' })],
    );
    const preview = buildWavePreview(g as Graph, 'E-001', noShipped);
    expect(preview).toHaveLength(1);
    expect(preview[0]!.sprints.map((s) => s.id)).toEqual(['S-001']);
    expect(preview[0]!.planned.map((s) => s.id)).toEqual(['S-002']);
  });

  it('shows gated sprints in gated field', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002'])],
      [sprint('S-001'), sprint('S-002', { gate: 'APPROVAL' })],
    );
    const preview = buildWavePreview(g as Graph, 'E-001', noShipped);
    // Wave 0: S-001 runnable; S-002 gated
    expect(preview[0]!.sprints.map((s) => s.id)).toEqual(['S-001']);
    expect(preview[0]!.gated.map((s) => s.id)).toEqual(['S-002']);
  });

  it('shows blocked sprints with reason in blocked field', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002'])],
      [sprint('S-001'), sprint('S-002', { depends_on: ['S-EXTERNAL'] })],
    );
    const preview = buildWavePreview(g as Graph, 'E-001', noShipped);
    // S-002 is blocked (dep S-EXTERNAL unshipped) — surfaced in wave 0's blocked list
    expect(preview[0]!.sprints.map((s) => s.id)).toEqual(['S-001']);
    expect(preview[0]!.blocked.map((b) => b.sprint.id)).toEqual(['S-002']);
    expect(preview[0]!.blocked[0]!.reason).toContain('S-EXTERNAL');
    // After wave 0 ships S-001, S-002 still blocked (S-EXTERNAL still unshipped)
    expect(preview[1]!.sprints).toHaveLength(0);
    expect(preview[1]!.blocked.map((b) => b.sprint.id)).toEqual(['S-002']);
  });

  it('only planned sprints → single empty wave with planned', () => {
    const g = graph([epic('E-001', ['S-001'])], [sprint('S-001', { status: 'planned' })]);
    const preview = buildWavePreview(g as Graph, 'E-001', noShipped);
    expect(preview).toHaveLength(1);
    expect(preview[0]!.sprints).toHaveLength(0);
    expect(preview[0]!.planned.map((s) => s.id)).toEqual(['S-001']);
  });

  it('multi-wave preview has canParallelize set correctly', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [sprint('S-001'), sprint('S-002'), sprint('S-003', { depends_on: ['S-001', 'S-002'] })],
    );
    const preview = buildWavePreview(g as Graph, 'E-001', noShipped);
    expect(preview[0]!.canParallelize).toBe(true); // [S-001, S-002]
    expect(preview[1]!.canParallelize).toBe(false); // [S-003]
  });

  it('indices are sequential', () => {
    const g = graph(
      [epic('E-001', ['S-001', 'S-002', 'S-003'])],
      [
        sprint('S-001'),
        sprint('S-002', { depends_on: ['S-001'] }),
        sprint('S-003', { depends_on: ['S-002'] }),
      ],
    );
    const preview = buildWavePreview(g as Graph, 'E-001', noShipped);
    expect(preview.map((w) => w.index)).toEqual([0, 1, 2]);
  });
});
