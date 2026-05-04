import { readFile } from 'node:fs/promises';
import { type PrMetadata, PrMetadataSchema, RepoKernelError } from '@repokernel/core';
import matter from 'gray-matter';
import { mutateSprintFrontmatter } from '../../lifecycle/mutate.js';

/**
 * Persistence for the PR bridge — mirrors the tracker bridge layout. PR
 * metadata lives under sprint frontmatter `extras.pr`; the canonical
 * sprint schema is unchanged so PR-aware sprints remain valid input to
 * older `rk` builds.
 */

export async function readPrMetadata(file: string): Promise<PrMetadata | null> {
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const extras = (parsed.data as Record<string, unknown>).extras;
  if (!extras || typeof extras !== 'object') return null;
  const pr = (extras as Record<string, unknown>).pr;
  if (!pr || typeof pr !== 'object') return null;
  const result = PrMetadataSchema.safeParse(pr);
  if (!result.success) {
    throw new RepoKernelError(
      'INVALID_FRONTMATTER',
      `pr metadata in ${file} is malformed: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

export async function writePrMetadata(file: string, metadata: PrMetadata): Promise<void> {
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const existingExtras = (
    data.extras && typeof data.extras === 'object' ? (data.extras as Record<string, unknown>) : {}
  ) as Record<string, unknown>;
  const next = { ...existingExtras, pr: metadata };
  await mutateSprintFrontmatter(file, { extras: next });
}

export function inferProvider(prUrl: string): PrMetadata['provider'] {
  try {
    const u = new URL(prUrl);
    if (u.hostname === 'github.com' || u.hostname.endsWith('.github.com')) return 'github';
    if (u.hostname === 'gitlab.com' || u.hostname.endsWith('.gitlab.com')) return 'gitlab';
    if (u.hostname === 'bitbucket.org' || u.hostname.endsWith('.bitbucket.org')) return 'bitbucket';
  } catch {
    // fall through
  }
  return 'github';
}

export function extractGithubNumber(prUrl: string): number | undefined {
  const m = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl);
  if (!m || !m[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
