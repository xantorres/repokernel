/**
 * Review schema v1 → v2 migration.
 *
 * v1 (pre-rc.3) findings used per-finding keys:
 *   { severity, category, file, line, description, fix_hint, confidence }
 *
 * v2 collapses the human-readable parts into a single `message`:
 *   { severity, message }
 *
 * with `file`, `line`, `category`, `confidence` preserved as best-effort
 * metadata (loaded from review.findings[].data when supported in future).
 *
 * The transform is idempotent: a finding that already has `message` is
 * passed through unchanged, just normalized into the v2 shape.
 */

const V2_SEVERITY = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
type V2Severity = (typeof V2_SEVERITY)[number];

function normalizeSeverity(input: unknown): V2Severity {
  if (typeof input !== 'string') return 'MEDIUM';
  const upper = input.toUpperCase();
  if ((V2_SEVERITY as readonly string[]).includes(upper)) return upper as V2Severity;
  // Map common v1 phrasings.
  if (upper === 'INFO' || upper === 'NOTE' || upper === 'TRACE') return 'LOW';
  if (upper === 'WARN' || upper === 'WARNING') return 'MEDIUM';
  if (upper === 'ERROR') return 'HIGH';
  if (upper === 'FATAL') return 'CRITICAL';
  return 'MEDIUM';
}

function buildMessage(finding: Record<string, unknown>): string {
  // Already v2.
  if (typeof finding.message === 'string' && finding.message.trim().length > 0) {
    return finding.message.trim();
  }
  const parts: string[] = [];
  const category = typeof finding.category === 'string' ? finding.category.trim() : '';
  const description = typeof finding.description === 'string' ? finding.description.trim() : '';
  const fixHint = typeof finding.fix_hint === 'string' ? finding.fix_hint.trim() : '';
  const file = typeof finding.file === 'string' ? finding.file.trim() : '';
  const line = typeof finding.line === 'number' ? `:${finding.line}` : '';
  if (category) parts.push(`[${category}]`);
  if (description) parts.push(description);
  else if (file) parts.push(`finding in ${file}${line}`);
  else parts.push('legacy v1 finding (no description)');
  if (fixHint) parts.push(`— fix: ${fixHint}`);
  return parts.join(' ');
}

export interface MigrateReviewV1ToV2Result {
  readonly migrated: Record<string, unknown>;
  readonly wasV1: boolean;
}

/**
 * Detect whether a parsed review frontmatter object is in v1 shape.
 *
 * Heuristics:
 *   - schema_version is missing or < 2
 *   - any finding entry has v1-only keys (category|description|fix_hint|confidence)
 *     and lacks `message`
 */
export function isV1Review(raw: Record<string, unknown>): boolean {
  const sv = raw.schema_version;
  if (typeof sv === 'number' && sv >= 2) return false;
  const findings = raw.findings;
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (!f || typeof f !== 'object') continue;
      const obj = f as Record<string, unknown>;
      const hasV1Keys =
        'category' in obj || 'description' in obj || 'fix_hint' in obj || 'confidence' in obj;
      const hasV2Message = typeof obj.message === 'string' && obj.message.trim().length > 0;
      if (hasV1Keys && !hasV2Message) return true;
    }
  }
  // schema_version absent and no v1 fingerprints: still treat as v1 for migration purposes
  // — adds the schema_version field without otherwise mutating the file.
  return typeof sv !== 'number';
}

export function migrateReviewV1ToV2(raw: Record<string, unknown>): MigrateReviewV1ToV2Result {
  const wasV1 = isV1Review(raw);
  const out: Record<string, unknown> = { ...raw };
  out.schema_version = 2;

  const findings = raw.findings;
  if (Array.isArray(findings)) {
    out.findings = findings.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const src = f as Record<string, unknown>;
      return {
        severity: normalizeSeverity(src.severity),
        message: buildMessage(src),
      };
    });
  }
  return { migrated: out, wasV1 };
}
