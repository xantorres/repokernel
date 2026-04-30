import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPathInEditor } from '../src/ux/open.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-open-'));
  tracked.push(dir);
  return dir;
}

describe('openPathInEditor (PR9 backfill)', () => {
  it('returns opened=false with a hint message when stdout is not a TTY', async () => {
    // Vitest workers run with stdout isTTY=false; rely on that as the
    // canonical non-interactive context.
    const cwd = await tmp();
    const file = join(cwd, 'sprint.md');
    await writeFile(file, '# sprint', 'utf8');
    const r = await openPathInEditor(cwd, file);
    expect(r.opened).toBe(false);
    expect(r.path).toBe(file);
    expect(r.message).toBe(`Open: ${file}`);
  });

  it('resolves a relative path against cwd', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'a.md'), 'x', 'utf8');
    const r = await openPathInEditor(cwd, 'a.md');
    expect(r.path).toBe(join(cwd, 'a.md'));
  });

  it('keeps an absolute path absolute', async () => {
    const cwd = await tmp();
    const abs = join(cwd, 'abs.md');
    await writeFile(abs, 'y', 'utf8');
    const r = await openPathInEditor(cwd, abs);
    expect(r.path).toBe(abs);
  });
});
