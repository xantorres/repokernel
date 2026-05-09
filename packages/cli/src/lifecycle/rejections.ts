import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type Config,
  compileRejectionPattern,
  REJECTION_REGISTRY_SCHEMA_VERSION,
  type RejectionAdr,
  type RejectionRegistry,
  RejectionRegistrySchema,
  RepoKernelError,
} from '@repokernel/core';
import { ambientJournalWrite, nextOpId } from './journal.js';

export const REJECTIONS_FILENAME = 'rejections.json';

const EMPTY_REGISTRY: RejectionRegistry = {
  schemaVersion: REJECTION_REGISTRY_SCHEMA_VERSION,
  rejections: [],
};

/**
 * Resolve the absolute path to `rejections.json` for the given project. Lives
 * under `config.paths.generated` (`.repokernel/` by default) so it is committed
 * to git alongside the rest of the project state.
 */
export function rejectionsPath(cwd: string, config: Config): string {
  return resolve(cwd, config.paths.generated, REJECTIONS_FILENAME);
}

/**
 * Read and validate the rejection registry. Returns an empty registry if the
 * file does not exist (first-run case). Throws `RepoKernelError` on parse or
 * schema failure so callers can surface a single corruption error rather than
 * silently dropping every rejection.
 */
export async function loadRejections(cwd: string, config: Config): Promise<RejectionRegistry> {
  const path = rejectionsPath(cwd, config);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return EMPTY_REGISTRY;
    throw new RepoKernelError('IO_ERROR', `cannot read ${path}`, cause);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `${path}: invalid JSON`, cause);
  }
  const parsed = RejectionRegistrySchema.safeParse(json);
  if (!parsed.success) {
    throw new RepoKernelError(
      'IO_ERROR',
      `${path}: schema validation failed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export interface AppendRejectionInput {
  readonly pattern: RejectionAdr['pattern'];
  readonly reason: RejectionAdr['reason'];
  readonly scope: RejectionAdr['scope'];
  readonly source_issue?: RejectionAdr['source_issue'];
  readonly created_by: RejectionAdr['created_by'];
  /** Override clock for tests. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /** Override id generator for tests. Defaults to `nextRejectionId()`. */
  readonly idGen?: () => string;
}

export interface AppendRejectionResult {
  readonly registry: RejectionRegistry;
  readonly added: RejectionAdr;
  readonly duplicate: false;
}

export interface AppendRejectionDuplicate {
  readonly registry: RejectionRegistry;
  readonly added: null;
  readonly duplicate: true;
  readonly existing: RejectionAdr;
}

export type AppendRejectionOutcome = AppendRejectionResult | AppendRejectionDuplicate;

/**
 * Append a new rejection to the registry. Idempotent on `(pattern, scope)` —
 * a second call with the same pattern + scope returns the existing entry and
 * does not write. Compiles the pattern up-front so a malformed regex is
 * surfaced as a `RepoKernelError` before any disk write.
 *
 * Participates in the surrounding `withJournal` boundary via
 * `ambientJournalWrite`; outside one it falls back to plain atomic write so
 * standalone `rk reject` invocations remain crash-safe.
 */
export async function appendRejection(
  cwd: string,
  config: Config,
  input: AppendRejectionInput,
): Promise<AppendRejectionOutcome> {
  if (compileRejectionPattern(input.pattern) === null) {
    throw new RepoKernelError(
      'IO_ERROR',
      `rejection pattern is not a valid JavaScript regex: ${input.pattern}`,
    );
  }
  const registry = await loadRejections(cwd, config);
  const existing = registry.rejections.find(
    (r) => r.pattern === input.pattern && r.scope === input.scope,
  );
  if (existing) {
    return { registry, added: null, duplicate: true, existing };
  }
  const now = input.now ?? (() => new Date().toISOString());
  const idGen = input.idGen ?? nextRejectionId;
  const adr: RejectionAdr = {
    id: idGen(),
    pattern: input.pattern,
    reason: input.reason,
    scope: input.scope,
    ...(input.source_issue !== undefined ? { source_issue: input.source_issue } : {}),
    created_at: now(),
    created_by: input.created_by,
  };
  const next: RejectionRegistry = {
    schemaVersion: REJECTION_REGISTRY_SCHEMA_VERSION,
    rejections: [...registry.rejections, adr],
  };
  const path = rejectionsPath(cwd, config);
  await mkdir(dirname(path), { recursive: true });
  await ambientJournalWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return { registry: next, added: adr, duplicate: false };
}

export interface RejectionMatchInput {
  readonly title: string;
  readonly body?: string;
}

export interface RejectionMatch {
  readonly adr: RejectionAdr;
  readonly matched: string;
}

/**
 * Match every well-formed rejection in `registry` against the ticket. Compiles
 * each pattern once per call. Malformed patterns are skipped; surface them via
 * doctor's check pass instead. Pattern matches against `title + "\n" + body`.
 */
export function matchRejection(
  registry: RejectionRegistry,
  ticket: RejectionMatchInput,
): RejectionMatch[] {
  const haystack = `${ticket.title}\n${ticket.body ?? ''}`;
  const matches: RejectionMatch[] = [];
  for (const adr of registry.rejections) {
    const re = compileRejectionPattern(adr.pattern);
    if (!re) continue;
    if (re.test(haystack)) matches.push({ adr, matched: haystack });
  }
  return matches;
}

/**
 * Generate a new REJ id by reusing the OP-<ULID> generator from journal.ts and
 * re-prefixing the ULID portion. Keeps a single ULID implementation in the
 * codebase and ensures REJ ids inherit OP's monotonic-within-millisecond
 * guarantee.
 */
export function nextRejectionId(): string {
  const opId = nextOpId();
  const ulid = opId.slice('OP-'.length);
  return `REJ-${ulid}`;
}
