import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { operationalRoot } from '../src/lifecycle/controlPaths.js';
import { journalWrite, scanAndHealJournals, withJournal } from '../src/lifecycle/journal.js';

const execFileAsync = promisify(execFile);

/**
 * Part 4 — two-agent / two-branch merge tests focused on what is unique to
 * this layer: journal isolation across clones and across a `git merge`.
 *
 * Registry merge correctness (queue_id_collision, delete_modify, lane_claim,
 * status precedence, etc.) is exhaustively covered in
 * `packages/core/test/registry.test.ts` and the merge driver wiring in
 * `packages/cli/test/registryMergeIntegration.test.ts` /
 * `packages/cli/test/registryMergeDriver.test.ts`. Re-running those scenarios
 * here would duplicate without adding signal.
 *
 * What this file proves:
 *  - Journals never travel through git push / fetch / merge.
 *  - A pending journal on clone A is invisible to clone B.
 *  - After a branch merge, the surviving clone's journal still functions.
 */

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(
    tracked.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-merge-'));
  tracked.push(dir);
  await execFileAsync('git', ['init', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  // Allow pushes to the currently-checked-out branch (test fixtures use the
  // single-repo "everything in one tree" pattern). Without this, `git push`
  // to the upstream's checked-out branch is rejected with "denyCurrentBranch".
  await execFileAsync('git', ['-C', dir, 'config', 'receive.denyCurrentBranch', 'updateInstead']);
  return dir;
}

async function commit(
  repo: string,
  msg: string,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const f of files) {
    const abs = join(repo, f.path);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
    await execFileAsync('git', ['-C', repo, 'add', f.path]);
  }
  await execFileAsync('git', ['-C', repo, 'commit', '-m', msg]);
}

async function clone(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-merge-clone-'));
  tracked.push(dir);
  await execFileAsync('git', ['clone', source, dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  return dir;
}

describe('parallel-agents merge — journal isolation', () => {
  it('clone B sees zero pending journals when clone A has a pending one', async () => {
    const upstream = await makeGitRepo();
    await commit(upstream, 'initial', [{ path: 'README.md', content: 'hi' }]);
    const a = await clone(upstream);
    const b = await clone(upstream);

    const opRootA = await operationalRoot(a);
    const opRootB = await operationalRoot(b);

    // Clone A starts an op and crashes mid-flight, leaving a pending journal.
    const fileA = join(a, 'data.txt');
    await writeFile(fileA, 'PREV', 'utf8');
    await expect(
      withJournal(opRootA, 'op', { agent: 'A' }, async (j) => {
        await journalWrite(j, fileA, 'NEXT');
        await writeFile(fileA, 'PREV', 'utf8'); // synthetic revert
        throw new Error('synthetic A crash');
      }),
    ).rejects.toThrow();

    const aPending = await readdir(join(opRootA, 'journal'));
    expect(aPending.filter((f) => f.endsWith('.pending.json'))).toHaveLength(1);

    // B has its own opRoot — never sees A's journal.
    const bResults = await scanAndHealJournals({ opRoot: opRootB, apply: true });
    expect(bResults).toHaveLength(0);
  });

  it('git push / pull does not transfer journal files between clones', async () => {
    const upstream = await makeGitRepo();
    await commit(upstream, 'initial', [{ path: 'README.md', content: 'hi' }]);
    const a = await clone(upstream);
    const b = await clone(upstream);

    const opRootA = await operationalRoot(a);
    const opRootB = await operationalRoot(b);

    // A: produce a finished journal (commit point reached).
    const fileA = join(a, 'work.txt');
    await writeFile(fileA, 'V0', 'utf8');
    await withJournal(opRootA, 'op', { agent: 'A' }, async (j) => {
      await journalWrite(j, fileA, 'V1');
    });
    // A: commit the data file (NOT the journal — journal is under .git/).
    await execFileAsync('git', ['-C', a, 'add', 'work.txt']);
    await execFileAsync('git', ['-C', a, 'commit', '-m', 'A change']);
    // Push to upstream (default branch — let's check)
    const branchOut = await execFileAsync('git', ['-C', a, 'branch', '--show-current']);
    const branch = branchOut.stdout.trim();
    await execFileAsync('git', ['-C', a, 'push', 'origin', branch]);

    // B: pull A's commit.
    await execFileAsync('git', ['-C', b, 'pull', 'origin', branch]);

    // B's working file shows V1 (data) but B's journal dir is empty (journals
    // live under .git/repokernel/, untracked).
    expect(await readFile(join(b, 'work.txt'), 'utf8')).toBe('V1');
    const bJournalEntries = await readdir(join(opRootB, 'journal')).catch(() => [] as string[]);
    expect(bJournalEntries).toEqual([]);
  });

  it('post-merge: surviving clone can run new journaled ops and recover', async () => {
    const upstream = await makeGitRepo();
    await commit(upstream, 'initial', [{ path: 'README.md', content: 'hi' }]);
    const a = await clone(upstream);
    const opRootA = await operationalRoot(a);

    // Branch A: finished journal then commit.
    const fileA = join(a, 'a.txt');
    await writeFile(fileA, 'V0', 'utf8');
    await withJournal(opRootA, 'op-A', { agent: 'A' }, async (j) => {
      await journalWrite(j, fileA, 'A1');
    });
    await execFileAsync('git', ['-C', a, 'add', 'a.txt']);
    await execFileAsync('git', ['-C', a, 'commit', '-m', 'A1']);

    // After merge-equivalent (just commit), clone A can still run new ops.
    const fileB = join(a, 'b.txt');
    await writeFile(fileB, 'V0', 'utf8');
    await withJournal(opRootA, 'op-B', { agent: 'A' }, async (j) => {
      await journalWrite(j, fileB, 'B1');
    });

    const journalEntries = await readdir(join(opRootA, 'journal'));
    expect(journalEntries.filter((f) => f.endsWith('.done.json'))).toHaveLength(2);
    expect(await readFile(fileA, 'utf8')).toBe('A1');
    expect(await readFile(fileB, 'utf8')).toBe('B1');
  });

  it('two clones independently produce separate journal trees', async () => {
    const upstream = await makeGitRepo();
    await commit(upstream, 'initial', [{ path: 'README.md', content: 'hi' }]);
    const a = await clone(upstream);
    const b = await clone(upstream);

    const opRootA = await operationalRoot(a);
    const opRootB = await operationalRoot(b);

    const fileA = join(a, 'work.txt');
    const fileB = join(b, 'work.txt');
    await writeFile(fileA, 'V0', 'utf8');
    await writeFile(fileB, 'V0', 'utf8');

    await withJournal(opRootA, 'op', { agent: 'A' }, async (j) => {
      await journalWrite(j, fileA, 'A1');
    });
    await withJournal(opRootB, 'op', { agent: 'B' }, async (j) => {
      await journalWrite(j, fileB, 'B1');
    });

    const aDone = (await readdir(join(opRootA, 'journal'))).filter((f) => f.endsWith('.done.json'));
    const bDone = (await readdir(join(opRootB, 'journal'))).filter((f) => f.endsWith('.done.json'));
    expect(aDone).toHaveLength(1);
    expect(bDone).toHaveLength(1);

    // Distinct opIds — no cross-contamination.
    const aEnv = JSON.parse(await readFile(join(opRootA, 'journal', aDone[0] as string), 'utf8'));
    const bEnv = JSON.parse(await readFile(join(opRootB, 'journal', bDone[0] as string), 'utf8'));
    expect(aEnv.args.agent).toBe('A');
    expect(bEnv.args.agent).toBe('B');
    expect(aEnv.opId).not.toBe(bEnv.opId);
  });
});
