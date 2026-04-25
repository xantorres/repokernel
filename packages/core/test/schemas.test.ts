import { describe, expect, it } from 'vitest';
import {
  EpicFrontmatterSchema,
  FindingSchema,
  LaneFrontmatterSchema,
  QueueFrontmatterSchema,
  ReviewFrontmatterSchema,
  SprintFrontmatterSchema,
  compareFindings,
  meetsThreshold,
} from '../src/schemas/index.js';

describe('FindingSchema', () => {
  it('accepts a minimal valid finding', () => {
    expect(() =>
      FindingSchema.parse({ severity: 'P1', code: 'DUPLICATE_SPRINT_ID', message: 'oops' }),
    ).not.toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() =>
      FindingSchema.parse({ severity: 'P1', code: 'X', message: 'm', extra: 1 }),
    ).toThrow();
  });

  it('rejects lowercase code', () => {
    expect(() =>
      FindingSchema.parse({ severity: 'P1', code: 'duplicate', message: 'm' }),
    ).toThrow();
  });
});

describe('compareFindings', () => {
  it('orders by severity, then code, then entityId, then file', () => {
    const findings = [
      { severity: 'P2' as const, code: 'B', message: 'm', entityId: 'S-002' },
      { severity: 'P1' as const, code: 'B', message: 'm', entityId: 'S-002' },
      { severity: 'P1' as const, code: 'A', message: 'm', entityId: 'S-003' },
      { severity: 'P1' as const, code: 'A', message: 'm', entityId: 'S-001' },
    ];
    const sorted = [...findings].sort(compareFindings);
    expect(sorted.map((f) => `${f.severity}:${f.code}:${f.entityId}`)).toEqual([
      'P1:A:S-001',
      'P1:A:S-003',
      'P1:B:S-002',
      'P2:B:S-002',
    ]);
  });
});

describe('meetsThreshold', () => {
  it('treats lower-numbered severities as more severe', () => {
    expect(meetsThreshold('P0', 'P1')).toBe(true);
    expect(meetsThreshold('P1', 'P1')).toBe(true);
    expect(meetsThreshold('P2', 'P1')).toBe(false);
    expect(meetsThreshold('P3', 'P3')).toBe(true);
  });
});

describe('SprintFrontmatterSchema', () => {
  const valid = {
    id: 'S-001',
    title: 'First sprint',
    epic_id: 'E-001',
    status: 'active' as const,
    lane: 'main',
  };

  it('accepts a minimal active sprint and applies defaults', () => {
    const parsed = SprintFrontmatterSchema.parse(valid);
    expect(parsed.depends_on).toEqual([]);
    expect(parsed.review_required).toBe(true);
  });

  it('rejects bad id format', () => {
    expect(() => SprintFrontmatterSchema.parse({ ...valid, id: 'sprint-1' })).toThrow();
  });

  it('rejects unknown frontmatter keys', () => {
    expect(() => SprintFrontmatterSchema.parse({ ...valid, weird: true })).toThrow();
  });

  it('rejects non-canonical status', () => {
    expect(() => SprintFrontmatterSchema.parse({ ...valid, status: 'shipped_oops' })).toThrow();
  });

  it('accepts started_at when ISO datetime', () => {
    expect(() =>
      SprintFrontmatterSchema.parse({ ...valid, started_at: '2026-04-25T10:00:00Z' }),
    ).not.toThrow();
  });

  it('rejects bare-date started_at (must be ISO datetime)', () => {
    expect(() => SprintFrontmatterSchema.parse({ ...valid, started_at: '2026-04-25' })).toThrow();
  });

  it('accepts a SHA in base_sha', () => {
    expect(() =>
      SprintFrontmatterSchema.parse({ ...valid, base_sha: 'a1b2c3d' }),
    ).not.toThrow();
  });

  it('rejects an invalid SHA', () => {
    expect(() => SprintFrontmatterSchema.parse({ ...valid, base_sha: 'XYZ' })).toThrow();
  });
});

describe('EpicFrontmatterSchema', () => {
  it('accepts minimal valid epic', () => {
    const parsed = EpicFrontmatterSchema.parse({
      id: 'E-001',
      title: 'Trust',
      status: 'active',
    });
    expect(parsed.sprints).toEqual([]);
    expect(parsed.adr_links).toEqual([]);
  });

  it('rejects bad id', () => {
    expect(() => EpicFrontmatterSchema.parse({ id: 'EPIC-1', title: 't', status: 'active' })).toThrow();
  });
});

describe('ReviewFrontmatterSchema', () => {
  it('accepts a valid review', () => {
    expect(() =>
      ReviewFrontmatterSchema.parse({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'accepted',
        reviewer: 'someone',
        created_at: '2026-04-25T10:00:00Z',
      }),
    ).not.toThrow();
  });

  it('rejects unknown verdict', () => {
    expect(() =>
      ReviewFrontmatterSchema.parse({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'GREEN',
        reviewer: 'x',
        created_at: '2026-04-25T10:00:00Z',
      }),
    ).toThrow();
  });
});

describe('QueueFrontmatterSchema', () => {
  it('accepts an empty queue', () => {
    expect(() => QueueFrontmatterSchema.parse({ lane: 'main' })).not.toThrow();
  });

  it('accepts a populated queue', () => {
    expect(() =>
      QueueFrontmatterSchema.parse({
        lane: 'main',
        slots: [
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          { id: 'Q-002', sprint_id: 'S-002', order: 1 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects negative order', () => {
    expect(() =>
      QueueFrontmatterSchema.parse({
        lane: 'main',
        slots: [{ id: 'Q-001', sprint_id: 'S-001', order: -1 }],
      }),
    ).toThrow();
  });

  it('rejects unknown frontmatter keys', () => {
    expect(() =>
      QueueFrontmatterSchema.parse({ lane: 'main', slots: [], extra: true }),
    ).toThrow();
  });
});

describe('LaneFrontmatterSchema', () => {
  it('accepts an unclaimed lane', () => {
    expect(() => LaneFrontmatterSchema.parse({ name: 'main' })).not.toThrow();
  });

  it('accepts a claimed lane with timestamp', () => {
    expect(() =>
      LaneFrontmatterSchema.parse({
        name: 'main',
        claimed_by: 'agent-a',
        claimed_at: '2026-04-25T10:00:00Z',
      }),
    ).not.toThrow();
  });
});
