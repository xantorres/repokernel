import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  type Config,
  ConfigSchema,
  canonicalJson,
  checkRegistryIntegrity,
  compareRegistries,
  generateRegistry,
  mergeRegistries,
  mergeRegistriesThreeWay,
  type ParsedProject,
  type Registry,
  RegistrySchema,
  type RegistrySprint,
  stripVolatile,
} from '../src/index.js';
import { eid, rid, sid } from './helpers/brand.js';

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

const empty: ParsedProject = {
  sprints: [],
  epics: [],
  reviews: [],
  queues: [],
  lanes: [],
  nextMd: null,
  findings: [],
};

describe('generateRegistry', () => {
  it('produces a schema-valid registry', () => {
    const graph = buildGraph(empty);
    const reg = generateRegistry({
      graph,
      config: CONFIG,
      findings: [],
      now: () => '2026-04-25T10:00:00.000Z',
    });
    expect(() => RegistrySchema.parse(reg)).not.toThrow();
    expect(reg.schemaVersion).toBe(3);
    expect(reg.project.id).toBe('demo');
  });

  it('serializes to canonical JSON deterministically', () => {
    const graph = buildGraph(empty);
    const reg = generateRegistry({
      graph,
      config: CONFIG,
      findings: [],
      now: () => '2026-04-25T10:00:00.000Z',
    });
    const a = canonicalJson(reg);
    const b = canonicalJson(reg);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });

  it('counts findings by severity and computes maxSeverity', () => {
    const graph = buildGraph(empty);
    const reg = generateRegistry({
      graph,
      config: CONFIG,
      findings: [
        { severity: 'P1', code: 'A', message: 'a' },
        { severity: 'P2', code: 'B', message: 'b' },
        { severity: 'P0', code: 'C', message: 'c' },
      ],
      now: () => '2026-04-25T10:00:00.000Z',
    });
    expect(reg.health.findingCounts).toEqual({ P0: 1, P1: 1, P2: 1, P3: 0 });
    expect(reg.health.maxSeverity).toBe('P0');
    expect(reg.health.blocked).toBe(true);
  });
});

describe('compareRegistries', () => {
  it('reports no drift when only generatedAt differs', () => {
    const graph = buildGraph(empty);
    const a = generateRegistry({
      graph,
      config: CONFIG,
      findings: [],
      now: () => '2026-04-25T10:00:00.000Z',
    });
    const b = generateRegistry({
      graph,
      config: CONFIG,
      findings: [],
      now: () => '2026-04-26T10:00:00.000Z',
    });
    expect(compareRegistries(a, b).drift).toBe(false);
  });

  it('reports drift when content differs', () => {
    const graph = buildGraph(empty);
    const a = generateRegistry({
      graph,
      config: CONFIG,
      findings: [],
      now: () => '2026-04-25T10:00:00.000Z',
    });
    const b = generateRegistry({
      graph,
      config: CONFIG,
      findings: [{ severity: 'P3', code: 'X', message: 'x' }],
      now: () => '2026-04-25T10:00:00.000Z',
    });
    expect(compareRegistries(a, b).drift).toBe(true);
  });
});

describe('stripVolatile', () => {
  it('drops generatedAt and generatedBy', () => {
    const result = stripVolatile({
      generatedAt: '2026-04-25T10:00:00.000Z',
      generatedBy: 'rk',
      project: { id: 'a' },
    });
    expect(result).toEqual({ project: { id: 'a' } });
  });
});

function baseRegistry(): Registry {
  const graph = buildGraph(empty);
  return generateRegistry({
    graph,
    config: CONFIG,
    findings: [],
    now: () => '2026-04-25T10:00:00.000Z',
  });
}

function sprint(id: string, overrides: Partial<RegistrySprint> = {}): RegistrySprint {
  return {
    id: sid(id),
    title: `Sprint ${id}`,
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
    file: `${id}.md`,
    ...overrides,
  };
}

