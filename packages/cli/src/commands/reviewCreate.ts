import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, RepoKernelError, SPRINT_ID_RE, type SprintId } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { allocateReviewIds } from '../lifecycle/reviewAlloc.js';
import type { CommandResult } from './validate.js';

export interface ReviewCreateOptions {
  readonly cwd: string;
  readonly sprintId: string;
  readonly json: boolean;
}

function buildRichScaffold(reviewId: string, sprintId: string): string {
  const now = new Date().toISOString();
  return `---
id: ${reviewId}
sprint_id: ${sprintId}
verdict: pending
reviewer: agent
findings: []
created_at: ${now}
changed_files: []
paths_checked:
  denied_paths_clean: true
---

# ${reviewId}: Review ${sprintId}

## Summary

<!-- Brief description of what was reviewed and the overall assessment. -->

## Findings

<!-- Add individual findings below. Format:
- severity: CRITICAL | HIGH | MEDIUM | LOW
  message: "Description of the issue"
-->

## Verdict

<!-- Set the \`verdict\` frontmatter field to one of:
  accepted           - review passed, sprint can ship
  changes_requested  - issues found, needs rework
  rejected           - major issues, sprint must not proceed
-->
`;
}

export async function runReviewCreateCommand(opts: ReviewCreateOptions): Promise<CommandResult> {
  if (!SPRINT_ID_RE.test(opts.sprintId)) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `review-create: invalid sprint id "${opts.sprintId}" (expected S-NNN)\n`,
    };
  }

  const cwd = resolve(opts.cwd);

  let configResult: Awaited<ReturnType<typeof loadConfig>>;
  try {
    configResult = await loadConfig({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!configResult.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml is invalid; run rk validate for details\n',
    };
  }

  const reviewsDir = join(configResult.cwd, configResult.config.paths.reviews);
  const opRoot = await operationalRootBestEffort(configResult.cwd);

  const allocations = await allocateReviewIds([opts.sprintId as SprintId], reviewsDir, opRoot);

  const alloc = allocations.get(opts.sprintId as SprintId);
  if (!alloc) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `review-create: allocation failed for ${opts.sprintId}\n`,
    };
  }

  const reviewId = alloc.reviewId;
  const filePath = join(reviewsDir, `${reviewId}.md`);

  if (!alloc.reused) {
    await writeFile(filePath, buildRichScaffold(reviewId, opts.sprintId), 'utf8');
  }

  const relPath = filePath.startsWith(configResult.cwd)
    ? filePath.slice(configResult.cwd.length).replace(/^\//, '')
    : filePath;

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ reviewId, sprintId: opts.sprintId, file: relPath, reused: alloc.reused }),
      stderr: '',
    };
  }

  const action = alloc.reused ? 'Found existing' : 'Created';
  return {
    exitCode: EXIT_OK,
    stdout: `${action} ${reviewId} for ${opts.sprintId}\n  ${relPath}\n`,
    stderr: '',
  };
}
