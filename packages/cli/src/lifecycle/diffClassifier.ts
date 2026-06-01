import type { Config, Sprint } from '@repokernel/core';
import type { SprintChangedFiles } from './git.js';
import {
  type EffectiveSprintPathPolicy,
  effectivePathPolicyForSprint,
  matchesAnyPathPattern,
} from './pathPolicy.js';

export type SprintDiffCategory =
  | 'in_scope'
  | 'out_of_scope_committed'
  | 'external_dirty'
  | 'generated'
  | 'rk_owned';

export type SprintDiffSource = 'committed' | 'staged' | 'unstaged' | 'untracked';

export interface SprintDiffEntry {
  readonly path: string;
  readonly category: SprintDiffCategory;
  readonly sources: readonly SprintDiffSource[];
}

export interface SprintBlocker {
  readonly category: string;
  readonly scope: 'sprint' | 'workspace' | 'environment';
  readonly paths: readonly string[];
  readonly owner: 'sprint' | 'workspace' | 'environment' | 'unknown';
  readonly next_actions: readonly string[];
}

export interface SprintDiffClassification {
  readonly entries: readonly SprintDiffEntry[];
  readonly blockers: readonly SprintBlocker[];
  readonly warnings: readonly SprintBlocker[];
}

export interface SprintDiffClassifierOptions {
  readonly config: Config;
  readonly sprint: Sprint;
  readonly changed: SprintChangedFiles;
  readonly exemptPaths?: readonly string[];
  readonly effectivePolicy?: EffectiveSprintPathPolicy;
  readonly rkOwnedGlobs?: readonly string[];
  readonly reviewFile?: string;
}

export function classifySprintDiff(opts: SprintDiffClassifierOptions): SprintDiffClassification {
  const policy =
    opts.effectivePolicy ??
    effectivePathPolicyForSprint({
      config: opts.config,
      sprint: opts.sprint,
      ...(opts.reviewFile !== undefined ? { reviewFile: opts.reviewFile } : {}),
    });
  const entries: SprintDiffEntry[] = [];
  const blockerPaths: string[] = [];
  const deniedBlockerPaths: string[] = [];
  const warningPaths: string[] = [];

  for (const path of opts.changed.files) {
    const sources = sourcesForPath(path, opts.changed);
    const denied = matchesAnyPathPattern(path, opts.sprint.denied_paths);
    const category = classifyPath({
      path,
      sources,
      sprint: opts.sprint,
      policy,
      exemptPaths: opts.exemptPaths ?? [],
      rkOwnedGlobs: opts.rkOwnedGlobs ?? [],
    });
    entries.push({ path, category, sources });
    if (category === 'out_of_scope_committed') {
      if (denied) deniedBlockerPaths.push(path);
      else blockerPaths.push(path);
    }
    if (category === 'external_dirty') warningPaths.push(path);
  }

  return {
    entries,
    blockers: [
      ...(deniedBlockerPaths.length > 0
        ? [
            blocker({
              category: 'denied_path',
              paths: deniedBlockerPaths,
              sprintId: opts.sprint.id,
            }),
          ]
        : []),
      ...(blockerPaths.length > 0
        ? [
            blocker({
              category: 'out_of_scope_committed',
              paths: blockerPaths,
              sprintId: opts.sprint.id,
            }),
          ]
        : []),
    ],
    warnings:
      warningPaths.length > 0
        ? [
            {
              category: 'external_dirty',
              scope: 'workspace',
              paths: warningPaths,
              owner: 'workspace',
              next_actions: ['git status --short', `rk blockers ${opts.sprint.id} --json`],
            },
          ]
        : [],
  };
}

/** Sprint-scoped paths that still carry uncommitted (staged/unstaged/untracked) edits. */
export function uncommittedInScopePaths(classification: SprintDiffClassification): string[] {
  return classification.entries
    .filter(
      (entry) =>
        entry.category === 'in_scope' && entry.sources.some((source) => source !== 'committed'),
    )
    .map((entry) => entry.path);
}

function blocker(input: {
  readonly category: string;
  readonly paths: readonly string[];
  readonly sprintId: string;
}): SprintBlocker {
  return {
    category: input.category,
    scope: 'sprint',
    paths: input.paths,
    owner: 'sprint',
    next_actions: [`rk inspect ${input.sprintId}`, `rk blockers ${input.sprintId} --json`],
  };
}

function classifyPath(input: {
  readonly path: string;
  readonly sources: readonly SprintDiffSource[];
  readonly sprint: Sprint;
  readonly policy: EffectiveSprintPathPolicy;
  readonly exemptPaths: readonly string[];
  readonly rkOwnedGlobs: readonly string[];
}): SprintDiffCategory {
  if (input.sprint.denied_paths.length > 0) {
    if (matchesAnyPathPattern(input.path, input.sprint.denied_paths)) {
      return input.sources.includes('committed') ? 'out_of_scope_committed' : 'external_dirty';
    }
  }
  if (isRkOwnedPath(input.path, input.exemptPaths, input.rkOwnedGlobs)) return 'rk_owned';
  if (matchesAnyPathPattern(input.path, input.policy.generated)) return 'generated';
  if (input.sprint.allowed_paths.length === 0) return 'in_scope';
  if (matchesAnyPathPattern(input.path, input.policy.allowed)) return 'in_scope';
  return input.sources.includes('committed') ? 'out_of_scope_committed' : 'external_dirty';
}

function sourcesForPath(path: string, changed: SprintChangedFiles): readonly SprintDiffSource[] {
  const sources: SprintDiffSource[] = [];
  if (changed.committed.includes(path)) sources.push('committed');
  if (changed.staged.includes(path)) sources.push('staged');
  if (changed.unstaged.includes(path)) sources.push('unstaged');
  if (changed.untracked.includes(path)) sources.push('untracked');
  return sources;
}

function isRkOwnedPath(
  path: string,
  exemptPaths: readonly string[],
  rkOwnedGlobs: readonly string[],
): boolean {
  return matchesExactPath(path, exemptPaths) || matchesAnyPathPattern(path, rkOwnedGlobs);
}

function matchesExactPath(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replaceAll('\\', '/');
  return patterns.some(
    (pattern) => normalized === pattern.replaceAll('\\', '/').replace(/\/$/, ''),
  );
}