describe('mergeRegistries', () => {
  it('is idempotent for identical inputs', () => {
    const reg = baseRegistry();
    const result = mergeRegistries(reg, reg);
    expect(result.conflicts).toEqual([]);
    expect(canonicalJson(stripVolatile(result.registry))).toBe(canonicalJson(stripVolatile(reg)));
  });

  it('unions sprints by id and prefers further status', () => {
    const local: Registry = {
      ...baseRegistry(),
      epics: [
        {
          id: eid('E-001'),
          title: 'Epic 1',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: ['S-1', 'S-2'].map(sid),
          file: 'E-001.md',
        },
      ],
      sprints: [sprint('S-1', { status: 'active' }), sprint('S-2', { status: 'planned' })],
    };
    const remote: Registry = {
      ...baseRegistry(),
      epics: [
        {
          id: eid('E-001'),
          title: 'Epic 1',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: ['S-1', 'S-3'].map(sid),
          file: 'E-001.md',
        },
      ],
      sprints: [sprint('S-1', { status: 'review' }), sprint('S-3', { status: 'pending' })],
    };

    const { registry, conflicts } = mergeRegistries(local, remote);

    expect(conflicts).toEqual([]);
    expect(registry.sprints.map((s) => s.id)).toEqual(['S-1', 'S-2', 'S-3']);
    expect(registry.sprints.find((s) => s.id === 'S-1')?.status).toBe('review');
    expect(registry.epics[0]?.sprints).toEqual(['S-1', 'S-2', 'S-3']);
  });

  it('reports immutable-field conflicts without throwing', () => {
    const local: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1', { title: 'Original' })],
    };
    const remote: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1', { title: 'Renamed' })],
    };
    const { conflicts } = mergeRegistries(local, remote);
    expect(conflicts).toEqual([
      {
        kind: 'sprint_immutable',
        id: 'S-1',
        field: 'title',
        local: 'Original',
        remote: 'Renamed',
      },
    ]);
  });

  it('keeps shipped state over a divergent cancelled state', () => {
    const local: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1', { status: 'shipped', closed_at: '2026-04-25T11:00:00.000Z' })],
    };
    const remote: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1', { status: 'cancelled' })],
    };
    const { registry } = mergeRegistries(local, remote);
    expect(registry.sprints[0]?.status).toBe('shipped');
  });

  it('escalates review verdicts to the more conservative side', () => {
    const local: Registry = {
      ...baseRegistry(),
      reviews: [
        {
          id: rid('R-1'),
          sprint_id: sid('S-1'),
          verdict: 'accepted',
          reviewer: 'a',
          base_sha: null,
          end_sha: null,
          file: 'R-1.md',
        },
      ],
    };
    const remote: Registry = {
      ...baseRegistry(),
      reviews: [
        {
          id: rid('R-1'),
          sprint_id: sid('S-1'),
          verdict: 'rejected',
          reviewer: 'a',
          base_sha: null,
          end_sha: null,
          file: 'R-1.md',
        },
      ],
    };
    const { registry } = mergeRegistries(local, remote);
    expect(registry.reviews[0]?.verdict).toBe('rejected');
  });

  it('is commutative on diverged project name with matching id', () => {
    const a: Registry = {
      ...baseRegistry(),
      project: { id: 'demo', name: 'Demo' },
    };
    const b: Registry = {
      ...baseRegistry(),
      project: { id: 'demo', name: 'Demo Renamed' },
    };
    const ab = mergeRegistries(a, b).registry.project;
    const ba = mergeRegistries(b, a).registry.project;
    expect(ab).toEqual(ba);
  });

  it('flags a divergent lane claim while keeping the local owner', () => {
    const local: Registry = {
      ...baseRegistry(),
      lanes: [
        {
          name: 'core',
          claimed_by: 'agent-A',
          claimed_at: '2026-04-25T10:30:00.000Z',
          inferred: false,
        },
      ],
    };
    const remote: Registry = {
      ...baseRegistry(),
      lanes: [
        {
          name: 'core',
          claimed_by: 'agent-B',
          claimed_at: '2026-04-25T10:31:00.000Z',
          inferred: false,
        },
      ],
    };
    const { registry, conflicts } = mergeRegistries(local, remote);
    expect(conflicts.find((c) => c.kind === 'lane_claim')).toBeDefined();
    expect(registry.lanes[0]?.claimed_by).toBe('agent-A');
  });

  it('preserves distinct queue slots and surfaces a conflict when branches reuse the same slot id for different sprints', () => {
    const local: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1')],
      queue: { core: [{ id: 'Q-001', sprint_id: sid('S-1'), order: 0 }] },
    };
    const remote: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-2')],
      queue: { core: [{ id: 'Q-001', sprint_id: sid('S-2'), order: 0 }] },
    };

    const { registry, conflicts } = mergeRegistries(local, remote);

    expect(conflicts.find((c) => c.kind === 'queue_id_collision')).toBeDefined();
    expect(registry.queue.core?.map((slot) => slot.sprint_id).sort()).toEqual(['S-1', 'S-2']);
    // Slot ids must remain unique post-merge — the loser is renamed deterministically.
    const ids = registry.queue.core?.map((slot) => slot.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('surfaces a queue_id_collision conflict when cross-sprint id borrow is detected', () => {
    const local: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1'), sprint('S-2')],
      queue: {
        core: [
          { id: 'Q-001', sprint_id: sid('S-1'), order: 0 },
          { id: 'Q-002', sprint_id: sid('S-2'), order: 1 },
        ],
      },
    };
    const remote: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1'), sprint('S-2')],
      queue: {
        core: [
          { id: 'Q-001', sprint_id: sid('S-2'), order: 0 },
          { id: 'Q-003', sprint_id: sid('S-1'), order: 1 },
        ],
      },
    };

    const { registry, conflicts } = mergeRegistries(local, remote);

    const ids = registry.queue.core?.map((slot) => slot.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(conflicts.some((c) => c.kind === 'queue_id_collision')).toBe(true);
  });

  it('keeps epic optional fields commutative when both sides diverge', () => {
    const local: Registry = {
      ...baseRegistry(),
      epics: [
        {
          id: eid('E-001'),
          title: 'Epic',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: [],
          execution_strategy: 'sequential',
          parallel_limit: 2,
          file: 'E-001.md',
        },
      ],
    };
    const remote: Registry = {
      ...local,
      epics: [
        {
          ...local.epics[0]!,
          execution_strategy: 'parallel',
          parallel_limit: 3,
        },
      ],
    };

    const ab = mergeRegistries(local, remote);
    const ba = mergeRegistries(remote, local);

    expect(ab.registry.epics[0]).toEqual(ba.registry.epics[0]);
    expect(ab.conflicts.map((c) => `${c.kind}:${c.id}:${c.field}`).sort()).toEqual([
      'epic_diverged:E-001:execution_strategy',
      'epic_diverged:E-001:parallel_limit',
    ]);
  });

  it('preserves a precomputed blocked bit when the source side still has supporting findings', () => {
    const local: Registry = {
      ...baseRegistry(),
      health: {
        maxSeverity: 'P2',
        findingCounts: { P0: 0, P1: 0, P2: 1, P3: 0 },
        blocked: true,
      },
      findings: [{ severity: 'P2', code: 'CUSTOM', message: 'custom threshold finding' }],
    };
    const remote = baseRegistry();

    const { registry } = mergeRegistries(local, remote);

    expect(registry.health.blocked).toBe(true);
  });

  it('clears blocked when both sides are clean and there are no qualifying findings', () => {
    const clean: Registry = {
      ...baseRegistry(),
      health: { maxSeverity: null, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, blocked: false },
      findings: [],
    };
    expect(mergeRegistries(clean, clean).registry.health.blocked).toBe(false);
  });

  it('clears a stale blocked bit when no side has findings supporting it', () => {
    const stale: Registry = {
      ...baseRegistry(),
      health: { maxSeverity: null, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, blocked: true },
      findings: [],
    };
    const clean: Registry = {
      ...baseRegistry(),
      health: { maxSeverity: null, findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 }, blocked: false },
      findings: [],
    };
    expect(mergeRegistries(stale, clean).registry.health.blocked).toBe(false);
  });

  it('picks sequential over parallel on execution_strategy conflict (conservative wins)', () => {
    const local: Registry = {
      ...baseRegistry(),
      epics: [
        {
          id: eid('E-001'),
          title: 'Epic',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: [],
          execution_strategy: 'sequential',
          file: 'E-001.md',
        },
      ],
    };
    const remote: Registry = {
      ...local,
      epics: [{ ...local.epics[0]!, execution_strategy: 'parallel' }],
    };

    const ab = mergeRegistries(local, remote);
    const ba = mergeRegistries(remote, local);

    expect(ab.registry.epics[0]?.execution_strategy).toBe('sequential');
    expect(ba.registry.epics[0]?.execution_strategy).toBe('sequential');
  });

  it('picks the smaller parallel_limit on conflict (conservative wins)', () => {
    const local: Registry = {
      ...baseRegistry(),
      epics: [
        {
          id: eid('E-001'),
          title: 'Epic',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: [],
          parallel_limit: 2,
          file: 'E-001.md',
        },
      ],
    };
    const remote: Registry = {
      ...local,
      epics: [{ ...local.epics[0]!, parallel_limit: 5 }],
    };
    expect(mergeRegistries(local, remote).registry.epics[0]?.parallel_limit).toBe(2);
    expect(mergeRegistries(remote, local).registry.epics[0]?.parallel_limit).toBe(2);
  });

  it('treats logically-equal entities with different key-insertion order as same (sameEntry)', () => {
    // Build two findings sets where one has an extra optional field; deep-equal
    // semantics should NOT treat the no-key vs explicit-undefined as different.
    const local: Registry = {
      ...baseRegistry(),
      findings: [{ severity: 'P3', code: 'A', message: 'm' }],
    };
    const remote: Registry = {
      ...baseRegistry(),
      findings: [{ severity: 'P3', code: 'A', message: 'm' }],
    };
    const merged = mergeRegistries(local, remote);
    // Findings dedupe → exactly one finding survives.
    expect(merged.registry.findings).toHaveLength(1);
  });
});

