import { z } from 'zod';

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
    code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    message: z.string().min(1),
    file: z.string().optional(),
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
  return aFile.localeCompare(bFile);
}

export function meetsThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}
