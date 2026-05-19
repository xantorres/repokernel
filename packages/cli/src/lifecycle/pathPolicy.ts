import { matchesGlob, type Sprint } from '@repokernel/core';

// Tracks malformed patterns already warned about; prevents per-file stderr spam.
const _warnedPatterns = new Set<string>();

export interface PathPolicyFailure {
  readonly code: 'DENIED_PATH' | 'OUT_OF_SCOPE_PATH';
  readonly message: string;
  readonly suggestion: string;
}

export function validateChangedFilesForSprint(
  sprint: Sprint,
  changedFiles: readonly string[],
  exemptPaths: readonly string[] = [],
): PathPolicyFailure | null {
  const filesToCheck =
    exemptPaths.length === 0
      ? changedFiles
      : changedFiles.filter((file) => !isExemptPath(file, exemptPaths));

  if (sprint.denied_paths.length > 0) {
    for (const file of filesToCheck) {
      if (matchesAnyPathPattern(file, sprint.denied_paths)) {
        return {
          code: 'DENIED_PATH',
          message: `${sprint.id} modified denied path: ${file}`,
          suggestion: 'revert changes to denied paths',
        };
      }
    }
  }

  if (sprint.allowed_paths.length > 0) {
    // Diff-paths is checked against `allowed_paths ∪ generated_paths`. A
    // sprint that touches `.repokernel/registry.json` (a declared
    // generated path) should not have to also list it under `allowed_paths`
    // — that would force users to widen the product scope just to satisfy
    // metadata writes. Production feedback item #5.
    const allowed =
      sprint.generated_paths.length === 0
        ? sprint.allowed_paths
        : [...sprint.allowed_paths, ...sprint.generated_paths];
    for (const file of filesToCheck) {
      if (!matchesAnyPathPattern(file, allowed)) {
        return {
          code: 'OUT_OF_SCOPE_PATH',
          message: `${file} is outside allowed_paths for ${sprint.id}`,
          suggestion: `revert changes to out-of-scope paths or update allowed_paths (current: ${sprint.allowed_paths.join(', ')}; generated_paths: ${sprint.generated_paths.length === 0 ? '(none)' : sprint.generated_paths.join(', ')})`,
        };
      }
    }
  }

  return null;
}

/**
 * Returns true only for exact lifecycle-authored metadata files that the caller
 * explicitly exempted. Broad plan-state directory exemptions are unsafe: a
 * sprint diff that edits reviews, other sprints, queues, or registry state
 * should fail path policy like any other out-of-scope file.
 */
function isExemptPath(file: string, exemptPaths: readonly string[]): boolean {
  const normalizedFile = file.replaceAll('\\', '/');
  return exemptPaths.some((p) => {
    const normalizedPath = p.replaceAll('\\', '/').replace(/\/$/, '');
    if (!normalizedPath) return false;
    return normalizedFile === normalizedPath;
  });
}

export function matchesAnyPathPattern(file: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    const pattern = p.replaceAll('\\', '/');
    const normalizedFile = file.replaceAll('\\', '/');
    if (!/[?*{[]/.test(pattern)) {
      const prefix = pattern.replace(/\/$/, '');
      return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
    }
    if (pattern.endsWith('/')) {
      const prefix = pattern.replace(/\/$/, '');
      return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
    }
    try {
      return matchesGlob(normalizedFile, pattern);
    } catch (e) {
      if (!_warnedPatterns.has(p)) {
        _warnedPatterns.add(p);
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `warning: path pattern ${JSON.stringify(p)} is invalid and will be ignored: ${msg}\n`,
        );
      }
      return false;
    }
  });
}
