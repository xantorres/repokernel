import type { Sprint, SprintId } from '@repokernel/core';

export interface PathConflictPair {
  sprint1: SprintId;
  sprint2: SprintId;
  overlappingGlobs: string[];
}

export interface PathConflictUnknown {
  sprint1: SprintId;
  sprint2: SprintId;
  reason: 'complex_globs';
}

export interface PathConflictResult {
  definiteConflicts: PathConflictPair[];
  unknownRiskPairs: PathConflictUnknown[];
  /** true when either definiteConflicts or unknownRiskPairs is non-empty. */
  hasConflicts: boolean;
}

/**
 * Conservative v1 glob overlap detector for run preflight.
 *
 * Rules (in order):
 * 1. Normalize globs (trim whitespace, strip trailing slashes/stars).
 * 2. Extract the static prefix (segments before any wildcard character).
 * 3. If static prefixes have a parent-child relationship:
 *    a. Both globs are literal paths OR one covers the other via **  -> definiteConflict
 *    b. Both globs contain wildcards in the static prefix zone         -> unknownRisk
 * 4. Everything else: no conflict.
 *
 * This is intentionally conservative — false positives block parallel,
 * false negatives allow silent overlap. We prefer to block.
 */
export function detectPathConflicts(sprints: Sprint[]): PathConflictResult {
  const definiteConflicts: PathConflictPair[] = [];
  const unknownRiskPairs: PathConflictUnknown[] = [];

  for (let i = 0; i < sprints.length; i++) {
    for (let j = i + 1; j < sprints.length; j++) {
      const a = sprints[i]!;
      const b = sprints[j]!;

      if (a.allowed_paths.length === 0 || b.allowed_paths.length === 0) {
        // No allowed_paths constraint -> could touch anything -> unknown risk
        unknownRiskPairs.push({ sprint1: a.id, sprint2: b.id, reason: 'complex_globs' });
        continue;
      }

      const overlapping: string[] = [];
      let hasUnknown = false;

      for (const globA of a.allowed_paths) {
        for (const globB of b.allowed_paths) {
          const verdict = checkGlobPair(globA, globB);
          if (verdict === 'definite') {
            overlapping.push(`${globA} ∩ ${globB}`);
          } else if (verdict === 'unknown') {
            hasUnknown = true;
          }
        }
      }

      if (overlapping.length > 0) {
        definiteConflicts.push({
          sprint1: a.id,
          sprint2: b.id,
          overlappingGlobs: overlapping,
        });
      } else if (hasUnknown) {
        unknownRiskPairs.push({ sprint1: a.id, sprint2: b.id, reason: 'complex_globs' });
      }
    }
  }

  return {
    definiteConflicts,
    unknownRiskPairs,
    hasConflicts: definiteConflicts.length > 0 || unknownRiskPairs.length > 0,
  };
}

// --- internal helpers ---

type OverlapVerdict = 'none' | 'definite' | 'unknown';

function checkGlobPair(rawA: string, rawB: string): OverlapVerdict {
  const a = normalizeGlob(rawA);
  const b = normalizeGlob(rawB);

  if (!a || !b) return 'unknown'; // degenerate empty pattern

  const prefA = staticPrefix(a);
  const prefB = staticPrefix(b);

  // Neither has a static prefix (both start with wildcards) — complex
  if (!prefA && !prefB) return 'unknown';

  // One lacks a static prefix (starts with wildcard) — could match anything
  if (!prefA || !prefB) return 'unknown';

  // Check for parent-child relationship between static prefixes
  const aContainsB = isParentOrEqual(prefA, prefB);
  const bContainsA = isParentOrEqual(prefB, prefA);

  if (!aContainsB && !bContainsA) return 'none'; // different roots

  // There's a prefix relationship.
  // Determine overlap certainty based on where wildcards appear:
  // - "trailing only" wildcards (/**  or /* after static prefix) -> definite
  // - wildcards in the middle of the path -> complex -> unknown
  const aSimple = hasOnlyTrailingWildcard(a);
  const bSimple = hasOnlyTrailingWildcard(b);

  if (aSimple && bSimple) {
    // e.g., src/** vs src/utils/** or src vs src/utils.ts
    return 'definite';
  }

  // One or both have wildcards mid-path (e.g., packages/*/src/**) -> complex
  return 'unknown';
}

/**
 * Returns true when the glob has no wildcards in intermediate path segments.
 * Trailing wildcards like "/**" or "/*" are acceptable.
 *
 * Examples:
 *   "src/**"              -> true  (wildcard is trailing)
 *   "src/utils/**"        -> true  (wildcard is trailing)
 *   "src/utils.ts"        -> true  (no wildcard at all)
 *   "packages/GLOB/src/**" -> false (wildcard in middle segment)
 */
function hasOnlyTrailingWildcard(glob: string): boolean {
  const pref = staticPrefix(glob);
  const remaining = glob.slice(pref.length);
  if (!remaining) return true; // pure literal path
  // Remaining must start with / followed by wildcard characters only (no more
  // literal segments like /foo after a wildcard)
  if (!/^\/[*?{[]/.test(remaining)) return false;
  // Check: after the first wildcard character, are there any literal dir segments?
  const afterSlash = remaining.slice(1); // drop the leading /
  return !/\/[^*?{[]/.test(afterSlash);
}

function normalizeGlob(glob: string): string {
  return glob.trim().replace(/\/+$/, ''); // strip trailing slashes
}

/**
 * Extract the longest leading path segment without wildcards.
 * e.g., "packages/core/src/GLOB" -> "packages/core/src"
 *       "packages/GLOB/src/GLOB" -> "packages"
 *       "GLOB"                   -> ""
 * (GLOB represents wildcard segments)
 */
function staticPrefix(glob: string): string {
  const parts = glob.split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (hasWildcardChar(part)) break;
    result.push(part);
  }
  return result.join('/');
}

/** Returns true if parent is the same as or an ancestor directory of child. */
function isParentOrEqual(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(`${parent}/`);
}

function hasWildcardChar(segment: string): boolean {
  return /[*?{[]/.test(segment);
}
