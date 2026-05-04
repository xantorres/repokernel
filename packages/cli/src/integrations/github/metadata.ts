import { readFile } from 'node:fs/promises';
import { type PrMetadata, PrMetadataSchema, RepoKernelError } from '@repokernel/core';
import matter from 'gray-matter';
import { withLock } from '../../lifecycle/locks.js';
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

/**
 * Persist PR metadata under sprint extras.pr atomically. The lock keys
 * on the sprint file path so two concurrent processes serialise their
 * read-modify-write sequence and neither side overwrites the other's
 * extras spread. Without this lock, two concurrent `rk pr {link, sync,
 * status}` invocations could each capture a stale `data.extras`
 * snapshot, mutate it, and lose each other's writes.
 */
export async function writePrMetadata(
  file: string,
  metadata: PrMetadata,
  opRoot: string,
): Promise<void> {
  // Lock name must be a single path segment — withLock builds
  // `<lockRoot>/<name>.lock` so `/` in the name would require nested
  // directories that the locks helper does not auto-create.
  await withLock(`pr-meta-${sanitiseLockKey(file)}`, opRoot, async () => {
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const existingExtras =
      data.extras && typeof data.extras === 'object'
        ? (data.extras as Record<string, unknown>)
        : {};
    const next = { ...existingExtras, pr: metadata };
    await mutateSprintFrontmatter(file, { extras: next });
  });
}

function sanitiseLockKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export type ProviderInference =
  | { readonly kind: 'known'; readonly provider: PrMetadata['provider'] }
  | { readonly kind: 'unknown'; readonly hostname: string };

/**
 * Map a PR URL to its provider. Returns an explicit `unknown` outcome
 * when the host isn't a recognised public PR provider so the caller can
 * surface a real error instead of silently mis-categorising self-hosted
 * GitLab Enterprise / Bitbucket Server URLs as `github`.
 */
export function inferProvider(prUrl: string): ProviderInference {
  let u: URL;
  try {
    u = new URL(prUrl);
  } catch {
    return { kind: 'unknown', hostname: '' };
  }
  if (u.hostname === 'github.com' || u.hostname.endsWith('.github.com')) {
    return { kind: 'known', provider: 'github' };
  }
  if (u.hostname === 'gitlab.com' || u.hostname.endsWith('.gitlab.com')) {
    return { kind: 'known', provider: 'gitlab' };
  }
  if (u.hostname === 'bitbucket.org' || u.hostname.endsWith('.bitbucket.org')) {
    return { kind: 'known', provider: 'bitbucket' };
  }
  return { kind: 'unknown', hostname: u.hostname };
}

export function extractGithubNumber(prUrl: string): number | undefined {
  const m = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl);
  if (!m || !m[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
