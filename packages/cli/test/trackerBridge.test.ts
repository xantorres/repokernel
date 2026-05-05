import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeInitialMetadata,
  readTrackerMetadata,
  stampSync,
  writeTrackerMetadata,
} from '../src/integrations/tracker/index.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-tracker-'));
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
  const body = '## Sprint body\n';
  await writeFile(file, matter.stringify(body, frontmatter), 'utf8');
  return file;
}

const baseSprint = (id: string) => ({
  id,
  title: `Sprint ${id}`,
  epic_id: 'E-001',
  status: 'planned',
  lane: 'core',
});

describe('tracker metadata', () => {
  it('returns null when no metadata is present', async () => {
    const dir = await tmp();
    const file = await writeSprint(dir, 'S-1', baseSprint('S-1'));
    expect(await readTrackerMetadata(file)).toBeNull();
  });

  it('writes and reads metadata under extras.tracker', async () => {
    const dir = await tmp();
    const file = await writeSprint(dir, 'S-1', baseSprint('S-1'));
    const opRoot = join(dir, '.git', 'repokernel');
    await mkdir(opRoot, { recursive: true });
    const meta = makeInitialMetadata({
      provider: 'linear',
      issueId: 'RK-42',
      issueUrl: 'https://linear.app/issue/RK-42',
      now: () => new Date('2026-04-25T10:00:00.000Z'),
    });
    await writeTrackerMetadata(file, meta, opRoot);
    const read = await readTrackerMetadata(file);
    expect(read).toEqual(meta);
  });

  it('preserves other extras keys when writing', async () => {
    const dir = await tmp();
    const file = await writeSprint(dir, 'S-1', {
      ...baseSprint('S-1'),
      extras: { chained_epic: 'E-007' },
    });
    const opRoot = join(dir, '.git', 'repokernel');
    await mkdir(opRoot, { recursive: true });
    const meta = makeInitialMetadata({
      provider: 'gh',
      issueId: 'owner/repo#42',
      now: () => new Date('2026-04-25T10:00:00.000Z'),
    });
    await writeTrackerMetadata(file, meta, opRoot);
    const raw = await readFile(file, 'utf8');
    const parsed = matter(raw);
    expect((parsed.data as { extras: { chained_epic: string } }).extras.chained_epic).toBe('E-007');
  });

  it('throws when extras.tracker is malformed', async () => {
    const dir = await tmp();
    const file = await writeSprint(dir, 'S-1', {
      ...baseSprint('S-1'),
      extras: { tracker: { provider: 'unknown' } },
    });
    await expect(readTrackerMetadata(file)).rejects.toThrow();
  });

  it('stampSync deduplicates synced_fields and updates sync_at', () => {
    const meta = makeInitialMetadata({
      provider: 'linear',
      issueId: 'RK-42',
      now: () => new Date('2026-04-25T10:00:00.000Z'),
    });
    const after = stampSync(meta, 'comment', () => new Date('2026-04-25T11:00:00.000Z'));
    expect(after.synced_fields).toEqual(['comment']);
    expect(after.sync_at).toBe('2026-04-25T11:00:00.000Z');
    const next = stampSync(after, 'comment', () => new Date('2026-04-25T12:00:00.000Z'));
    expect(next.synced_fields).toEqual(['comment']);
    expect(next.sync_at).toBe('2026-04-25T12:00:00.000Z');
  });
});
