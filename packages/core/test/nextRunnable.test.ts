import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  type Config,
  ConfigSchema,
  FINDING_CODES,
  type Finding,
  type ParsedProject,
  resolveNextRunnableSprint,
} from '../src/index.js';

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
  opts: Partial<{
    lane: string;
    status: 'planned' | 'queued' | 'active' | 'shipped' | 'cancelled';
    gate: string;
    depends_on: string[];
    blocked_by: string[];
  }> = {},
) {
  return {
    id,
    title: id,
    epic_id: epic,
    status: opts.status ?? 'queued',
    lane: opts.lane ?? 'main',
    gate: opts.gate,
    depends_on: opts.depends_on ?? [],
    blocked_by: opts.blocked_by ?? [],
    allowed_paths: [],
    denied_paths: [],
    generated_paths: [],
    review_required: true,
    adr_links: [],
    extras: {},
    file: `sprints/${id}.md`,
    body: '',
  };
}

function epic(id: string, sprints: string[]) {
  return {
    id,
    title: id,
    status: 'active' as const,
    adr_links: [],
    sprints,
    extras: {},
    file: `epics/${id}.md`,
    body: '',
  };
}

describe('resolveNextRunnableSprint', () => {
  it('blocks a queued sprint with an unresolved gate instead of running it', () => {
    const graph = buildGraph(
      parsed({
        epics: [epic('E-001', ['S-001'])],
        sprints: [sprint('S-001', 'E-001', { gate: 'human_approval' })],
        queues: [
          {
            lane: 'main',
            slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
            file: 'queues/main.md',
            body: '',
          },
        ],
      }),
    );

    const result = resolveNextRunnableSprint(graph, CONFIG, [], { lane: 'main' });

    expect(result.result).toBe('blocked');
    expect(result.sprintId).toBeNull();
    expect(result.blockers[0]?.code).toBe(FINDING_CODES.SPRINT_GATE_BLOCKED);
  });

  it('does not let a blocking finding from another sprint lane stop this lane', () => {
    const graph = buildGraph(
      parsed({
        epics: [epic('E-001', ['S-001']), epic('E-002', ['S-002'])],
        sprints: [
          sprint('S-001', 'E-001', { lane: 'main' }),
          sprint('S-002', 'E-002', { lane: 'platform' }),
        ],
        queues: [
          {
            lane: 'main',
            slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
            file: 'queues/main.md',
            body: '',
          },
        ],
      }),
    );
    const findings: Finding[] = [
      {
        severity: 'P0',
        code: FINDING_CODES.ACTIVE_SPRINT_MISSING_BASE_SHA,
        message: 'platform sprint is broken',
        entityType: 'sprint',
        entityId: 'S-002',
      },
      {
        severity: 'P1',
        code: FINDING_CODES.MULTIPLE_QUEUE_FILES_FOR_LANE,
        message: 'platform queue has duplicates',
        entityType: 'queue',
        data: { lane: 'platform' },
      },
    ];

    const result = resolveNextRunnableSprint(graph, CONFIG, findings, { lane: 'main' });

    expect(result.result).toBe('runnable');
    expect(result.sprintId).toBe('S-001');
  });

  it('blocks a queued sprint whose blocked_by upstream is not shipped', () => {
    const graph = buildGraph(
      parsed({
        epics: [epic('E-001', ['S-001', 'S-002'])],
        sprints: [
          sprint('S-001', 'E-001', { status: 'queued' }),
          sprint('S-002', 'E-001', { status: 'queued', blocked_by: ['S-001'] }),
        ],
        queues: [
          {
            lane: 'main',
            slots: [{ id: 'Q-002', sprint_id: 'S-002', order: 0 }],
            file: 'queues/main.md',
            body: '',
          },
        ],
      }),
    );

    const result = resolveNextRunnableSprint(graph, CONFIG, [], { lane: 'main' });

    expect(result.result).toBe('blocked');
    expect(result.blockers[0]?.code).toBe(FINDING_CODES.QUEUED_DEPENDENCY_NOT_SHIPPED);
    expect(result.blockers[0]?.message).toContain('S-001');
  });

  it('blocks downstream when an upstream depends_on sprint is cancelled', () => {
    const graph = buildGraph(
      parsed({
        epics: [epic('E-001', ['S-001', 'S-002'])],
        sprints: [
          sprint('S-001', 'E-001', { status: 'cancelled' }),
          sprint('S-002', 'E-001', { status: 'queued', depends_on: ['S-001'] }),
        ],
        queues: [
          {
            lane: 'main',
            slots: [{ id: 'Q-002', sprint_id: 'S-002', order: 0 }],
            file: 'queues/main.md',
            body: '',
          },
        ],
      }),
    );

    const result = resolveNextRunnableSprint(graph, CONFIG, [], { lane: 'main' });

    expect(result.result).toBe('blocked');
    expect(result.blockers[0]?.code).toBe(FINDING_CODES.QUEUED_DEPENDENCY_NOT_SHIPPED);
  });

  it('keeps findings global when their owning sprint cannot be resolved', () => {
    const graph = buildGraph(
      parsed({
        epics: [epic('E-001', ['S-001'])],
        sprints: [sprint('S-001', 'E-001')],
        reviews: [
          {
            id: 'R-001',
            sprint_id: 'S-999',
            verdict: 'pending',
            reviewer: 'agent',
            findings: [],
            command_evidence: [],
            created_at: '2026-04-25T10:00:00Z',
            extras: {},
            file: 'reviews/R-001.md',
            body: '',
          },
        ],
        queues: [
          {
            lane: 'main',
            slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
            file: 'queues/main.md',
            body: '',
          },
        ],
      }),
    );
    const findings: Finding[] = [
      {
        severity: 'P1',
        code: FINDING_CODES.REVIEW_REFERENCES_MISSING_SPRINT,
        message: 'review points at missing sprint',
        entityType: 'review',
        entityId: 'R-001',
      },
    ];

    const result = resolveNextRunnableSprint(graph, CONFIG, findings, { lane: 'main' });

    expect(result.result).toBe('blocked');
    expect(result.blockers[0]?.code).toBe(FINDING_CODES.REVIEW_REFERENCES_MISSING_SPRINT);
  });
});
