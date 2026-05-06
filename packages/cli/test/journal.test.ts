import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockRoot } from '../src/lifecycle/controlPaths.js';
import {
  classifyJournal,
  currentJournalContext,
  gcJournals,
  journalAtomicCreate,
  journalDelete,
  journalInvalidate,
  journalWrite,
  listPendingJournals,
  nextOpId,
  scanAndHealJournals,
  sha256Buffer,
  withJournal,
} from '../src/lifecycle/journal.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(
    tracked.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function tmpOpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rk-journal-'));
  tracked.push(root);
  return root;
}

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-journal-target-'));
  tracked.push(dir);
  return dir;
}

describe('nextOpId', () => {
  it('produces 26-char ULIDs prefixed with OP-', () => {
    const id = nextOpId();
    expect(id).toMatch(/^OP-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is monotonically increasing across calls', () => {
    const ids = Array.from({ length: 50 }, () => nextOpId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe('withJournal — outermost', () => {
  it('writes pending.json before fn runs and renames to done.json on success', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'a.txt');
    let pendingSeen: string | null = null;

    await withJournal(opRoot, 'next-sync', { lane: 'main' }, async (j) => {
      const dir = join(opRoot, 'journal');
      const entries = await readdir(dir);
      const p = entries.find((e) => e.endsWith('.pending.json'));
      pendingSeen = p ?? null;
      await journalWrite(j, file, 'hello');
    });

    expect(pendingSeen).not.toBeNull();
    const dir = join(opRoot, 'journal');
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.endsWith('.pending.json'))).toEqual([]);
    expect(entries.filter((e) => e.endsWith('.done.json'))).toHaveLength(1);
  });

  it('leaves pending.json on disk if fn throws', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'a.txt');
    await expect(
      withJournal(opRoot, 'next-sync', {}, async (j) => {
        await journalWrite(j, file, 'partial');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const entries = await readdir(join(opRoot, 'journal'));
    expect(entries.filter((e) => e.endsWith('.pending.json'))).toHaveLength(1);
    expect(entries.filter((e) => e.endsWith('.done.json'))).toEqual([]);
  });

  it('records opId, command, args, schemaVersion in envelope', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    await withJournal(opRoot, 'sprint-extras', { sprintId: 'S-001' }, async (j) => {
      await journalWrite(j, join(target, 'x'), 'x');
    });
    const dir = join(opRoot, 'journal');
    const done = (await readdir(dir)).find((f) => f.endsWith('.done.json'));
    expect(done).toBeDefined();
    const env = JSON.parse(await readFile(join(dir, done as string), 'utf8'));
    expect(env.command).toBe('sprint-extras');
    expect(env.args).toEqual({ sprintId: 'S-001' });
    expect(env.schemaVersion).toBe(1);
    expect(env.opId).toMatch(/^OP-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.completedAt).not.toBeNull();
  });
});

describe('withJournal — nested cooperation', () => {
  it('reuses outer context when same opRoot — produces ONE journal file', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const a = join(target, 'a.txt');
    const b = join(target, 'b.txt');

    await withJournal(opRoot, 'run-step', {}, async () => {
      await withJournal(opRoot, 'lane-claim', {}, async (inner) => {
        await journalWrite(inner, a, 'A');
      });
      await withJournal(opRoot, 'registry-refresh', {}, async (inner) => {
        await journalWrite(inner, b, 'B');
      });
    });

    const dir = join(opRoot, 'journal');
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    const env = JSON.parse(await readFile(join(dir, entries[0]), 'utf8'));
    expect(env.command).toBe('run-step'); // outer wins
    expect(env.steps).toHaveLength(2);
    expect(env.steps[0].subCommand).toBe('lane-claim');
    expect(env.steps[1].subCommand).toBe('registry-refresh');
    expect(env.steps[0].path).toBe(a);
    expect(env.steps[1].path).toBe(b);
  });

  it('only the outer call holds the journal-write lock', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const lockPath = join(lockRoot(opRoot), 'journal-write.lock');
    let outerLocked = false;
    let innerLocked = false;

    await withJournal(opRoot, 'outer', {}, async () => {
      outerLocked = await fileExists(lockPath);
      await withJournal(opRoot, 'inner', {}, async (inner) => {
        innerLocked = await fileExists(lockPath);
        await journalWrite(inner, join(target, 'x'), 'x');
      });
    });

    expect(outerLocked).toBe(true);
    expect(innerLocked).toBe(true);
    // After outer returns, lock released.
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('exposes current journal context inside fn', async () => {
    const opRoot = await tmpOpRoot();
    expect(currentJournalContext()).toBeNull();
    await withJournal(opRoot, 'standalone', {}, async (ctx) => {
      const cur = currentJournalContext();
      expect(cur).not.toBeNull();
      expect(cur?.opId).toBe(ctx.opId);
    });
    expect(currentJournalContext()).toBeNull();
  });
});

describe('helpers — journalWrite / journalAtomicCreate / journalDelete / journalInvalidate', () => {
  it('journalWrite captures prev/next hashes + content', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'data.txt');
    await writeFile(file, 'OLD', 'utf8');
    await withJournal(opRoot, 'op', {}, async (j) => {
      await journalWrite(j, file, 'NEW');
    });
    const dir = join(opRoot, 'journal');
    const env = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'));
    const step = env.steps[0];
    expect(step.op).toBe('write');
    expect(step.path).toBe(file);
    expect(step.prevHash).toBe(sha256Buffer('OLD'));
    expect(step.nextHash).toBe(sha256Buffer('NEW'));
    expect(step.content).toBe('NEW');
    expect(step.completedAt).not.toBeNull();
    expect(await readFile(file, 'utf8')).toBe('NEW');
  });

  it('journalAtomicCreate sets prevHash null', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'fresh.txt');
    await withJournal(opRoot, 'op', {}, async (j) => {
      await journalAtomicCreate(j, file, 'X');
    });
    const dir = join(opRoot, 'journal');
    const env = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'));
    expect(env.steps[0].prevHash).toBeNull();
    expect(env.steps[0].nextHash).toBe(sha256Buffer('X'));
    expect(env.steps[0].op).toBe('atomic-create');
  });

  it('journalDelete sets nextHash null and content null', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'goner.txt');
    await writeFile(file, 'BYE', 'utf8');
    await withJournal(opRoot, 'op', {}, async (j) => {
      await journalDelete(j, file);
    });
    const dir = join(opRoot, 'journal');
    const env = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'));
    expect(env.steps[0].op).toBe('delete');
    expect(env.steps[0].prevHash).toBe(sha256Buffer('BYE'));
    expect(env.steps[0].nextHash).toBeNull();
    expect(env.steps[0].content).toBeNull();
    expect(await fileExists(file)).toBe(false);
  });

  it('journalDelete is a no-op for ENOENT', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'never-existed.txt');
    await withJournal(opRoot, 'op', {}, async (j) => {
      await journalDelete(j, file);
    });
    const dir = join(opRoot, 'journal');
    const env = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'));
    expect(env.steps[0].prevHash).toBeNull();
  });

  it('journalInvalidate records both hashes null', async () => {
    const opRoot = await tmpOpRoot();
    await withJournal(opRoot, 'op', {}, async (j) => {
      await journalInvalidate(j, opRoot);
    });
    const dir = join(opRoot, 'journal');
    const env = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'));
    expect(env.steps[0].op).toBe('invalidate-cache');
    expect(env.steps[0].prevHash).toBeNull();
    expect(env.steps[0].nextHash).toBeNull();
  });
});

