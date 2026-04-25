import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  canonicalJson,
  ConfigSchema,
  compareRegistries,
  generateRegistry,
  RegistrySchema,
  stripVolatile,
  type Config,
  type ParsedProject,
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

const empty: ParsedProject = {
  sprints: [],
  epics: [],
  reviews: [],
  queues: [],
  lanes: [],
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
    expect(reg.schemaVersion).toBe(1);
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
