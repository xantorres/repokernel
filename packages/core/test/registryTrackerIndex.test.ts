import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  type Config,
  ConfigSchema,
  type Epic,
  EpicFrontmatterSchema,
  generateRegistry,
  mergeRegistries,
  type ParsedProject,
  type Registry,
  RegistrySchema,
  type Sprint,
  SprintFrontmatterSchema,
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

function epicWithExtras(id: string, sprints: string[], extras: Record<string, unknown>): Epic {
  const front = EpicFrontmatterSchema.parse({
    id,
    title: `Epic ${id}`,
    status: 'planned',
    adr_links: [],
    sprints,
    extras,
  });
  return { ...front, file: `epics/${id}.md`, body: '' };
}

function sprintFor(id: string, epicId: string): Sprint {
  const front = SprintFrontmatterSchema.parse({
    id,
    title: `Sprint ${id}`,
    epic_id: epicId,
    status: 'planned',
    lane: 'main',
  });
  return { ...front, file: `sprints/${id}.md`, body: '' };
}

function projectFrom(epics: Epic[], sprints: Sprint[]): ParsedProject {
  return {
    sprints,
    epics,
    reviews: [],
    queues: [],
    lanes: [],
    nextMd: null,
    findings: [],
  };
}

function generate(project: ParsedProject): Registry {
  return generateRegistry({
    graph: buildGraph(project),
    config: CONFIG,
    findings: [],
    now: () => '2026-05-09T10:00:00.000Z',
  });
}

describe('REGISTRY_SCHEMA_VERSION bump', () => {
  it('emits version 3 for newly generated registries', () => {
    const reg = generate(projectFrom([], []));
    expect(reg.schemaVersion).toBe(3);
  });

  it('accepts a v2 registry and normalizes it to the current version', () => {
    const reg = generate(projectFrom([], []));
    const v2 = { ...reg, schemaVersion: 2 };
    expect(RegistrySchema.parse(v2).schemaVersion).toBe(3);
  });
});

describe('generateRegistry tracker_index projection', () => {
  it('omits the field when no epic carries tracker extras', () => {
    const reg = generate(projectFrom([], []));
    expect(reg.tracker_index).toBeUndefined();
  });

  it('emits an entry for an epic with tracker_source + external_id', () => {
    const epic = epicWithExtras('E-001', ['S-001'], {
      external_id: 'owner/repo#42',
      tracker_source: 'gh',
      tracker_url: 'https://github.com/owner/repo/issues/42',
    });
    const sprint = sprintFor('S-001', 'E-001');
    const reg = generate(projectFrom([epic], [sprint]));
    expect(reg.tracker_index).toEqual([
      {
        source: 'gh',
        external_id: 'owner/repo#42',
        epic_id: 'E-001',
        sprint_ids: ['S-001'],
      },
    ]);
  });

  it('skips epics with partial tracker metadata (no tracker_source)', () => {
    const epic = epicWithExtras('E-001', [], {
      external_id: 'owner/repo#42',
    });
    const reg = generate(projectFrom([epic], []));
    expect(reg.tracker_index).toBeUndefined();
  });

  it('skips epics whose tracker_source is not a known provider', () => {
    const epic = epicWithExtras('E-001', [], {
      external_id: 'whatever',
      tracker_source: 'asana',
    });
    const reg = generate(projectFrom([epic], []));
    expect(reg.tracker_index).toBeUndefined();
  });

  it('skips epics with empty external_id', () => {
    const epic = epicWithExtras('E-001', [], {
      external_id: '',
      tracker_source: 'gh',
    });
    const reg = generate(projectFrom([epic], []));
    expect(reg.tracker_index).toBeUndefined();
  });

  it('sorts entries by `<source>:<external_id>` for canonical output', () => {
    const epicA = epicWithExtras('E-001', [], {
      external_id: 'KEY-2',
      tracker_source: 'jira',
    });
    const epicB = epicWithExtras('E-002', [], {
      external_id: 'owner/repo#1',
      tracker_source: 'gh',
    });
    const reg = generate(projectFrom([epicA, epicB], []));
    const keys = (reg.tracker_index ?? []).map((e) => `${e.source}:${e.external_id}`);
    expect(keys).toEqual(['gh:owner/repo#1', 'jira:KEY-2']);
  });

  it('derives sprint_ids from sprintsByEpic and sorts them', () => {
    const epic = epicWithExtras('E-001', ['S-002', 'S-001'], {
      external_id: 'owner/repo#42',
      tracker_source: 'gh',
    });
    const sprints = [sprintFor('S-001', 'E-001'), sprintFor('S-002', 'E-001')];
    const reg = generate(projectFrom([epic], sprints));
    expect(reg.tracker_index?.[0]?.sprint_ids).toEqual(['S-001', 'S-002']);
  });
});

describe('mergeRegistries — tracker_index union', () => {
  it('keeps undefined when both sides omit tracker_index', () => {
    const reg = generate(projectFrom([], []));
    const result = mergeRegistries(reg, reg);
    expect(result.registry.tracker_index).toBeUndefined();
  });

  it('preserves an entry present on only one side', () => {
    const empty = generate(projectFrom([], []));
    const epic = epicWithExtras('E-001', [], {
      external_id: 'owner/repo#42',
      tracker_source: 'gh',
    });
    const populated = generate(projectFrom([epic], []));
    const merged = mergeRegistries(empty, populated).registry;
    expect(merged.tracker_index).toHaveLength(1);
    expect(merged.tracker_index?.[0]?.external_id).toBe('owner/repo#42');
  });

  it('unions the same key from both sides and sorts deterministically', () => {
    const epicA = epicWithExtras('E-001', ['S-001'], {
      external_id: 'owner/repo#42',
      tracker_source: 'gh',
    });
    const epicB = epicWithExtras('E-002', [], {
      external_id: 'owner/repo#43',
      tracker_source: 'gh',
    });
    const left = generate(projectFrom([epicA], [sprintFor('S-001', 'E-001')]));
    const right = generate(projectFrom([epicB], []));
    const a = mergeRegistries(left, right).registry;
    const b = mergeRegistries(right, left).registry;
    expect(a.tracker_index).toEqual(b.tracker_index);
    expect((a.tracker_index ?? []).map((e) => e.external_id)).toEqual([
      'owner/repo#42',
      'owner/repo#43',
    ]);
  });

  it('surfaces same-ticket/different-epic collisions instead of unioning ownership', () => {
    const epicA = epicWithExtras('E-001', ['S-001'], {
      external_id: 'owner/repo#42',
      tracker_source: 'gh',
    });
    const epicB = epicWithExtras('E-009', ['S-009'], {
      external_id: 'owner/repo#42',
      tracker_source: 'gh',
    });
    const left = generate(projectFrom([epicA], [sprintFor('S-001', 'E-001')]));
    const right = generate(projectFrom([epicB], [sprintFor('S-009', 'E-009')]));
    const { registry: merged, conflicts } = mergeRegistries(left, right);
    const entry = merged.tracker_index?.[0];
    expect(conflicts).toContainEqual({
      kind: 'tracker_index_collision',
      id: 'gh:owner/repo#42',
      field: 'tracker_index',
      local: left.tracker_index?.[0],
      remote: right.tracker_index?.[0],
    });
    expect(entry?.epic_id).toBe('E-001');
    expect(entry?.sprint_ids).toEqual(['S-001']);
  });
});
