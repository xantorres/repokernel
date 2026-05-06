import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrackerLinkCommand } from '../src/commands/tracker.js';
import { EXIT_USAGE } from '../src/exitCodes.js';
import {
  makeInitialMetadata,
  readTrackerMetadata,
  stampSync,
  writeTrackerMetadata,
} from '../src/integrations/tracker/index.js';

const execFileAsync = promisify(execFile);

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

async function fixtureProject(dir: string): Promise<void> {
  await mkdir(join(dir, 'epics'), { recursive: true });
  await writeFile(
    join(dir, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: demo
projectName: demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
    'utf8',
  );
  await writeFile(
    join(dir, 'epics', 'E-001.md'),
    matter.stringify('', {
      id: 'E-001',
      title: 'Epic',
      status: 'active',
    }),
    'utf8',
  );
  await writeSprint(dir, 'S-1', baseSprint('S-1'));
  await execFileAsync('git', ['init', '-q', '-b', 'main', dir]);
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

  it('rejects malformed provider refs at the command boundary', async () => {
    const dir = await tmp();
    await fixtureProject(dir);

    const result = await runTrackerLinkCommand({
      cwd: dir,
      sprintId: 'S-1',
      provider: 'gh',
      issueId: 'not-a-gh-ref',
      json: false,
    });

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('owner/repo#NNN');

    const read = await readTrackerMetadata(join(dir, 'sprints', 'S-1.md'));
    expect(read).toBeNull();
  });

  it('rejects invalid issue URLs before writing tracker metadata', async () => {
    const dir = await tmp();
    await fixtureProject(dir);

    const result = await runTrackerLinkCommand({
      cwd: dir,
      sprintId: 'S-1',
      provider: 'linear',
      issueId: 'RK-42',
      issueUrl: 'not-a-url',
      json: false,
    });

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('invalid issue URL');

    const read = await readTrackerMetadata(join(dir, 'sprints', 'S-1.md'));
    expect(read).toBeNull();
  });

  it('rejects unsupported URL schemes (file://, javascript:) with EXIT_USAGE', async () => {
    const dir = await tmp();
    await fixtureProject(dir);
    const result = await runTrackerLinkCommand({
      cwd: dir,
      sprintId: 'S-1',
      provider: 'linear',
      issueId: 'RK-42',
      issueUrl: 'file:///etc/passwd',
      json: false,
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('http(s)');
  });

  it('returns EXIT_USAGE for invalid provider (symmetric with invalid issueId)', async () => {
    const dir = await tmp();
    await fixtureProject(dir);
    const result = await runTrackerLinkCommand({
      cwd: dir,
      sprintId: 'S-1',
      provider: 'bogus',
      issueId: 'RK-42',
      json: false,
    });
    // Both invalid-provider and invalid-issueId are user-input failures and
    // should return the same exit code so wrapper scripts can branch reliably.
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('bogus');
  });
});
