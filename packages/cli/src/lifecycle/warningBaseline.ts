import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Config, Finding } from '@repokernel/core';

export interface WarningBaselineEntry {
  readonly fingerprint: string;
  readonly code: string;
  readonly severity: string;
  readonly file: string | null;
  readonly entity_id: string | null;
  readonly message: string;
}

export interface WarningBaseline {
  readonly schemaVersion: 1;
  readonly owner: string | null;
  readonly expires: string | null;
  readonly captured_at: string;
  readonly warnings: readonly WarningBaselineEntry[];
}

export interface WarningBaselineApplication {
  readonly path: string;
  readonly loaded: boolean;
  readonly expired: boolean;
  readonly owner: string | null;
  readonly expires: string | null;
  readonly matched: readonly string[];
  readonly active_count: number;
  readonly expired_count: number;
}

export async function applyWarningBaseline(args: {
  readonly cwd: string;
  readonly config?: Config | undefined;
  readonly findings: readonly Finding[];
  readonly now?: Date;
}): Promise<{
  readonly findingsForExit: readonly Finding[];
  readonly application: WarningBaselineApplication | null;
}> {
  if (args.config === undefined) {
    return { findingsForExit: args.findings, application: null };
  }
  const path = warningBaselinePath(args.cwd, args.config);
  const baseline = await readWarningBaseline(path);
  if (baseline === null) {
    return { findingsForExit: args.findings, application: null };
  }

  const expired = isExpired(baseline.expires, args.now ?? new Date());
  const fingerprints = new Set(baseline.warnings.map((warning) => warning.fingerprint));
  const matched: string[] = [];
  const findingsForExit = args.findings.filter((finding) => {
    if (!isWarningFinding(finding)) return true;
    const fp = fingerprintFinding(finding);
    if (!fingerprints.has(fp)) return true;
    matched.push(fp);
    return expired;
  });

  return {
    findingsForExit,
    application: {
      path,
      loaded: true,
      expired,
      owner: baseline.owner,
      expires: baseline.expires,
      matched: [...new Set(matched)].sort(),
      active_count: expired ? 0 : matched.length,
      expired_count: expired ? matched.length : 0,
    },
  };
}

export function warningBaselinePath(cwd: string, config: Config): string {
  return join(resolve(cwd), config.paths.generated, 'warnings-baseline.json');
}

export function fingerprintFinding(finding: {
  readonly code: string;
  readonly file?: string | undefined;
  readonly entityId?: string | undefined;
  readonly message: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([finding.code, finding.file ?? '', finding.entityId ?? '', finding.message]),
    )
    .digest('hex');
}

function isWarningFinding(finding: Finding): boolean {
  return finding.severity === 'P2' || finding.severity === 'P3';
}

async function readWarningBaseline(path: string): Promise<WarningBaseline | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<WarningBaseline>;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.warnings)) return null;
    return {
      schemaVersion: 1,
      owner: typeof raw.owner === 'string' ? raw.owner : null,
      expires: typeof raw.expires === 'string' ? raw.expires : null,
      captured_at: typeof raw.captured_at === 'string' ? raw.captured_at : '',
      warnings: raw.warnings.filter(isWarningBaselineEntry),
    };
  } catch {
    return null;
  }
}

function isWarningBaselineEntry(value: unknown): value is WarningBaselineEntry {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<WarningBaselineEntry>;
  return (
    typeof item.fingerprint === 'string' &&
    typeof item.code === 'string' &&
    typeof item.severity === 'string' &&
    typeof item.message === 'string'
  );
}

function isExpired(expires: string | null, now: Date): boolean {
  if (expires === null) return false;
  const today = now.toISOString().slice(0, 10);
  return expires < today;
}
