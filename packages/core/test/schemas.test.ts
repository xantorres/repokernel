import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import {
  ContextImplementPacketSchema,
  ContextReviewPacketSchema,
  ContextWavePacketSchema,
  compareFindings,
  contextPacketJsonSchema,
  EpicFrontmatterSchema,
  FindingSchema,
  LaneFrontmatterSchema,
  meetsThreshold,
  QueueFrontmatterSchema,
  ReviewFrontmatterSchema,
  RunSchema,
  SprintFrontmatterSchema,
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

describe('ContextPacketSchema', () => {
  const implementPacket = {
    profile: 'implement',
    target: 'S-1',
    capsule: {
      id: 'S-1',
      status: 'queued',
      lane: 'main',
      objective: 'Do the thing',
      epic_id: 'E-1',
      epic_title: 'Epic',
      allowed_paths: ['src/**'],
      denied_paths: ['src/secrets/**'],
      deps: [],
      blockers: [],
      review_required: true,
      minimal_commands: ['rk inspect S-1'],
    },
    findings: [],
    related_sprints: [],
    scoped_manifest: { files: ['src/index.ts'], omitted_count: 0, available: true },
    omissions: [],
    estimated_tokens: 10,
    effective_budget: 100,
  };

  it('reuses core path/SHA/status invariants', () => {
    expect(() =>
      ContextImplementPacketSchema.parse({
        ...implementPacket,
        capsule: { ...implementPacket.capsule, allowed_paths: ['../secret/**'] },
      }),
    ).toThrow();
    expect(() =>
      ContextReviewPacketSchema.parse({
        profile: 'review',
        target: 'S-1',
        capsule: {
          id: 'S-1',
          sprint_status: 'review',
          review_id: 'R-1',
          verdict: 'pending',
          base_sha: 'not-a-sha',
          end_sha: 'abcdef0',
          acceptance: 'ok',
          changed_files: [],
          changed_files_source: 'git_diff',
          changed_files_omitted: 0,
          verification_commands: [],
        },
        review_findings: [],
        omissions: [],
        estimated_tokens: 1,
        effective_budget: 10,
      }),
    ).toThrow();
    expect(() =>
      ContextWavePacketSchema.parse({
        profile: 'wave',
        target: 'E-1',
        capsule: {
          id: 'E-1',
          title: 'Epic',
          status: 'almost_done',
          runnable: [],
          blocked: [],
          gated: [],
          planned: [],
          parallel_safe: [],
          parallel_safe_omitted: 0,
          minimal_commands: [],
        },
        findings: [],
        omissions: [],
        estimated_tokens: 1,
        effective_budget: 10,
      }),
    ).toThrow();
  });

  it('exports a nested JSON Schema contract for each profile', () => {
    const ajv = new Ajv({ strict: false });
    const implementValidate = ajv.compile(contextPacketJsonSchema('implement'));
    expect(implementValidate(implementPacket)).toBe(true);
    expect(
      implementValidate({
        ...implementPacket,
        capsule: { ...implementPacket.capsule, allowed_paths: ['src/**'], deps: [{}] },
      }),
    ).toBe(false);

    for (const profile of ['review', 'wave'] as const) {
      const schema = contextPacketJsonSchema(profile);
      expect(schema).toMatchObject({
        $id: `https://repokernel.dev/schemas/context-packet/${profile}.json`,
      });
      expect(JSON.stringify(schema)).toContain('"capsule"');
      expect(JSON.stringify(schema)).toContain('"additionalProperties":false');
    }
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
    expect(() => SprintFrontmatterSchema.parse({ ...valid, base_sha: 'a1b2c3d' })).not.toThrow();
  });

  it('accepts null lifecycle template fields as unset', () => {
    const parsed = SprintFrontmatterSchema.parse({
      ...valid,
      review_id: null,
      started_at: null,
      closed_at: null,
      base_sha: null,
      end_sha: null,
    });
    expect(parsed.review_id).toBeUndefined();
    expect(parsed.started_at).toBeUndefined();
    expect(parsed.closed_at).toBeUndefined();
    expect(parsed.base_sha).toBeUndefined();
    expect(parsed.end_sha).toBeUndefined();
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
    expect(() =>
      EpicFrontmatterSchema.parse({ id: 'EPIC-1', title: 't', status: 'active' }),
    ).toThrow();
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

  it('accepts populated extras without error', () => {
    const parsed = ReviewFrontmatterSchema.parse({
      id: 'R-001',
      sprint_id: 'S-001',
      verdict: 'accepted',
      reviewer: 'agent-a',
      created_at: '2026-04-25T10:00:00Z',
      extras: {
        reviewers_run: ['agent-a', 'agent-b'],
        iterations: 2,
        cost_usd: 1.23,
        grandfathered: false,
        reviewed: '2026-04-25T10:00:00Z',
        reviewer_count: 2,
      },
    });
    expect(parsed.extras).toMatchObject({ cost_usd: 1.23, iterations: 2 });
  });

  it('extras defaults to {} when absent', () => {
    const parsed = ReviewFrontmatterSchema.parse({
      id: 'R-001',
      sprint_id: 'S-001',
      verdict: 'accepted',
      reviewer: 'agent-a',
      created_at: '2026-04-25T10:00:00Z',
    });
    expect(parsed.extras).toEqual({});
  });

  it('rejects unknown top-level fields even with extras present', () => {
    expect(() =>
      ReviewFrontmatterSchema.parse({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'accepted',
        reviewer: 'x',
        created_at: '2026-04-25T10:00:00Z',
        extras: {},
        not_a_real_field: true,
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
    expect(() => QueueFrontmatterSchema.parse({ lane: 'main', slots: [], extra: true })).toThrow();
  });
});

describe('RunSchema.agent', () => {
  const base = {
    id: 'RUN-001',
    epic_id: 'E-001',
    lane: 'main',
    status: 'running' as const,
    mode: 'assisted' as const,
    worktree: '/tmp/wt',
    branch: 'rk/epic/E-001',
    started_at: '2026-04-26T10:00:00Z',
    ended_at: null,
    current_sprint: null,
    halt_reason: null,
    limit: null,
    sprint_count: 0,
  };

  it('accepts built-in agent names', () => {
    expect(() => RunSchema.parse({ ...base, agent: 'fake' })).not.toThrow();
    expect(() => RunSchema.parse({ ...base, agent: 'manual' })).not.toThrow();
    expect(() => RunSchema.parse({ ...base, agent: 'claude' })).not.toThrow();
  });

  it('accepts experimental agent names', () => {
    expect(() => RunSchema.parse({ ...base, agent: 'codex' })).not.toThrow();
  });

  it('accepts custom agent names defined in config', () => {
    expect(() => RunSchema.parse({ ...base, agent: 'my-custom-agent' })).not.toThrow();
  });

  it('rejects empty agent string', () => {
    expect(() => RunSchema.parse({ ...base, agent: '' })).toThrow();
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

const minimalConfig = {
  schemaVersion: 1 as const,
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
};

describe('ConfigSchema requires:', () => {
  it('parses without requires: (backward compat)', () => {
    expect(() => ConfigSchema.parse(minimalConfig)).not.toThrow();
  });

  it('parses with a valid semver range in requires:', () => {
    const parsed = ConfigSchema.parse({ ...minimalConfig, requires: '>=1.0.0' });
    expect(parsed.requires).toBe('>=1.0.0');
  });

  it('parses with a complex semver range', () => {
    const parsed = ConfigSchema.parse({ ...minimalConfig, requires: '>=1.0.0 <2.0.0' });
    expect(parsed.requires).toBe('>=1.0.0 <2.0.0');
  });

  it('rejects an empty string for requires:', () => {
    expect(() => ConfigSchema.parse({ ...minimalConfig, requires: '' })).toThrow();
  });
});
