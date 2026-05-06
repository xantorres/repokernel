import { z } from 'zod';

/**
 * Transaction journal envelope schema.
 *
 * The journal is a write-ahead log for multi-file mutations. It lives at
 * `<git-common-dir>/repokernel/journal/` and is strictly local-clone — never
 * versioned, never travels through `git push`/`git fetch`.
 *
 * Each operation produces one envelope file:
 *   - `OP-<ulid>.pending.json`         while in-flight
 *   - `OP-<ulid>.done.json`            after the closing rename (commit point)
 *   - `OP-<ulid>.unrecoverable.<ts>.<rand>.json`  quarantined by `rk recover`
 *
 * Recovery (`rk recover --apply`) classifies each `.pending.json` into one of:
 *   safe replay | already applied | diverged | unknown schema | corrupt journal
 *
 * Inline `step.content` is mandatory: mutation bytes are usually
 * non-deterministic (timestamps, runtime PIDs, monotonic IDs), so recover
 * cannot re-derive them from a `source` enum. The inline copy preserves the
 * exact bytes the original op intended to write.
 */

export const JOURNAL_STEP_OPS = ['write', 'delete', 'invalidate-cache', 'atomic-create'] as const;
export const JournalStepOpSchema = z.enum(JOURNAL_STEP_OPS);
export type JournalStepOp = z.infer<typeof JournalStepOpSchema>;

export const JOURNAL_CONTENT_ENCODINGS = ['utf8', 'base64'] as const;
export const JournalContentEncodingSchema = z.enum(JOURNAL_CONTENT_ENCODINGS);
export type JournalContentEncoding = z.infer<typeof JournalContentEncodingSchema>;

/**
 * Single mutation step within an operation.
 *
 * Hash conventions:
 *   - `prevHash` is the SHA-256 of the file's bytes BEFORE this step. `null`
 *     when the file did not exist (e.g. `atomic-create`, or `invalidate-cache`
 *     when the cache file was absent).
 *   - `nextHash` is the SHA-256 AFTER this step. `null` for `delete` and
 *     `invalidate-cache` (no resulting file).
 *   - For `write` and `atomic-create`, `sha256(decode(content, encoding))`
 *     MUST equal `nextHash`. Recover detects content tamper by checking
 *     this invariant.
 *
 * `subCommand` is the journal context label that recorded this step. When a
 * primitive piggy-backs on an outer command's journal via the AsyncLocalStorage
 * cooperation, the outer command appears in the envelope's `command` and the
 * primitive appears here.
 */
export const JournalStepSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    op: JournalStepOpSchema,
    path: z.string().min(1),
    prevHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    nextHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    content: z.string().nullable(),
    encoding: JournalContentEncodingSchema.default('utf8'),
    subCommand: z.string().min(1).optional(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type JournalStep = z.infer<typeof JournalStepSchema>;

/**
 * Schema versions the runtime knows how to replay. Future versions land
 * one minor before becoming the default; the v1 reader stays one minor
 * past the v2 default per existing core schemas policy.
 *
 * `rk recover` classifies any `schemaVersion` outside this list as
 * UNKNOWN_SCHEMA — leaves the file untouched, surfaces a P1 finding, and
 * does NOT quarantine. Quarantining a future-version journal would discard
 * data that a newer rk version could legitimately replay.
 */
export const SUPPORTED_JOURNAL_SCHEMA_VERSIONS = [1] as const;
export type SupportedJournalSchemaVersion = (typeof SUPPORTED_JOURNAL_SCHEMA_VERSIONS)[number];

export function isSupportedJournalSchemaVersion(
  version: number,
): version is SupportedJournalSchemaVersion {
  return (SUPPORTED_JOURNAL_SCHEMA_VERSIONS as readonly number[]).includes(version);
}

/**
 * Top-level operation envelope. One file per user-facing command.
 *
 * `command` is the outermost command label (e.g. `next-sync`, `run-step`,
 * `sprint-extras` when called standalone). Step-level `subCommand` records
 * which primitive emitted each step under the outer journal context.
 *
 * `args` is opaque key/value context for forensic clarity; not part of the
 * recovery decision.
 */
export const JournalEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    opId: z.string().regex(/^OP-[0-9A-HJKMNP-TV-Z]{26}$/),
    command: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    steps: z.array(JournalStepSchema),
  })
  .strict();

export type JournalEnvelope = z.infer<typeof JournalEnvelopeSchema>;

/**
 * Recovery classification — exhaustive enumeration of how `rk recover`
 * treats each pending journal it scans.
 */
export const JOURNAL_CLASSIFICATIONS = [
  'safe_replay',
  'already_applied',
  'diverged',
  'unknown_schema',
  'corrupt',
] as const;
export const JournalClassificationSchema = z.enum(JOURNAL_CLASSIFICATIONS);
export type JournalClassification = z.infer<typeof JournalClassificationSchema>;

/**
 * Structured record returned by `rk recover --apply` summarizing what was
 * done to each journal it inspected. Persisted in `<opRoot>/recover.report.json`.
 */
export const RecoverReportEntrySchema = z
  .object({
    opId: z.string().min(1),
    path: z.string().min(1),
    classification: JournalClassificationSchema,
    detail: z.string().min(1),
    stepsApplied: z.number().int().nonnegative().default(0),
    stepsAlreadyApplied: z.number().int().nonnegative().default(0),
  })
  .strict();
export type RecoverReportEntry = z.infer<typeof RecoverReportEntrySchema>;

export const RecoverReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    ranAt: z.string().datetime({ offset: true }),
    apply: z.boolean(),
    journals: z.array(RecoverReportEntrySchema).default([]),
  })
  .strict();
export type RecoverReport = z.infer<typeof RecoverReportSchema>;
