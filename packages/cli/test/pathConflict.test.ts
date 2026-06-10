import type { Sprint } from '@repokernel/core';
import { describe, expect, it } from 'vitest';
import { detectPathConflicts } from '../src/lifecycle/pathConflict.js';
import { sid } from './helpers/brand.js';

function sprint(id: string, allowed_paths: string[]): Sprint {
  return {
    id: sid(id),
    title: id,
    epic_id: 'E-001',
    status: 'queued',
    lane: 'main',
    depends_on: [],
    blocked_by: [],
    allowed_paths,
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

describe('detectPathConflicts', () => {
  it('no conflict when sprints have disjoint roots', () => {
    const result = detectPathConflicts([sprint('S-001', ['src/**']), sprint('S-002', ['lib/**'])]);
    expect(result.hasConflicts).toBe(false);
    expect(result.definiteConflicts).toHaveLength(0);
    expect(result.unknownRiskPairs).toHaveLength(0);
  });

  it('exact literal path overlap → definiteConflict', () => {
    const result = detectPathConflicts([
      sprint('S-001', ['src/utils.ts']),
      sprint('S-002', ['src/utils.ts']),
    ]);
    expect(result.hasConflicts).toBe(true);
    expect(result.definiteConflicts).toHaveLength(1);
    expect(result.definiteConflicts[0]!.sprint1).toBe('S-001');
    expect(result.definiteConflicts[0]!.sprint2).toBe('S-002');
  });

  it('parent glob covers child glob → definiteConflict', () => {
    // src/** covers src/utils/**
    const result = detectPathConflicts([
      sprint('S-001', ['src/**']),
      sprint('S-002', ['src/utils/**']),
    ]);
    expect(result.hasConflicts).toBe(true);
    expect(result.definiteConflicts).toHaveLength(1);
    expect(result.definiteConflicts[0]!.overlappingGlobs[0]).toContain('src/**');
  });

  it('parent glob covers child literal → definiteConflict', () => {
    const result = detectPathConflicts([
      sprint('S-001', ['src/**']),
      sprint('S-002', ['src/foo.ts']),
    ]);
    expect(result.hasConflicts).toBe(true);
    expect(result.definiteConflicts).toHaveLength(1);
  });

  it('literal parent contains literal child → definiteConflict', () => {
    // "src" is parent of "src/foo.ts" — actually treated as literal vs literal
    const result = detectPathConflicts([sprint('S-001', ['src']), sprint('S-002', ['src/foo.ts'])]);
    expect(result.hasConflicts).toBe(true);
    expect(result.definiteConflicts).toHaveLength(1);
  });

  it('deeply nested prefix: packages/core/src/** vs packages/core/src/parser/**', () => {
    const result = detectPathConflicts([
      sprint('S-001', ['packages/core/src/**']),
      sprint('S-002', ['packages/core/src/parser/**']),
    ]);
    expect(result.hasConflicts).toBe(true);
    expect(result.definiteConflicts).toHaveLength(1);
  });

  it('wildcard-wildcard with common prefix → unknownRisk', () => {
    // packages/*/src/** vs packages/core/** — complex overlap, unknown
    const result = detectPathConflicts([
      sprint('S-001', ['packages/*/src/**']),
      sprint('S-002', ['packages/core/**']),
    ]);
    // static prefix of S-001 is "packages", static prefix of S-002 is "packages/core"
    // both have wildcards → unknownRisk
    expect(result.hasConflicts).toBe(true);
    expect(result.unknownRiskPairs).toHaveLength(1);
    expect(result.unknownRiskPairs[0]!.reason).toBe('complex_globs');
  });

  it('sprint with no allowed_paths → unknownRisk (could touch anything)', () => {
    const result = detectPathConflicts([sprint('S-001', []), sprint('S-002', ['src/**'])]);
    expect(result.hasConflicts).toBe(true);
    expect(result.unknownRiskPairs).toHaveLength(1);
  });

  it('both sprints no allowed_paths → unknownRisk', () => {
    const result = detectPathConflicts([sprint('S-001', []), sprint('S-002', [])]);
    expect(result.hasConflicts).toBe(true);
    expect(result.unknownRiskPairs).toHaveLength(1);
  });

  it('trailing slashes normalized — src/utils/ same as src/utils', () => {
    const result = detectPathConflicts([
      sprint('S-001', ['src/utils/']),
      sprint('S-002', ['src/utils/foo.ts']),
    ]);
    expect(result.hasConflicts).toBe(true);
    expect(result.definiteConflicts).toHaveLength(1);
  });

  it('multiple globs per sprint — detects conflict in overlapping pair', () => {
    const result = detectPathConflicts([
      sprint('S-001', ['lib/**', 'src/parser/**']),
      sprint('S-002', ['test/**', 'src/parser/utils.ts']),
    ]);
    expect(result.hasConflicts).toBe(true);
    // lib/** vs test/** = no, lib/** vs src/parser/utils.ts = no
    // src/parser/** vs test/** = no, src/parser/** vs src/parser/utils.ts = yes
    expect(result.definiteConflicts).toHaveLength(1);
    expect(result.definiteConflicts[0]!.overlappingGlobs[0]).toContain('src/parser/**');
  });

  it('three sprints — reports all conflicting pairs', () => {
    const result = detectPathConflicts([
      sprint('S-001', ['src/**']),
      sprint('S-002', ['src/parser/**']),
      sprint('S-003', ['lib/**']),
    ]);
    // S-001 vs S-002: conflict; S-001 vs S-003: none; S-002 vs S-003: none
    expect(result.definiteConflicts).toHaveLength(1);
    expect(result.definiteConflicts[0]!.sprint1).toBe('S-001');
    expect(result.definiteConflicts[0]!.sprint2).toBe('S-002');
  });

  it('completely disjoint paths at root level → no conflict', () => {
    const result = detectPathConflicts([
      sprint('S-001', ['apps/web/**']),
      sprint('S-002', ['packages/core/**']),
      sprint('S-003', ['packages/cli/**']),
    ]);
    expect(result.hasConflicts).toBe(false);
  });

  it('single sprint → no conflict (nothing to compare)', () => {
    const result = detectPathConflicts([sprint('S-001', ['src/**'])]);
    expect(result.hasConflicts).toBe(false);
  });

  it('empty sprint list → no conflict', () => {
    const result = detectPathConflicts([]);
    expect(result.hasConflicts).toBe(false);
  });
});
