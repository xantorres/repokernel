import type { Sprint } from '@repokernel/core';

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
    if (p.endsWith('/**') || p.endsWith('/')) {
      const prefix = p.replace(/\/\*\*$/, '').replace(/\/$/, '');
      return file === prefix || file.startsWith(`${prefix}/`);
    }
    if (p.endsWith('/*')) {
      const dir = p.slice(0, -2);
      return file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/');
    }
    return file === p || file.startsWith(`${p}/`);
  });
}
