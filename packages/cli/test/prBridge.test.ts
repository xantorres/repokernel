import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sprint } from '@repokernel/core';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractGithubNumber,
  inferProvider,
  readPrMetadata,
  renderPrBody,
  writePrMetadata,
} from '../src/integrations/github/index.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-pr-'));
  tracked.push(dir);
  return dir;
}

async function writeSprint(
  dir: string,
  id: string,
  frontmatter: Record<string, unknown>,
): Promise<string> {
  const sprintsDir = join(dir, 'sprints');
  await mkdir(sprintsDir, { recursive: true });
  const file = join(sprintsDir, `${id}.md`);
  await writeFile(file, matter.stringify('## Body\n', frontmatter), 'utf8');
  return file;
}

const sprint = (overrides: Partial<Sprint> = {}): Sprint => ({
  id: 'S-1',
  title: 'Build feature',
  epic_id: 'E-001',
  status: 'planned',
  lane: 'core',
  depends_on: [],
  blocked_by: [],
  allowed_paths: ['src/**'],
  denied_paths: [],
  generated_paths: [],
  review_required: true,
  adr_links: [],
  extras: {},
  file: 'sprints/S-1.md',
  body: 'Sprint body content',
  ...overrides,
});

describe('renderPrBody', () => {
  it('produces deterministic output for the same sprint', () => {
    const a = renderPrBody({ sprint: sprint() });
    const b = renderPrBody({ sprint: sprint() });
    expect(a).toBe(b);
  });

  it('includes sprint metadata and checklist', () => {
    const body = renderPrBody({ sprint: sprint(), agentSummary: 'Tests pass.' });
    expect(body).toContain('**Sprint:** S-1');
    expect(body).toContain('**Lane:** core');
    expect(body).toContain('Tests pass.');
    expect(body).toContain('- [ ] Tests passing');
  });
});

describe('inferProvider', () => {
  it('detects GitHub URLs', () => {
    expect(inferProvider('https://github.com/foo/bar/pull/1')).toEqual({
      kind: 'known',
      provider: 'github',
    });
  });

  it('detects GitLab URLs', () => {
    expect(inferProvider('https://gitlab.com/foo/bar/-/merge_requests/1')).toEqual({
      kind: 'known',
      provider: 'gitlab',
    });
  });

  it('returns unknown for unrecognised hosts', () => {
    expect(inferProvider('https://example.com/foo')).toEqual({
      kind: 'unknown',
      hostname: 'example.com',
    });
  });

  it('returns unknown for unparseable URLs', () => {
    expect(inferProvider('not-a-url')).toEqual({ kind: 'unknown', hostname: '' });
  });
});

describe('extractGithubNumber', () => {
  it('parses /pull/N from a GitHub URL', () => {
    expect(extractGithubNumber('https://github.com/foo/bar/pull/42')).toBe(42);
  });
  it('returns undefined when no number is present', () => {
    expect(extractGithubNumber('https://github.com/foo/bar')).toBeUndefined();
  });
});

describe('PR metadata persistence', () => {
  it('returns null when metadata is absent', async () => {
    const dir = await tmp();
    const file = await writeSprint(dir, 'S-1', {
      id: 'S-1',
      title: 'x',
      epic_id: 'E-001',
      status: 'planned',
      lane: 'core',
    });
    expect(await readPrMetadata(file)).toBeNull();
  });

  it('writes metadata under extras.pr and preserves siblings', async () => {
    const dir = await tmp();
    const file = await writeSprint(dir, 'S-1', {
      id: 'S-1',
      title: 'x',
      epic_id: 'E-001',
      status: 'planned',
      lane: 'core',
      extras: {
        tracker: {
          provider: 'gh',
          issue_id: 'a/b#1',
          sync_at: '2026-04-25T10:00:00.000Z',
          synced_fields: [],
        },
      },
    });
    const opRoot = join(dir, '.git', 'repokernel');
    await mkdir(opRoot, { recursive: true });
    await writePrMetadata(
      file,
      {
        provider: 'github',
        url: 'https://github.com/foo/bar/pull/1',
        number: 1,
        status: 'open',
        last_sync_at: '2026-04-25T10:00:00.000Z',
      },
      opRoot,
    );
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw);
    const extras = (parsed.data as { extras: Record<string, unknown> }).extras;
    expect(extras.tracker).toBeDefined();
    expect(extras.pr).toBeDefined();
  });
});
