import type { Finding } from '@repokernel/core';

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No findings.';
  const lines: string[] = [];
  for (const f of findings) {
    const loc = f.file ? ` ${f.file}` : '';
    const ent = f.entityId ? ` [${f.entityId}]` : '';
    lines.push(`${f.severity} ${f.code}${ent}${loc}`);
    lines.push(`  ${f.message}`);
    if (f.suggestion) lines.push(`  -> ${f.suggestion}`);
  }
  return lines.join('\n');
}

export function formatFindingSummary(findings: readonly Finding[]): string {
  const counts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return `P0=${counts['P0']} P1=${counts['P1']} P2=${counts['P2']} P3=${counts['P3']} total=${findings.length}`;
}