describe('classifyJournal — decision matrix', () => {
  it('returns ALREADY_APPLIED when every step.nextHash matches current file', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'applied.txt');
    await withJournal(opRoot, 'op', {}, async (j) => {
      await journalWrite(j, file, 'V1');
    });
    // Move .done back to .pending to simulate "already applied".
    const dir = join(opRoot, 'journal');
    const done = (await readdir(dir)).find((f) => f.endsWith('.done.json')) as string;
    const pending = done.replace('.done.json', '.pending.json');
    await rename(join(dir, done), join(dir, pending));
    const outcome = await classifyJournal(join(dir, pending));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.classification).toBe('already_applied');
  });

  it('returns SAFE_REPLAY when current file matches prevHash', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'pending.txt');
    await writeFile(file, 'PREV', 'utf8');
    // Build a pending journal manually: journalWrite already mutated, so undo.
    let pendingPath: string | null = null;
    try {
      await withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        // Manually revert the file to PREV state — recover should see prevHash match.
        await writeFile(file, 'PREV', 'utf8');
        throw new Error('synthetic crash to leave pending');
      });
    } catch {
      // expected
    }
    const dir = join(opRoot, 'journal');
    pendingPath = join(
      dir,
      (await readdir(dir)).find((f) => f.endsWith('.pending.json')) as string,
    );
    const outcome = await classifyJournal(pendingPath);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.classification).toBe('safe_replay');
  });

  it('returns DIVERGED when current file matches neither prev nor next', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'div.txt');
    await writeFile(file, 'PREV', 'utf8');
    try {
      await withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        // External actor rewrites file to something else entirely.
        await writeFile(file, 'OTHER', 'utf8');
        throw new Error('synthetic');
      });
    } catch {
      // expected
    }
    const dir = join(opRoot, 'journal');
    const pendingPath = join(
      dir,
      (await readdir(dir)).find((f) => f.endsWith('.pending.json')) as string,
    );
    const outcome = await classifyJournal(pendingPath);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.classification).toBe('diverged');
  });

  it('returns UNKNOWN_SCHEMA for future schemaVersion', async () => {
    const opRoot = await tmpOpRoot();
    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV.pending.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 99,
        opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
        command: 'op',
        args: {},
        startedAt: '2026-05-06T12:00:00.000Z',
        completedAt: null,
        steps: [],
      }),
      'utf8',
    );
    const outcome = await classifyJournal(path);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.classification).toBe('unknown_schema');
  });

  it('returns CORRUPT for unparseable JSON', async () => {
    const opRoot = await tmpOpRoot();
    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAW.pending.json');
    await writeFile(path, '{not valid json', 'utf8');
    const outcome = await classifyJournal(path);
    expect(outcome.kind).toBe('corrupt');
  });

  it('returns CORRUPT when content hash does not match nextHash', async () => {
    const opRoot = await tmpOpRoot();
    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAX.pending.json');
    const fakeHash = 'f'.repeat(64);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAX',
        command: 'op',
        args: {},
        startedAt: '2026-05-06T12:00:00.000Z',
        completedAt: null,
        steps: [
          {
            stepIndex: 0,
            op: 'write',
            path: '/tmp/x',
            prevHash: null,
            nextHash: fakeHash,
            content: 'hello',
            encoding: 'utf8',
            startedAt: '2026-05-06T12:00:00.000Z',
            completedAt: null,
          },
        ],
      }),
      'utf8',
    );
    const outcome = await classifyJournal(path);
    expect(outcome.kind).toBe('corrupt');
    if (outcome.kind === 'corrupt') {
      expect(outcome.detail).toMatch(/content hash mismatch/);
    }
  });
});

