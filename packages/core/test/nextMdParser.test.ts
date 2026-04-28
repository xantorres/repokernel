import { describe, expect, it } from 'vitest';
import { parseNextMdText } from '../src/next/index.js';
import { FINDING_CODES } from '../src/validator/codes.js';

function next(slotsBody: string, declaredSlots = 1, lane = 'main'): string {
  return `---\nlane: ${lane}\nslots: ${declaredSlots}\n---\n${slotsBody}\n`;
}

describe('parseNextMdText — bullet validation', () => {
  it('accepts a valid sprint ID without findings', () => {
    const r = parseNextMdText(next('## Slot 1\n- S-001'));
    expect(r.findings).toEqual([]);
    expect(r.parsed?.slots[0]?.sprintId).toBe('S-001');
  });

  it('emits NEXT_MD_INVALID_ID for a non-ID bullet inside a slot', () => {
    const r = parseNextMdText(next('## Slot 1\n- bogus'));
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain(FINDING_CODES.NEXT_MD_INVALID_ID);
    const finding = r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID);
    expect(finding?.severity).toBe('P0');
    expect(finding?.message).toContain('bogus');
  });

  it('emits NEXT_MD_INVALID_ID for letters where digits are required (`- S-ABC`)', () => {
    const r = parseNextMdText(next('## Slot 1\n- S-ABC'));
    const finding = r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID);
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('S-ABC');
  });

  it('emits NEXT_MD_INVALID_ID for lowercase `- s-001`', () => {
    const r = parseNextMdText(next('## Slot 1\n- s-001'));
    const finding = r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID);
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('s-001');
  });

  it('accepts `- S-1` (single digit) per the existing SPRINT_ID_RE = /^S-\\d+$/', () => {
    const r = parseNextMdText(next('## Slot 1\n- S-1'));
    expect(r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID)).toBeUndefined();
    expect(r.parsed?.slots[0]?.sprintId).toBe('S-1');
  });

  it('matches when the bullet has trailing context (`- S-001 (done)`)', () => {
    const r = parseNextMdText(next('## Slot 1\n- S-001 (done)'));
    expect(r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID)).toBeUndefined();
    expect(r.parsed?.slots[0]?.sprintId).toBe('S-001');
  });

  it('does not emit NEXT_MD_INVALID_ID for prose bullets outside any `## Slot` section', () => {
    const body = `# Notes\n- TODO: refactor\n- some prose\n## Slot 1\n- S-001`;
    const r = parseNextMdText(next(body, 1));
    expect(r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID)).toBeUndefined();
    expect(r.parsed?.slots[0]?.sprintId).toBe('S-001');
  });

  it('emits NEXT_MD_INVALID_ID per malformed bullet, one per slot', () => {
    const body = `## Slot 1\n- bogus\n## Slot 2\n- S-Q\n`;
    const r = parseNextMdText(next(body, 2));
    const invalid = r.findings.filter((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID);
    expect(invalid).toHaveLength(2);
  });

  it('still fires NEXT_MD_SLOT_MULTIPLE_SPRINTS when multiple bullets share a slot', () => {
    const body = `## Slot 1\n- S-001\n- S-002\n`;
    const r = parseNextMdText(next(body, 1));
    expect(
      r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_SLOT_MULTIPLE_SPRINTS),
    ).toBeDefined();
  });

  it('still fires NEXT_MD_DUPLICATE_SPRINT when a sprint appears in multiple slots', () => {
    const body = `## Slot 1\n- S-001\n## Slot 2\n- S-001\n`;
    const r = parseNextMdText(next(body, 2));
    expect(r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_DUPLICATE_SPRINT)).toBeDefined();
  });

  it('continues parsing remaining slots after an invalid ID', () => {
    const body = `## Slot 1\n- bogus\n## Slot 2\n- S-002\n`;
    const r = parseNextMdText(next(body, 2));
    expect(r.parsed?.slots).toHaveLength(2);
    expect(r.parsed?.slots[1]?.sprintId).toBe('S-002');
    expect(r.findings.find((f) => f.code === FINDING_CODES.NEXT_MD_INVALID_ID)).toBeDefined();
  });
});
