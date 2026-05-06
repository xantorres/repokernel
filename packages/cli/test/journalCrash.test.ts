import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRecoverCommand } from '../src/commands/recover.js';
import { operationalRoot } from '../src/lifecycle/controlPaths.js';
import {
  type JournalScanResult,
  journalInvalidate,
  journalWrite,
  scanAndHealJournals,
  setUlidGenForTests,
  sha256Buffer,
  withJournal,
} from '../src/lifecycle/journal.js';

const execFileAsync = promisify(execFile);

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(
    tracked.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
  setUlidGenForTests(null);
  vi.restoreAllMocks();
});

async function tmpOpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rk-jcrash-'));
  tracked.push(root);
  return root;
}

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-jcrash-target-'));
  tracked.push(dir);
  return dir;
}

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-jcrash-git-'));
  tracked.push(dir);
  await execFileAsync('git', ['init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  return dir;
}

async function listJournalFiles(opRoot: string): Promise<{
  pending: string[];
  done: string[];
  unrecoverable: string[];
}> {
  const dir = join(opRoot, 'journal');
  const entries = await readdir(dir).catch(() => [] as string[]);
  return {
    pending: entries.filter((f) => f.endsWith('.pending.json')),
    done: entries.filter((f) => f.endsWith('.done.json')),
    unrecoverable: entries.filter((f) => f.includes('.unrecoverable.')),
  };
}

function classify(results: readonly JournalScanResult[]): string[] {
  return results.map((r) => r.classification);
}

describe('crash simulation — Part 3 cases', () => {
  it('case 1: crash before any step recorded → recover replays empty journal cleanly', async () => {
    const opRoot = await tmpOpRoot();
    await expect(
      withJournal(opRoot, 'op', {}, async () => {
        throw new Error('synthetic crash before any step');
      }),
    ).rejects.toThrow('synthetic crash');

    let { pending } = await listJournalFiles(opRoot);
    expect(pending).toHaveLength(1);

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['already_applied']);
    ({ pending } = await listJournalFiles(opRoot));
    expect(pending).toHaveLength(0);
  });

  it('case 2: crash after recordStep before atomicWriteText (the (b)→(c) window)', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'core.txt');
    await writeFile(file, 'PREV', 'utf8');

    const atomicWrite = await import('../src/lifecycle/atomicWrite.js');
    const original = atomicWrite.atomicWriteText;
    let throwOnce = true;
    vi.spyOn(atomicWrite, 'atomicWriteText').mockImplementation(async (path, content) => {
      if (throwOnce && path === file) {
        throwOnce = false;
        throw new Error('synthetic crash mid-write');
      }
      return original(path, content);
    });

    await expect(
      withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
      }),
    ).rejects.toThrow('synthetic crash mid-write');

    vi.restoreAllMocks();
    expect(await readFile(file, 'utf8')).toBe('PREV');

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['safe_replay']);
    expect(results[0]?.stepsApplied).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('NEXT');
    const { pending, done } = await listJournalFiles(opRoot);
    expect(pending).toHaveLength(0);
    expect(done).toHaveLength(1);
  });

  it('case 3: crash between completed step 0 and step 1', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const a = join(target, 'a.txt');
    await writeFile(a, 'A0', 'utf8');

    await expect(
      withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, a, 'A1');
        throw new Error('synthetic between steps');
      }),
    ).rejects.toThrow();

    expect(await readFile(a, 'utf8')).toBe('A1');

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['already_applied']);
    const { pending, done } = await listJournalFiles(opRoot);
    expect(pending).toHaveLength(0);
    expect(done).toHaveLength(1);
  });

  it('case 5: external divergence between crash and recover → quarantine', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'div.txt');
    await writeFile(file, 'PREV', 'utf8');

    await expect(
      withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        await writeFile(file, 'EXTERNAL', 'utf8');
        throw new Error('synthetic crash after external rewrite');
      }),
    ).rejects.toThrow();

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['diverged']);
    const { pending, unrecoverable } = await listJournalFiles(opRoot);
    expect(pending).toHaveLength(0);
    expect(unrecoverable).toHaveLength(1);
  });

  it('case 6: crash after last step but before pending→done rename', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'final.txt');
    await writeFile(file, 'PREV', 'utf8');

    await expect(
      withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        throw new Error('synthetic post-step crash');
      }),
    ).rejects.toThrow();

    const before = await listJournalFiles(opRoot);
    expect(before.pending).toHaveLength(1);
    expect(before.done).toHaveLength(0);
    expect(await readFile(file, 'utf8')).toBe('NEXT');

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['already_applied']);
    const after = await listJournalFiles(opRoot);
    expect(after.pending).toHaveLength(0);
    expect(after.done).toHaveLength(1);
  });

  it('case 7: crash during invalidate-cache step → recover re-runs invalidate', async () => {
    const opRoot = await tmpOpRoot();
    const cachePath = join(opRoot, 'preflight.json');
    await mkdir(opRoot, { recursive: true });
    await writeFile(cachePath, 'STALE', 'utf8');

    await expect(
      withJournal(opRoot, 'op', {}, async (j) => {
        await journalInvalidate(j, opRoot);
        throw new Error('synthetic crash post-invalidate');
      }),
    ).rejects.toThrow();

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(['already_applied', 'safe_replay']).toContain(results[0]?.classification);
    let cacheExists = false;
    try {
      await readFile(cachePath);
      cacheExists = true;
    } catch {
      cacheExists = false;
    }
    expect(cacheExists).toBe(false);
  });

  it('case 11: unknown schema → leave pending, target untouched', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'untouched.txt');
    await writeFile(file, 'ORIGINAL', 'utf8');

    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV.pending.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 99,
        opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
        command: 'future-op',
        args: {},
        startedAt: '2026-05-06T12:00:00.000Z',
        completedAt: null,
        steps: [],
      }),
      'utf8',
    );

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['unknown_schema']);
    expect(await readFile(file, 'utf8')).toBe('ORIGINAL');
    const { pending, unrecoverable } = await listJournalFiles(opRoot);
    expect(pending).toHaveLength(1);
    expect(unrecoverable).toHaveLength(0);
  });

  it('case 12: corrupt journal — parse failure → quarantine', async () => {
    const opRoot = await tmpOpRoot();
    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAW.pending.json'),
      '{not valid json',
      'utf8',
    );

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['corrupt']);
    const { pending, unrecoverable } = await listJournalFiles(opRoot);
    expect(pending).toHaveLength(0);
    expect(unrecoverable).toHaveLength(1);
  });

  it('case 14: corrupt journal — content hash tamper → quarantine, target untouched', async () => {
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'safe.txt');
    await writeFile(file, 'ORIGINAL', 'utf8');

    const dir = join(opRoot, 'journal');
    await mkdir(dir, { recursive: true });
    const tamperedNextHash = 'f'.repeat(64);
    await writeFile(
      join(dir, 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAX.pending.json'),
      JSON.stringify({
        schemaVersion: 1,
        opId: 'OP-01ARZ3NDEKTSV4RRFFQ69G5FAX',
        command: 'tampered',
        args: {},
        startedAt: '2026-05-06T12:00:00.000Z',
        completedAt: null,
        steps: [
          {
            stepIndex: 0,
            op: 'write',
            path: file,
            prevHash: sha256Buffer('ORIGINAL'),
            nextHash: tamperedNextHash,
            content: 'EVIL',
            encoding: 'utf8',
            startedAt: '2026-05-06T12:00:00.000Z',
            completedAt: null,
          },
        ],
      }),
      'utf8',
    );

    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['corrupt']);
    expect(await readFile(file, 'utf8')).toBe('ORIGINAL');
    const { unrecoverable } = await listJournalFiles(opRoot);
    expect(unrecoverable).toHaveLength(1);
  });

  it('case 16: single-clone, two-worktree shared-journal recovery', async () => {
    // git common dir is shared; two cwds resolve to the same opRoot.
    const repo = await makeGitRepo();
    const opRoot = await operationalRoot(repo);
    await mkdir(repo, { recursive: true });
    const file = join(repo, 'shared.txt');
    await writeFile(file, 'PREV', 'utf8');

    await expect(
      withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        await writeFile(file, 'PREV', 'utf8'); // synthetic revert
        throw new Error('synthetic');
      }),
    ).rejects.toThrow();

    // Recover from the same repo (different worktrees of the same common
    // dir would have identical operationalRoot resolution).
    const results = await scanAndHealJournals({ opRoot, apply: true });
    expect(classify(results)).toEqual(['safe_replay']);
    expect(await readFile(file, 'utf8')).toBe('NEXT');
  });

  it('case 17: cross-clone isolation — clone B sees no pending journals from clone A', async () => {
    const repoA = await makeGitRepo();
    const repoB = await makeGitRepo();
    const opRootA = await operationalRoot(repoA);
    const opRootB = await operationalRoot(repoB);

    const fileA = join(repoA, 'a.txt');
    await writeFile(fileA, 'PREV', 'utf8');

    await expect(
      withJournal(opRootA, 'op', {}, async (j) => {
        await journalWrite(j, fileA, 'NEXT');
        await writeFile(fileA, 'PREV', 'utf8');
        throw new Error('synthetic');
      }),
    ).rejects.toThrow();

    // A has a pending journal.
    const aPending = await listJournalFiles(opRootA);
    expect(aPending.pending).toHaveLength(1);

    // B should have NONE — its opRoot is separate.
    const bResults = await scanAndHealJournals({ opRoot: opRootB, apply: true });
    expect(bResults).toHaveLength(0);

    // A's journal untouched.
    const aPendingAfter = await listJournalFiles(opRootA);
    expect(aPendingAfter.pending).toHaveLength(1);
  });

  it('writes recover.report.json after --apply (E2E through runRecoverCommand)', async () => {
    const repo = await makeGitRepo();
    const opRoot = await operationalRoot(repo);
    const file = join(repo, 'rep.txt');
    await writeFile(file, 'PREV', 'utf8');
    await expect(
      withJournal(opRoot, 'op', {}, async (j) => {
        await journalWrite(j, file, 'NEXT');
        await writeFile(file, 'PREV', 'utf8');
        throw new Error('synthetic');
      }),
    ).rejects.toThrow();

    const result = await runRecoverCommand({
      cwd: repo,
      preview: false,
      apply: true,
      json: true,
      journalOnly: true,
    });
    expect(result.exitCode).toBe(0);

    const reportPath = join(opRoot, 'recover.report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(report.schemaVersion).toBe(1);
    expect(report.apply).toBe(true);
    expect(report.journals).toHaveLength(1);
    expect(report.journals[0].classification).toBe('safe_replay');
  });
});

