import { describe, expect, it } from 'vitest';
import { type Finding, FindingSummarySchema, summarizeFindings } from '../src/index.js';

function finding(severity: Finding['severity']): Finding {
  return { severity, code: 'PARSE_ERROR', message: 'test' } as Finding;
}

describe('summarizeFindings', () => {
  it('returns an empty summary for no findings', () => {
    const summary = summarizeFindings([]);
    expect(summary).toEqual({
      maxSeverity: null,
      findingCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
      total: 0,
    });
    expect(FindingSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('counts per severity and tracks the most severe', () => {
    const summary = summarizeFindings([finding('P2'), finding('P0'), finding('P2'), finding('P3')]);
    expect(summary.findingCounts).toEqual({ P0: 1, P1: 0, P2: 2, P3: 1 });
    expect(summary.maxSeverity).toBe('P0');
    expect(summary.total).toBe(4);
    expect(FindingSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('reports the highest severity when no P0 is present', () => {
    expect(summarizeFindings([finding('P2'), finding('P1')]).maxSeverity).toBe('P1');
  });
});
