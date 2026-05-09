import { describe, expect, it } from 'vitest';
import {
  compileRejectionPattern,
  REJECTION_REGISTRY_SCHEMA_VERSION,
  RejectionAdrSchema,
  RejectionRegistrySchema,
} from '../src/schemas/rejection.js';

const VALID_ADR = {
  id: 'REJ-01HFAKEFAKEFAKEFAKEFAKEFAK',
  pattern: 'docker.*compose',
  reason: 'Out of scope per design discussion 2026-04-27',
  scope: 'enhancement' as const,
  source_issue: 'gh:owner/repo#42',
  created_at: '2026-05-09T10:00:00.000Z',
  created_by: 'xan@example.com',
};

describe('RejectionAdrSchema', () => {
  it('accepts a fully populated entry', () => {
    expect(() => RejectionAdrSchema.parse(VALID_ADR)).not.toThrow();
  });

  it('accepts an entry without source_issue (manual rejections)', () => {
    const { source_issue: _omit, ...rest } = VALID_ADR;
    expect(() => RejectionAdrSchema.parse(rest)).not.toThrow();
  });

  it('rejects ids that do not follow REJ-<26-char-ULID> shape', () => {
    expect(() => RejectionAdrSchema.parse({ ...VALID_ADR, id: 'REJ-short' })).toThrow();
    expect(() =>
      RejectionAdrSchema.parse({ ...VALID_ADR, id: 'rej-01HFAKEFAKEFAKEFAKEFAKEFAK' }),
    ).toThrow();
  });

  it('rejects reasons shorter than 20 characters', () => {
    expect(() => RejectionAdrSchema.parse({ ...VALID_ADR, reason: 'too short' })).toThrow();
  });

  it('rejects unknown scopes', () => {
    expect(() => RejectionAdrSchema.parse({ ...VALID_ADR, scope: 'chore' })).toThrow();
  });

  it('rejects extra keys (strict)', () => {
    expect(() => RejectionAdrSchema.parse({ ...VALID_ADR, extra: 1 })).toThrow();
  });

  it('rejects non-ISO created_at values', () => {
    expect(() => RejectionAdrSchema.parse({ ...VALID_ADR, created_at: '2026-05-09' })).toThrow();
  });
});

describe('RejectionRegistrySchema', () => {
  it('accepts an empty registry', () => {
    expect(() =>
      RejectionRegistrySchema.parse({
        schemaVersion: REJECTION_REGISTRY_SCHEMA_VERSION,
        rejections: [],
      }),
    ).not.toThrow();
  });

  it('rejects unknown schemaVersion', () => {
    expect(() => RejectionRegistrySchema.parse({ schemaVersion: 99, rejections: [] })).toThrow();
  });

  it('parses a registry with one entry round-trip safe', () => {
    const reg = RejectionRegistrySchema.parse({
      schemaVersion: REJECTION_REGISTRY_SCHEMA_VERSION,
      rejections: [VALID_ADR],
    });
    expect(reg.rejections).toHaveLength(1);
    expect(reg.rejections[0]?.id).toBe(VALID_ADR.id);
  });
});

describe('compileRejectionPattern', () => {
  it('returns a RegExp for a valid pattern', () => {
    const re = compileRejectionPattern('docker.*compose');
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.test('add docker compose support please')).toBe(true);
  });

  it('matches case-insensitively across newlines', () => {
    const re = compileRejectionPattern('docker.*compose');
    expect(re?.test('Add\nDOCKER\ncompose support')).toBe(true);
  });

  it('returns null for malformed patterns instead of throwing', () => {
    expect(compileRejectionPattern('[unclosed')).toBeNull();
  });
});
