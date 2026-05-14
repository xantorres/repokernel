import { z } from 'zod';

/**
 * Persisted out-of-scope decisions ("we said no to this kind of thing").
 *
 * Append-only: every entry is written by `rk reject` and outlives any single
 * registry regeneration. Stored as `.repokernel/rejections.json` (resolved via
 * `config.paths.generated`) so it travels with the project under git.
 *
 * Pattern matching during intake compiles `pattern` as a JS RegExp (case
 * insensitive, single-line) and tests it against `title + "\n" + body`. A
 * matching pattern is a *proposal* — the operator must still confirm before any
 * tracker write happens. Auto-close from intake is intentionally not wired.
 */

export const REJECTION_ID_RE = /^REJ-[0-9A-HJKMNP-TV-Z]{26}$/;

export const RejectionIdSchema = z.string().regex(REJECTION_ID_RE);

export const REJECTION_SCOPES = ['feature', 'bug', 'enhancement'] as const;
export const RejectionScopeSchema = z.enum(REJECTION_SCOPES);
export type RejectionScope = z.infer<typeof RejectionScopeSchema>;

export const REJECTION_REGISTRY_SCHEMA_VERSION = 1;

export const RejectionAdrSchema = z
  .object({
    id: RejectionIdSchema,
    pattern: z.string().min(1),
    reason: z.string().min(20),
    scope: RejectionScopeSchema,
    source_issue: z.string().min(1).optional(),
    created_at: z.string().datetime({ offset: true }),
    created_by: z.string().min(1),
  })
  .strict();

export type RejectionAdr = z.infer<typeof RejectionAdrSchema>;

export const RejectionRegistrySchema = z
  .object({
    schemaVersion: z.literal(REJECTION_REGISTRY_SCHEMA_VERSION),
    rejections: z.array(RejectionAdrSchema),
  })
  .strict();

export type RejectionRegistry = z.infer<typeof RejectionRegistrySchema>;

export const REJECTION_PATTERN_MAX_LENGTH = 256;

const QUANTIFIER_START: ReadonlySet<string> = new Set(['+', '*', '{']);

/**
 * Linear scan: true when a parenthesised group is both quantified and contains
 * a nested quantifier or alternation, at any nesting depth. That is the
 * catastrophic-backtracking shape the flat regex checks miss — e.g. `((a+))+`,
 * where the `[^)]*` in a single regex cannot span the inner group. The scan is
 * O(n), so the guard itself cannot blow up on adversarial input. It errs
 * toward rejection: an exotic-but-safe quantified group may be refused.
 */
function hasQuantifiedRiskyGroup(pattern: string): boolean {
  const groups: { risky: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
    } else if (c === '(') {
      groups.push({ risky: false });
    } else if (c === ')') {
      const group = groups.pop();
      if (group === undefined) continue;
      const quantified = QUANTIFIER_START.has(pattern[i + 1] ?? '');
      if (quantified && group.risky) return true;
      const parent = groups[groups.length - 1];
      if (parent !== undefined && (group.risky || quantified)) {
        parent.risky = true;
      }
    } else if (c === '|' || QUANTIFIER_START.has(c)) {
      const current = groups[groups.length - 1];
      if (current !== undefined) current.risky = true;
    }
  }
  return false;
}

/**
 * Conservative safety guard for operator-authored rejection regexes. This is
 * not a regex verifier; it blocks the high-risk shapes that turn matching a
 * tracker title/body into catastrophic backtracking — including quantified
 * groups that nest a quantifier or alternation at any depth — while keeping
 * ordinary literal/alternation patterns usable.
 */
export function isSafeRejectionPattern(pattern: string): boolean {
  if (pattern.length > REJECTION_PATTERN_MAX_LENGTH) return false;
  if (/(?:\([^)]*[+*][^)]*\)|\[[^\]]+\][+*])(?:[+*?]|\{\d+(?:,\d*)?\})/.test(pattern)) {
    return false;
  }
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern)) {
    return false;
  }
  if (hasQuantifiedRiskyGroup(pattern)) return false;
  if (/\\[1-9]/.test(pattern)) return false;
  if (/(?:\.\*){3,}/.test(pattern)) return false;
  return true;
}

/**
 * Compile a rejection's pattern as a case-insensitive single-line regex.
 * Returns `null` if the pattern is malformed; callers surface this as a P3
 * finding rather than throwing, so a single corrupt entry doesn't block all
 * intake.
 */
export function compileRejectionPattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'is');
  } catch {
    return null;
  }
}
