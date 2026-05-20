import { type Config, matchesGlob, type Sprint } from '@repokernel/core';

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
  effectivePolicy?: EffectiveSprintPathPolicy,
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
    const allowed = effectivePolicy?.allowed ?? effectiveAllowedPathsForSprint(sprint);
    for (const file of filesToCheck) {
      if (!matchesAnyPathPattern(file, allowed)) {
        return {
          code: 'OUT_OF_SCOPE_PATH',
          message: `${file} is outside allowed_paths for ${sprint.id}`,
          suggestion: `revert changes to out-of-scope paths or update allowed_paths (current: ${sprint.allowed_paths.join(', ')}; generated_paths: ${effectiveGeneratedPathsForSprint(sprint, effectivePolicy).join(', ') || '(none)'})`,
        };
      }
    }
  }

  return null;
}

export interface EffectiveSprintPathPolicy {
  readonly allowed: readonly string[];
  readonly generated: readonly string[];
}

export function effectivePathPolicyForSprint(args: {
  readonly config: Config;
  readonly sprint: Sprint;
  readonly reviewFile?: string;
}): EffectiveSprintPathPolicy {
  const generated = safeGeneratedPaths(args.config, [
    ...args.sprint.generated_paths,
    ...(args.reviewFile !== undefined ? [args.reviewFile] : []),
  ]);
  return {
    generated: uniq(generated),
    allowed: effectiveAllowedPathsForSprint(args.sprint, generated),
  };
}

export function normalizeGeneratedPathsForSprint(args: {
  readonly config: Config;
  readonly sprint: Sprint;
  readonly reviewFile?: string;
}): readonly string[] {
  return safeGeneratedPaths(args.config, [
    ...args.sprint.generated_paths,
    ...(args.reviewFile !== undefined ? [args.reviewFile] : []),
  ]);
}

export function inferredTestPathsForAllowedPath(path: string): readonly string[] {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  const exact = /^(.*)\.(ts|tsx|js|jsx|mjs|cjs)$/u.exec(normalized);
  if (exact?.[1] !== undefined && exact[2] !== undefined) {
    const stem = exact[1];
    const ext = exact[2];
    return [`${stem}.test.${ext}`, `${stem}.spec.${ext}`];
  }
  if (normalized.endsWith('/**')) {
    const base = normalized.slice(0, -3).replace(/\/$/, '');
    return testGlobSet(base);
  }
  if (!/[?*{[]/u.test(normalized)) {
    return testGlobSet(normalized);
  }
  return [];
}

function testGlobSet(base: string): readonly string[] {
  return [
    `${base}/**/*.test.ts`,
    `${base}/**/*.test.tsx`,
    `${base}/**/*.test.js`,
    `${base}/**/*.test.jsx`,
    `${base}/**/*.spec.ts`,
    `${base}/**/*.spec.tsx`,
    `${base}/**/*.spec.js`,
    `${base}/**/*.spec.jsx`,
  ];
}

function effectiveAllowedPathsForSprint(
  sprint: Sprint,
  generated: readonly string[] = sprint.generated_paths,
): readonly string[] {
  return uniq([
    ...sprint.allowed_paths,
    ...sprint.allowed_paths.flatMap(inferredTestPathsForAllowedPath),
    ...generated,
  ]);
}

function effectiveGeneratedPathsForSprint(
  sprint: Sprint,
  policy?: EffectiveSprintPathPolicy,
): readonly string[] {
  return policy?.generated ?? sprint.generated_paths;
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function safeGeneratedPaths(config: Config, paths: readonly string[]): readonly string[] {
  return uniq(paths).filter((path) => !isRepoKernelControlPath(config, path));
}

function isRepoKernelControlPath(config: Config, path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.?\//, '');
  const registry = config.paths.registry.replaceAll('\\', '/').replace(/^\.?\//, '');
  const queues = config.paths.queues.replaceAll('\\', '/').replace(/^\.?\//, '');
  const lanes = config.paths.lanes.replaceAll('\\', '/').replace(/^\.?\//, '');
  const sprints = config.paths.sprints.replaceAll('\\', '/').replace(/^\.?\//, '');
  const reviews = config.paths.reviews.replaceAll('\\', '/').replace(/^\.?\//, '');
  if (normalized === registry) return true;
  if (normalized === queues || normalized.startsWith(`${queues}/`)) return true;
  if (normalized === lanes || normalized.startsWith(`${lanes}/`)) return true;
  if (normalized === sprints || normalized.startsWith(`${sprints}/`)) return true;
  if (normalized === reviews || normalized.startsWith(`${reviews}/`)) return true;
  return false;
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