describe('snapshot — locks the on-disk journal envelope format', () => {
  it('redacted envelope is stable for a single-step write', async () => {
    setUlidGenForTests(() => '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const opRoot = await tmpOpRoot();
    const target = await tmpDir();
    const file = join(target, 'snap.txt');

    await withJournal(opRoot, 'snapshot-op', { lane: 'main' }, async (j) => {
      await journalWrite(j, file, 'HELLO');
    });

    const dir = join(opRoot, 'journal');
    const done = (await readdir(dir)).find((f) => f.endsWith('.done.json')) as string;
    const env = JSON.parse(await readFile(join(dir, done), 'utf8'));
    const redacted = redact(env, file);
    expect(redacted).toMatchSnapshot();
  });
});

function redact(envelope: Record<string, unknown>, file: string): unknown {
  const FROZEN_TS = '2024-01-01T00:00:00.000Z';
  const steps = (envelope.steps as Array<Record<string, unknown>>).map((s) => ({
    ...s,
    path: s.path === file ? '<TARGET_FILE>' : s.path,
    startedAt: FROZEN_TS,
    completedAt: s.completedAt === null ? null : FROZEN_TS,
  }));
  return {
    ...envelope,
    startedAt: FROZEN_TS,
    completedAt: envelope.completedAt === null ? null : FROZEN_TS,
    steps,
  };
}
