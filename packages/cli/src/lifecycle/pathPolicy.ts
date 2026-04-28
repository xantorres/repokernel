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
): PathPolicyFailure | null {
  if (sprint.denied_paths.length > 0) {
    for (const file of changedFiles) {
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
    for (const file of changedFiles) {
      if (!matchesAnyPathPattern(file, sprint.allowed_paths)) {
        return {
          code: 'OUT_OF_SCOPE_PATH',
          message: `${file} is outside allowed_paths for ${sprint.id}`,
          suggestion: 'revert changes to out-of-scope paths or update allowed_paths',
        };
      }
    }
  }

  return null;
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
