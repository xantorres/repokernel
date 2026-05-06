import { describe, expect, it } from 'vitest';
import {
  isSupportedJournalSchemaVersion,
  JournalEnvelopeSchema,
  JournalStepSchema,
  RecoverReportSchema,
  SUPPORTED_JOURNAL_SCHEMA_VERSIONS,
} from '../src/schemas/index.js';

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

const VALID_STEP = {
  stepIndex: 0,
  op: 'write' as const,
  path: 'sprints/S-001.md',
  prevHash: SHA,
  nextHash: SHA2,
  content: '---\ntitle: foo\n---\n',
  encoding: 'utf8' as const,
  startedAt: '2026-05-06T12:00:00.000Z',
  completedAt: null,
};

const VALID_ENVELOPE = {
  schemaVersion: 1,
  opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
  command: 'next-sync',
  args: { lane: 'main' },
  startedAt: '2026-05-06T12:00:00.000Z',
  completedAt: null,
  steps: [VALID_STEP],
};

describe('JournalStepSchema', () => {
  it('accepts a minimal valid write step', () => {
    expect(() => JournalStepSchema.parse(VALID_STEP)).not.toThrow();
  });

  it('defaults encoding to utf8', () => {
    const { encoding: _omit, ...withoutEncoding } = VALID_STEP;
    const parsed = JournalStepSchema.parse(withoutEncoding);
    expect(parsed.encoding).toBe('utf8');
  });

  it('accepts delete step with null nextHash and null content', () => {
    expect(() =>
      JournalStepSchema.parse({
        ...VALID_STEP,
        op: 'delete',
        nextHash: null,
        content: null,
      }),
    ).not.toThrow();
  });

  it('accepts atomic-create with null prevHash', () => {
    expect(() =>
      JournalStepSchema.parse({
        ...VALID_STEP,
        op: 'atomic-create',
        prevHash: null,
      }),
    ).not.toThrow();
  });

  it('accepts invalidate-cache with both hashes null', () => {
    expect(() =>
      JournalStepSchema.parse({
        ...VALID_STEP,
        op: 'invalidate-cache',
        path: '/tmp/preflight.cache',
        prevHash: null,
        nextHash: null,
        content: null,
      }),
    ).not.toThrow();
  });

  it('rejects an unknown op', () => {
    expect(() => JournalStepSchema.parse({ ...VALID_STEP, op: 'truncate' })).toThrow();
  });

  it('rejects malformed sha256 hash', () => {
    expect(() => JournalStepSchema.parse({ ...VALID_STEP, prevHash: 'not-a-hash' })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => JournalStepSchema.parse({ ...VALID_STEP, extraField: true })).toThrow();
  });

  it('preserves base64 encoding when set', () => {
    const parsed = JournalStepSchema.parse({ ...VALID_STEP, encoding: 'base64' });
    expect(parsed.encoding).toBe('base64');
  });

  it('rejects negative stepIndex', () => {
    expect(() => JournalStepSchema.parse({ ...VALID_STEP, stepIndex: -1 })).toThrow();
  });
});

describe('JournalEnvelopeSchema', () => {
  it('round-trips a valid envelope', () => {
    const parsed = JournalEnvelopeSchema.parse(VALID_ENVELOPE);
    expect(parsed.opId).toBe(VALID_ENVELOPE.opId);
    expect(parsed.steps).toHaveLength(1);
  });

  it('defaults args to empty object', () => {
    const { args: _omit, ...withoutArgs } = VALID_ENVELOPE;
    const parsed = JournalEnvelopeSchema.parse(withoutArgs);
    expect(parsed.args).toEqual({});
  });

  it('rejects malformed opId (not ULID-shaped)', () => {
    expect(() =>
      JournalEnvelopeSchema.parse({ ...VALID_ENVELOPE, opId: 'OP-not-a-ulid' }),
    ).toThrow();
  });

  it('rejects schemaVersion 0 or negative', () => {
    expect(() => JournalEnvelopeSchema.parse({ ...VALID_ENVELOPE, schemaVersion: 0 })).toThrow();
    expect(() => JournalEnvelopeSchema.parse({ ...VALID_ENVELOPE, schemaVersion: -1 })).toThrow();
  });

  it('accepts future schemaVersion at parse time (recover classifies later)', () => {
    // Parse must succeed for future versions so recover can read the file
    // and classify it as UNKNOWN_SCHEMA. Quarantining future versions here
    // would discard data a newer rk could replay.
    const parsed = JournalEnvelopeSchema.parse({ ...VALID_ENVELOPE, schemaVersion: 99 });
    expect(parsed.schemaVersion).toBe(99);
    expect(isSupportedJournalSchemaVersion(parsed.schemaVersion)).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => JournalEnvelopeSchema.parse({ ...VALID_ENVELOPE, secret: 'x' })).toThrow();
  });

  it('rejects empty command', () => {
    expect(() => JournalEnvelopeSchema.parse({ ...VALID_ENVELOPE, command: '' })).toThrow();
  });
});

describe('isSupportedJournalSchemaVersion', () => {
  it('accepts every value in SUPPORTED_JOURNAL_SCHEMA_VERSIONS', () => {
    for (const v of SUPPORTED_JOURNAL_SCHEMA_VERSIONS) {
      expect(isSupportedJournalSchemaVersion(v)).toBe(true);
    }
  });

  it('rejects future versions', () => {
    expect(isSupportedJournalSchemaVersion(99)).toBe(false);
  });

  it('rejects zero', () => {
    expect(isSupportedJournalSchemaVersion(0)).toBe(false);
  });
});

describe('RecoverReportSchema', () => {
  it('round-trips a minimal report', () => {
    const report = {
      schemaVersion: 1 as const,
      ranAt: '2026-05-06T12:00:00.000Z',
      apply: true,
      journals: [],
    };
    expect(() => RecoverReportSchema.parse(report)).not.toThrow();
  });

  it('round-trips a report with entries', () => {
    const report = {
      schemaVersion: 1 as const,
      ranAt: '2026-05-06T12:00:00.000Z',
      apply: true,
      journals: [
        {
          opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
          path: '/tmp/repo/.git/repokernel/journal/OP-01ARZ3NDEKTSV4RRFFQ69G5FAV.pending.json',
          classification: 'safe_replay' as const,
          detail: 'replayed 3 steps',
          stepsApplied: 3,
          stepsAlreadyApplied: 0,
        },
      ],
    };
    const parsed = RecoverReportSchema.parse(report);
    expect(parsed.journals).toHaveLength(1);
    expect(parsed.journals[0].classification).toBe('safe_replay');
  });

  it('rejects unknown classification', () => {
    expect(() =>
      RecoverReportSchema.parse({
        schemaVersion: 1 as const,
        ranAt: '2026-05-06T12:00:00.000Z',
        apply: false,
        journals: [
          {
            opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
            path: '/x',
            classification: 'partially_applied',
            detail: 'd',
          },
        ],
      }),
    ).toThrow();
  });
});
