import { describe, expect, it } from 'vitest';
import { buildGraph, findCycles, type ParsedProject } from '../src/index.js';

function parsed(overrides: Partial<ParsedProject>): ParsedProject {
  return {
    sprints: [],
    epics: [],
    reviews: [],
    queues: [],
    lanes: [],
    nextMd: null,
    findings: [],
    ...overrides,
  };
}

function sprint(
  id: string,
  epic: string,
  opts: Partial<{ depends_on: string[]; status: string; lane: string }> = {},
) {
  return {
    id,
    title: id,
    epic_id: epic,
    status: (opts.status ?? 'planned') as
      | 'planned'
      | 'pending'
      | 'queued'
      | 'active'
      | 'review'
      | 'shipped'
      | 'reopened'
      | 'cancelled',
    lane: opts.lane ?? 'main',
    depends_on: opts.depends_on ?? [],
    blocked_by: [],
    allowed_paths: [],
    denied_paths: [],
    generated_paths: [],
    review_required: true,
    schema_version: 1,
    adr_links: [],
    extras: {},
    file: `sprints/${id}.md`,
    body: '',
  };
}

describe('buildGraph', () => {
  it('maps sprints by id', () => {
    const g = buildGraph(parsed({ sprints: [sprint('S-001', 'E-001')] }));
    expect(g.sprints.get('S-001')?.id).toBe('S-001');
  });

  it('keeps the first entity when duplicate sprint IDs are present', () => {
    const g = buildGraph(
      parsed({
        sprints: [
          sprint('S-001', 'E-001', { depends_on: ['S-000'] }),
          sprint('S-001', 'E-002', { depends_on: ['S-999'] }),
        ],
      }),
    );
    expect(g.sprints.get('S-001')?.epic_id).toBe('E-001');
    expect(g.dependsOn.get('S-001')).toEqual(['S-000']);
  });

  it('builds epicsBySprint from both directions', () => {
    const g = buildGraph(
      parsed({
        epics: [
          {
            id: 'E-001',
            title: 't',
            status: 'active',
            adr_links: [],
            sprints: ['S-001'],
            extras: {},
            file: 'epics/E-001.md',
            body: '',
          },
        ],
        sprints: [sprint('S-001', 'E-001')],
      }),
    );
    expect(g.epicsBySprint.get('S-001')).toEqual(['E-001']);
    expect(g.sprintsByEpic.get('E-001')).toEqual(['S-001']);
  });

  it('detects multi-epic sprint when both epics list it', () => {
    const g = buildGraph(
      parsed({
        epics: [
          {
            id: 'E-001',
            title: 'a',
            status: 'active',
            adr_links: [],
            sprints: ['S-001'],
            extras: {},
            file: 'epics/E-001.md',
            body: '',
          },
          {
            id: 'E-002',
            title: 'b',
            status: 'active',
            adr_links: [],
            sprints: ['S-001'],
            extras: {},
            file: 'epics/E-002.md',
            body: '',
          },
        ],
        sprints: [sprint('S-001', 'E-001')],
      }),
    );
    expect(g.epicsBySprint.get('S-001')).toEqual(['E-001', 'E-002']);
  });

  it('infers lanes from sprints/queues when no lane files', () => {
    const g = buildGraph(
      parsed({
        sprints: [sprint('S-001', 'E-001', { lane: 'core' })],
        queues: [
          {
            lane: 'platform',
            slots: [],
            schema_version: 1,
            file: 'queues/platform.md',
            body: '',
          },
        ],
      }),
    );
    expect(g.lanes.get('core')?.inferred).toBe(true);
    expect(g.lanes.get('platform')?.inferred).toBe(true);
  });

  it('orders queue slots deterministically by order then id', () => {
    const g = buildGraph(
      parsed({
        queues: [
          {
            lane: 'main',
            slots: [
              { id: 'Q-002', sprint_id: 'S-002', order: 1 },
              { id: 'Q-001', sprint_id: 'S-001', order: 0 },
              { id: 'Q-003', sprint_id: 'S-003', order: 1 },
            ],
            schema_version: 1,
            file: 'queues/main.md',
            body: '',
          },
        ],
      }),
    );
    const slots = g.queuesByLane.get('main') ?? [];
    expect(slots.map((s) => s.id)).toEqual(['Q-001', 'Q-002', 'Q-003']);
  });

  it('aggregates duplicate lane queue files before validators report them', () => {
    const g = buildGraph(
      parsed({
        queues: [
          {
            lane: 'main',
            slots: [{ id: 'Q-002', sprint_id: 'S-002', order: 1 }],
            schema_version: 1,
            file: 'queues/main-a.md',
            body: '',
          },
          {
            lane: 'main',
            slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
            schema_version: 1,
            file: 'queues/main-b.md',
            body: '',
          },
        ],
      }),
    );
    const slots = g.queuesByLane.get('main') ?? [];
    expect(slots.map((s) => s.id)).toEqual(['Q-001', 'Q-002']);
  });
});

describe('buildGraph immutability', () => {
  it('dependsOn arrays are frozen', () => {
    const g = buildGraph(
      parsed({ sprints: [sprint('S-001', 'E-001', { depends_on: ['S-002'] })] }),
    );
    const arr = g.dependsOn.get('S-001') as string[];
    expect(() => arr.push('S-999')).toThrow();
  });

  it('queuesByLane arrays are frozen', () => {
    const g = buildGraph(
      parsed({
        queues: [
          {
            lane: 'main',
            slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
            schema_version: 1,
            file: 'queues/main.md',
            body: '',
          },
        ],
      }),
    );
    const slots = g.queuesByLane.get('main') as object[];
    expect(() => slots.push({ id: 'Q-999', sprint_id: 'S-999', order: 99 })).toThrow();
  });

  it('lanes objects are frozen', () => {
    const g = buildGraph(parsed({ sprints: [sprint('S-001', 'E-001', { lane: 'core' })] }));
    const lane = g.lanes.get('core') as unknown as Record<string, unknown>;
    expect(() => {
      lane.inferred = false;
    }).toThrow();
  });
});

describe('findCycles', () => {
  it('finds no cycles in a DAG', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['C']],
      ['C', []],
    ]);
    expect(findCycles(adj)).toEqual([]);
  });

  it('finds a 2-node cycle', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    expect(findCycles(adj)).toEqual([{ nodes: ['A', 'B'] }]);
  });

  it('finds self-loop', () => {
    const adj = new Map<string, string[]>([['A', ['A']]]);
    expect(findCycles(adj)).toEqual([{ nodes: ['A'] }]);
  });

  it('finds multiple SCCs', () => {
    const adj = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']],
      ['C', ['D']],
      ['D', ['C']],
    ]);
    expect(findCycles(adj)).toEqual([{ nodes: ['A', 'B'] }, { nodes: ['C', 'D'] }]);
  });
});
