import { describe, expect, it } from 'vitest';
import {
  buildSatisfiedSprints,
  gatingDependencies,
  isDependencyMet,
  unmetDependencies,
} from '../src/graph/readiness.js';
import type { Sprint } from '../src/schemas/sprint.js';
import { sid } from './helpers/brand.js';

function sprint(
  id: string,
  opts: {
    status?: Sprint['status'];
    depends_on?: string[];
    blocked_by?: string[];
  } = {},
): Sprint {
  return {
    id: sid(id),
    title: id,
    epic_id: 'E-001',
    status: opts.status ?? 'queued',
    lane: 'main',
    gate: undefined,
    depends_on: (opts.depends_on ?? []).map(sid),
    blocked_by: (opts.blocked_by ?? []).map(sid),
    allowed_paths: [],
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

describe('buildSatisfiedSprints', () => {
  it('includes only shipped sprints', () => {
    const sprints = [
      sprint('S-001', { status: 'shipped' }),
      sprint('S-002', { status: 'queued' }),
      sprint('S-003', { status: 'cancelled' }),
      sprint('S-004', { status: 'active' }),
      sprint('S-005', { status: 'planned' }),
    ];
    const set = buildSatisfiedSprints(sprints);
    expect([...set]).toEqual(['S-001']);
  });

  it('returns empty set when no sprints are shipped', () => {
    const sprints = [
      sprint('S-001', { status: 'queued' }),
      sprint('S-002', { status: 'cancelled' }),
    ];
    expect(buildSatisfiedSprints(sprints).size).toBe(0);
  });

  it('cancelled upstream is NOT satisfied (soft block)', () => {
    const sprints = [sprint('S-001', { status: 'cancelled' })];
    expect(buildSatisfiedSprints(sprints).has(sid('S-001'))).toBe(false);
  });
});

describe('gatingDependencies', () => {
  it('combines depends_on and blocked_by', () => {
    const s = sprint('S-100', { depends_on: ['S-001'], blocked_by: ['S-002'] });
    expect(gatingDependencies(s)).toEqual(['S-001', 'S-002']);
  });

  it('preserves order: depends_on first, blocked_by second', () => {
    const s = sprint('S-100', {
      depends_on: ['S-010', 'S-001'],
      blocked_by: ['S-020', 'S-002'],
    });
    expect(gatingDependencies(s)).toEqual(['S-010', 'S-001', 'S-020', 'S-002']);
  });

  it('returns empty when no edges defined', () => {
    expect(gatingDependencies(sprint('S-100'))).toEqual([]);
  });
});

describe('unmetDependencies', () => {
  it('returns deps absent from satisfied set', () => {
    const s = sprint('S-100', { depends_on: ['S-001', 'S-002'] });
    const satisfied = new Set([sid('S-001')]);
    expect(unmetDependencies(s, satisfied)).toEqual([sid('S-002')]);
  });

  it('returns blocked_by entries that are not satisfied', () => {
    const s = sprint('S-100', { blocked_by: ['S-001'] });
    expect(unmetDependencies(s, new Set())).toEqual(['S-001']);
  });

  it('treats both edge types uniformly', () => {
    const s = sprint('S-100', { depends_on: ['S-001'], blocked_by: ['S-002'] });
    expect(unmetDependencies(s, new Set())).toEqual(['S-001', 'S-002']);
  });

  it('collapses duplicates between depends_on and blocked_by', () => {
    const s = sprint('S-100', { depends_on: ['S-001'], blocked_by: ['S-001'] });
    expect(unmetDependencies(s, new Set())).toEqual(['S-001']);
  });

  it('returns [] when all deps satisfied', () => {
    const s = sprint('S-100', { depends_on: ['S-001'], blocked_by: ['S-002'] });
    const satisfied = new Set([sid('S-001'), sid('S-002')]);
    expect(unmetDependencies(s, satisfied)).toEqual([]);
  });
});

describe('isDependencyMet', () => {
  it('true when all gating deps are satisfied', () => {
    const s = sprint('S-100', { depends_on: ['S-001'], blocked_by: ['S-002'] });
    const satisfied = new Set([sid('S-001'), sid('S-002')]);
    expect(isDependencyMet(s, satisfied)).toBe(true);
  });

  it('false when a depends_on entry is missing from satisfied', () => {
    const s = sprint('S-100', { depends_on: ['S-001'] });
    expect(isDependencyMet(s, new Set())).toBe(false);
  });

  it('false when a blocked_by entry is missing from satisfied', () => {
    const s = sprint('S-100', { blocked_by: ['S-001'] });
    expect(isDependencyMet(s, new Set())).toBe(false);
  });

  it('true when no edges defined', () => {
    expect(isDependencyMet(sprint('S-100'), new Set())).toBe(true);
  });

  it('cancelled upstream → downstream stays blocked (canonical rule)', () => {
    const sprints = [
      sprint('S-001', { status: 'cancelled' }),
      sprint('S-100', { depends_on: ['S-001'] }),
    ];
    const satisfied = buildSatisfiedSprints(sprints);
    expect(isDependencyMet(sprints[1]!, satisfied)).toBe(false);
  });
});