describe('scanAndHealJournals', () => {
  it('replays SAFE_REPLAY journals and renames to .done.json', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'replay.txt');
    await writeFile(file, 'PREV', 'utf8');
    try {
      await withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        await writeFile(file, 'PREV', 'utf8'); // revert
        throw new Error('synthetic');
      });
    } catch {
      // expected
    }
    const before = (await readdir(join(opRoot, 'journal'))).filter((f) =>
      f.endsWith('.pending.json'),
    );
    expect(before).toHaveLength(1);

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('safe_replay');
    expect(results[0].stepsApplied).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('NEXT');
    const after = await readdir(join(opRoot, 'journal'));
    expect(after.filter((f) => f.endsWith('.pending.json'))).toEqual([]);
    expect(after.filter((f) => f.endsWith('.done.json'))).toHaveLength(1);
  });

  it('quarantines DIVERGED journals', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'div.txt');
    await writeFile(file, 'PREV', 'utf8');
    try {
      await withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        await writeFile(file, 'OTHER', 'utf8');
        throw new Error('synthetic');
      });
    } catch {
      // expected
    }
    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('diverged');
    expect(results[0].quarantinedPath).toBeDefined();
    const after = await readdir(join(opRoot, 'journal'));
    expect(after.some((f) => f.includes('.unrecoverable.'))).toBe(true);
  });

  it('leaves UNKNOWN_SCHEMA pending file in place even with apply', async () => {
    const opRoot = await tmpOpRoot();
    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV.pending.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 99,
        opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
        command: 'op',
        args: {},
        startedAt: '2026-05-06T12:00:00.000Z',
        completedAt: null,
        steps: [],
      }),
      'utf8',
    );
    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(results[0].classification).toBe('unknown_schema');
    expect(await fileExists(path)).toBe(true);
  });

  it('preview mode does not mutate', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'preview.txt');
    await writeFile(file, 'PREV', 'utf8');
    try {
      await withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        await writeFile(file, 'PREV', 'utf8');
        throw new Error('synthetic');
      });
    } catch {
      // expected
    }
    const results = await scanAndHealJournals({ opRoot, apply: false });
    expect(results[0].classification).toBe('safe_replay');
    expect(await readFile(file, 'utf8')).toBe('PREV'); // unchanged
    const after = await readdir(join(opRoot, 'journal'));
    expect(after.filter((f) => f.endsWith('.pending.json'))).toHaveLength(1);
  });
});

