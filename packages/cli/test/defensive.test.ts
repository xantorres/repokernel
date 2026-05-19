import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePorcelainV1Z } from '../src/lifecycle/gitPorcelain.js';
import { acquireLock } from '../src/lifecycle/locks.js';

describe('parsePorcelainV1Z (NUL-delimited, rename-aware)', () => {
  it('parses simple entries', () => {
    const raw = ' M src/foo.ts\0?? new file.ts\0';
    const entries = parsePorcelainV1Z(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ indexCode: ' ', workCode: 'M', path: 'src/foo.ts' });
    expect(entries[1]).toMatchObject({ indexCode: '?', workCode: '?', path: 'new file.ts' });
  });

  it('handles renames with from + path tokens (porcelain=v1 -z shape: "R  new\\0old\\0")', () => {
    const raw = 'R  dst/new\0src/old\0';
    const entries = parsePorcelainV1Z(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      indexCode: 'R',
      workCode: ' ',
      path: 'dst/new',
      from: 'src/old',
    });
  });

  it('preserves filenames containing newlines and quotes (the whole point of -z)', () => {
    const raw = 'A  file with\nnewline.ts\0?? "quoted".ts\0';
    const entries = parsePorcelainV1Z(raw);
    expect(entries[0]?.path).toBe('file with\nnewline.ts');
    expect(entries[1]?.path).toBe('"quoted".ts');
  });
});

describe('lock nonce semantics', () => {
  it('release-by-mismatched-nonce does not delete a lock owned by a different acquirer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rk-locknonce-'));
    mkdirSync(join(dir, 'locks'), { recursive: true });

    // Acquire A → release-handle A
    const releaseA = await acquireLock('demo', dir);
    // Release A → lock gone; acquirer B succeeds.
    await releaseA();
    const releaseB = await acquireLock('demo', dir);
    // Now calling releaseA() again must be a no-op (its nonce no longer
    // matches the on-disk lock; B owns it).
    await releaseA();
    expect(existsSync(join(dir, 'locks', 'demo.lock'))).toBe(true);
    // B's own release closes the lock cleanly.
    await releaseB();
    expect(existsSync(join(dir, 'locks', 'demo.lock'))).toBe(false);
  });
});
