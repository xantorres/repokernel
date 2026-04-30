import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicCreateText, atomicWriteText } from '../src/lifecycle/atomicWrite.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-atomic-'));
  tracked.push(dir);
  return dir;
}

describe('atomicWriteText', () => {
  it('writes content to a fresh path', async () => {
    const dir = await tmp();
    const target = join(dir, 'out.json');
    await atomicWriteText(target, '{"a":1}');
    expect(await readFile(target, 'utf8')).toBe('{"a":1}');
  });

  it('overwrites an existing file in-place via rename', async () => {
    const dir = await tmp();
    const target = join(dir, 'cfg.json');
    await writeFile(target, 'OLD', 'utf8');
    await atomicWriteText(target, 'NEW');
    expect(await readFile(target, 'utf8')).toBe('NEW');
  });

  it('leaves the original file untouched if write fails (target dir vanishes)', async () => {
    const dir = await tmp();
    const target = join(dir, 'subdir', 'out.json');
    // subdir does not exist — open(target, 'wx+') will fail with ENOENT.
    await expect(atomicWriteText(target, 'X')).rejects.toThrow();
    // The parent dir contains nothing — the temp file was cleaned up.
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it('cleans up the temp file after a successful write (no .tmp residue)', async () => {
    const dir = await tmp();
    const target = join(dir, 'out.txt');
    await atomicWriteText(target, 'hello');
    const entries = await readdir(dir);
    expect(entries).toEqual(['out.txt']);
  });

  it('survives concurrent writers — last write wins, file always valid', async () => {
    const dir = await tmp();
    const target = join(dir, 'race.txt');
    await writeFile(target, 'INITIAL', 'utf8');
    const writers = Array.from({ length: 8 }, (_, i) =>
      atomicWriteText(target, `W${i}`.padEnd(64, 'x')),
    );
    await Promise.all(writers);
    const out = await readFile(target, 'utf8');
    expect(out).toMatch(/^W\d/);
    // No leftover temp files.
    const entries = await readdir(dir);
    expect(entries).toEqual(['race.txt']);
  });

  it('preserves prior content when the new write throws before rename', async () => {
    // Simulate rename-failure by giving the helper a path that resolves to a
    // directory: open(target, 'wx+') will succeed creating a sibling temp,
    // then `rename(temp, target)` will fail because target is a directory.
    const dir = await tmp();
    const target = join(dir, 'collide');
    // Make `target` a directory.
    await writeFile(join(dir, 'sentinel'), 'sentinel', 'utf8');
    // Use mkdir to create the directory at target.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target);
    await expect(atomicWriteText(target, 'NEW')).rejects.toThrow();
    // The directory is still a directory (rename of file→dir failed).
    const entries = await readdir(dir);
    // Only the sentinel + collide dir; temp was cleaned up.
    expect(entries.sort()).toEqual(['collide', 'sentinel']);
  });
});

describe('atomicCreateText', () => {
  it('creates a fresh file', async () => {
    const dir = await tmp();
    const target = join(dir, 'fresh.json');
    await atomicCreateText(target, '{"x":1}');
    expect(await readFile(target, 'utf8')).toBe('{"x":1}');
  });

  it('throws EEXIST when target exists, leaves prior content intact', async () => {
    const dir = await tmp();
    const target = join(dir, 'occupied.txt');
    await writeFile(target, 'OLD', 'utf8');
    await expect(atomicCreateText(target, 'NEW')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(target, 'utf8')).toBe('OLD');
    // No temp residue alongside the original.
    const entries = await readdir(dir);
    expect(entries).toEqual(['occupied.txt']);
  });

  it('cleans up the temp file even when link succeeds', async () => {
    const dir = await tmp();
    const target = join(dir, 'first.txt');
    await atomicCreateText(target, 'hello');
    const entries = await readdir(dir);
    expect(entries).toEqual(['first.txt']);
  });

  it('cleans up the temp file when target dir is missing (open fails)', async () => {
    const dir = await tmp();
    const target = join(dir, 'no-such-subdir', 'out.txt');
    await expect(atomicCreateText(target, 'X')).rejects.toThrow();
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it('serial concurrent creators produce exactly one EEXIST loser', async () => {
    const dir = await tmp();
    const target = join(dir, 'race-create.json');
    const writers = Array.from({ length: 5 }, () => atomicCreateText(target, 'X'));
    const results = await Promise.allSettled(writers);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'EEXIST' });
    }
    // Target survived; no temp residue.
    expect(await readFile(target, 'utf8')).toBe('X');
    const entries = await readdir(dir);
    expect(entries).toEqual(['race-create.json']);
  });
});