describe('listPendingJournals', () => {
  it('returns empty array when journal dir does not exist', async () => {
    const opRoot = await tmpOpRoot();
    const result = await listPendingJournals(opRoot);
    expect(result).toEqual([]);
  });
});

describe('gcJournals', () => {
  it('keeps the most recent N done journals, removes older', async () => {
    const opRoot = await tmpOpRoot();
    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    // Build 5 done journals with monotonic ULID-like names.
    const names = [
      'OP-00000000000000000000000001.done.json',
      'OP-00000000000000000000000002.done.json',
      'OP-00000000000000000000000003.done.json',
      'OP-00000000000000000000000004.done.json',
      'OP-00000000000000000000000005.done.json',
    ];
    for (const n of names) await writeFile(join(dir, n), '{}', 'utf8');
    const removed = await gcJournals(opRoot, 3);
    expect(removed).toBe(2);
    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual([
      'OP-00000000000000000000000003.done.json',
      'OP-00000000000000000000000004.done.json',
      'OP-00000000000000000000000005.done.json',
    ]);
  });

  it('does not touch unrecoverable journals', async () => {
    const opRoot = await tmpOpRoot();
    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'OP-00000000000000000000000001.unrecoverable.20260506.abc.json'),
      '{}',
      'utf8',
    );
    await writeFile(join(dir, 'OP-00000000000000000000000002.done.json'), '{}', 'utf8');
    await gcJournals(opRoot, 0);
    const remaining = await readdir(dir);
    expect(remaining.some((f) => f.includes('.unrecoverable.'))).toBe(true);
  });

  it('returns 0 when journal dir absent', async () => {
    const opRoot = await tmpOpRoot();
    const removed = await gcJournals(opRoot, 50);
    expect(removed).toBe(0);
  });
});

// helpers
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
