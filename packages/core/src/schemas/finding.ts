import { z } from 'zod';
import { FINDING_CODES } from '../validator/codes.js';

export const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_RANK: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export const EntityTypeSchema = z.enum(['sprint', 'epic', 'review', 'queue', 'lane', 'config']);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const FindingSchema = z
  .object({
    severity: SeveritySchema,
    code: z.enum(Object.keys(FINDING_CODES) as [string, ...string[]]),
    message: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    entityType: EntityTypeSchema.optional(),
    entityId: z.string().optional(),
    suggestion: z.string().optional(),
    data: z.record(z.unknown()).optional(),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

export function compareFindings(a: Finding, b: Finding): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  const code = a.code.localeCompare(b.code);
  if (code !== 0) return code;
  const aId = a.entityId ?? '';
  const bId = b.entityId ?? '';
  const id = aId.localeCompare(bId);
  if (id !== 0) return id;
  const aFile = a.file ?? '';
  const bFile = b.file ?? '';
  const file = aFile.localeCompare(bFile);
  if (file !== 0) return file;
  return (a.line ?? 0) - (b.line ?? 0);
}

export function meetsThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}

/**
 * Canonical summary of a finding set. Shared by every `--json` surface
 * (`rk status`, `rk validate`, `rk registry`) so agents parse one stable
 * shape regardless of which command produced it.
 */
export const FindingSummarySchema = z
  .object({
    maxSeverity: SeveritySchema.nullable(),
    findingCounts: z.object({
      P0: z.number().int().nonnegative(),
      P1: z.number().int().nonnegative(),
      P2: z.number().int().nonnegative(),
      P3: z.number().int().nonnegative(),
    }),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type FindingSummary = z.infer<typeof FindingSummarySchema>;

export function summarizeFindings(findings: readonly Finding[]): FindingSummary {
  const findingCounts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let maxSeverity: Severity | null = null;
  for (const f of findings) {
    findingCounts[f.severity]++;
    if (maxSeverity === null || SEVERITY_RANK[f.severity] < SEVERITY_RANK[maxSeverity]) {
      maxSeverity = f.severity;
    }
  }
  return { maxSeverity, findingCounts, total: findings.length };
}