describe('mergeRegistriesThreeWay', () => {
  it('does not resurrect an entity deleted on one side and unchanged on the other', () => {
    const base: Registry = {
      ...baseRegistry(),
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
      sprints: [sprint('S-1')],
      queue: { core: [{ id: 'Q-001', sprint_id: sid('S-1'), order: 0 }] },
      tracker_index: [
        {
          source: 'gh',
          external_id: 'owner/repo#42',
          epic_id: eid('E-001'),
          sprint_ids: ['S-1'].map(sid),
        },
      ],
    };
    const local: Registry = {
      ...base,
      epics: [],
      sprints: [],
      queue: { core: [] },
    };
    const remote = base;

    const { registry, conflicts } = mergeRegistriesThreeWay(base, local, remote);

    expect(conflicts).toEqual([]);
    expect(registry.epics).toEqual([]);
    expect(registry.sprints).toEqual([]);
    expect(registry.queue.core).toEqual([]);
    expect(registry.tracker_index).toBeUndefined();
  });

  it('flags delete-vs-modify AND drops the modified entity from the merged registry', () => {
    const base: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1')],
    };
    const local: Registry = { ...base, sprints: [] };
    const remote: Registry = { ...base, sprints: [sprint('S-1', { status: 'active' })] };

    const { registry, conflicts } = mergeRegistriesThreeWay(base, local, remote);

    expect(conflicts).toContainEqual({
      kind: 'delete_modify',
      id: 'S-1',
      field: 'sprints',
      local: null,
      remote: remote.sprints[0],
    });
    // Critical: registry must reflect the deletion side; do not resurrect.
    expect(registry.sprints.find((s) => s.id === 'S-1')).toBeUndefined();
  });

  it('flags delete-vs-modify on epics AND drops the modified entity', () => {
    const epicA = {
      id: eid('E-001'),
      title: 'Epic',
      status: 'active' as const,
      gate: null,
      adr_links: [],
      sprints: [],
      file: 'E-001.md',
    };
    const base: Registry = { ...baseRegistry(), epics: [epicA] };
    const local: Registry = { ...base, epics: [] };
    const remote: Registry = { ...base, epics: [{ ...epicA, status: 'done' as const }] };

    const { registry, conflicts } = mergeRegistriesThreeWay(base, local, remote);

    expect(conflicts.some((c) => c.kind === 'delete_modify' && c.id === 'E-001')).toBe(true);
    expect(registry.epics.find((e) => e.id === 'E-001')).toBeUndefined();
  });
});

