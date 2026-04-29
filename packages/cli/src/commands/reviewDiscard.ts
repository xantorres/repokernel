import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, REVIEW_ID_RE, RepoKernelError } from '@repokernel/core';
import matter from 'gray-matter';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export interface ReviewDiscardOptions {
  readonly cwd: string;
  readonly json: boolean;
}

/**
 * Discard a `verdict: pending` review stub. Deletes the file so the counter
 * slot no longer blocks future reviews. Rejects if the review has already
 * received a verdict — discarding reviewed sprints is unsafe and should use
 * `rk reopen` instead.
 */
export async function runReviewDiscardCommand(
  reviewId: string,
  opts: ReviewDiscardOptions,
): Promise<CommandResult> {
  if (!REVIEW_ID_RE.test(reviewId)) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `review discard: "${reviewId}" is not a valid review id (expected R-NNN)\n`,
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

  const filePath = join(configResult.cwd, configResult.config.paths.reviews, `${reviewId}.md`);

  let raw: string;
  try {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr: `review discard: ${reviewId} not found\n`,
      };
    }
    throw cause;
  }

  let verdict: string | undefined;
  try {
    const data = matter(raw).data as Record<string, unknown>;
    verdict = typeof data.verdict === 'string' ? data.verdict : undefined;
  } catch {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `review discard: failed to parse frontmatter in ${reviewId}.md\n`,
    };
  }

  if (verdict !== 'pending') {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `review discard: ${reviewId} has verdict "${verdict ?? '(unset)'}" — only pending stubs can be discarded\n  → use rk reopen to revisit a completed review\n`,
    };
  }

  await unlink(filePath);

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify({ reviewId, discarded: true })}\n`,
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: `Discarded ${reviewId} (pending stub deleted)\n`,
    stderr: '',
  };
}