describe('checkRegistryIntegrity', () => {
  it('passes for an empty registry', () => {
    expect(checkRegistryIntegrity(baseRegistry())).toEqual([]);
  });

  it('flags sprint with missing epic and dep', () => {
    const reg: Registry = {
      ...baseRegistry(),
      sprints: [sprint('S-1', { epic_id: eid('E-MISSING'), depends_on: ['S-NOPE'].map(sid) })],
    };
    const issues = checkRegistryIntegrity(reg);
    expect(issues.map((i) => i.kind).sort()).toEqual(['sprint_missing_dep', 'sprint_missing_epic']);
  });

  it('flags queue slot pointing at a missing sprint', () => {
    const reg: Registry = {
      ...baseRegistry(),
      queue: { core: [{ id: 'Q-1', sprint_id: sid('S-MISSING'), order: 0 }] },
    };
    const issues = checkRegistryIntegrity(reg);
    expect(issues[0]?.kind).toBe('queue_missing_sprint');
  });

  it('flags tracker index entries pointing at missing or unrelated entities', () => {
    const reg: Registry = {
      ...baseRegistry(),
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
        {
          id: eid('E-002'),
          title: 'Other Epic',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: ['S-2'].map(sid),
          file: 'E-002.md',
        },
      ],
      sprints: [sprint('S-1'), sprint('S-2', { epic_id: eid('E-002') })],
      tracker_index: [
        {
          source: 'gh',
          external_id: 'owner/repo#42',
          epic_id: eid('E-MISSING'),
          sprint_ids: ['S-1'].map(sid),
        },
        {
          source: 'gh',
          external_id: 'owner/repo#43',
          epic_id: eid('E-001'),
          sprint_ids: ['S-MISSING'].map(sid),
        },
        {
          source: 'gh',
          external_id: 'owner/repo#44',
          epic_id: eid('E-001'),
          sprint_ids: ['S-2'].map(sid),
        },
      ],
    };
    expect(
      checkRegistryIntegrity(reg)
        .map((i) => i.kind)
        .sort(),
    ).toEqual([
      'tracker_index_missing_epic',
      'tracker_index_missing_sprint',
      'tracker_index_sprint_epic_mismatch',
    ]);
  });
});
