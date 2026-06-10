import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoKernelError } from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { laneStateRoot } from '../src/lifecycle/controlPaths.js';
import { getLaneState } from '../src/lifecycle/laneState.js';
import { findLeakedEpicWorktrees } from '../src/lifecycle/worktree.js';
import { makeGitRepo, opRoot, removeRepo } from './fakeAgent/helpers.js';

const repos: string[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpOpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-state-'));
  dirs.push(dir);
  return dir;
}

async function plantWorktreesJson(repo: string, contents: string): Promise<void> {
  const root = opRoot(repo);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'worktrees.json'), contents, 'utf8');
}

describe('worktrees.json read validation', () => {
  it('throws a typed IO_ERROR on a truncated (mid-write) file', async () => {
    const repo = await makeGitRepo();
    repos.push(repo);
    // A crash mid-write leaves a syntactically broken tail.
    await plantWorktreesJson(repo, '{"worktrees":[{"epicId":"E-001",');
    const error = await findLeakedEpicWorktrees(new Set(), repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoKernelError);
    expect((error as RepoKernelError).kind).toBe('IO_ERROR');
  });

  it('throws a typed IO_ERROR on valid JSON with the wrong shape', async () => {
    const repo = await makeGitRepo();
    repos.push(repo);
    // Parses fine, but the record is missing required fields (branch).
    await plantWorktreesJson(repo, '{"worktrees":[{"epicId":"E-001","path":"/x"}]}');
    const error = await findLeakedEpicWorktrees(new Set(), repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoKernelError);
    expect((error as RepoKernelError).kind).toBe('IO_ERROR');
  });
});

describe('lane state read validation', () => {
  async function plantLaneFile(op: string, lane: string, contents: string): Promise<void> {
    const root = laneStateRoot(op);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${lane}.json`), contents, 'utf8');
  }

  it('returns null when the lane file is absent (lane simply not claimed)', async () => {
    const op = await tmpOpRoot();
    expect(await getLaneState('never-claimed', op)).toBeNull();
  });

  it('throws a typed IO_ERROR on a truncated lane file', async () => {
    const op = await tmpOpRoot();
    await plantLaneFile(op, 'lane-a', '{"lane":"lane-a","run_id":');
    const error = await getLaneState('lane-a', op).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoKernelError);
    expect((error as RepoKernelError).kind).toBe('IO_ERROR');
  });

  it('throws a typed IO_ERROR on valid JSON missing required fields', async () => {
    const op = await tmpOpRoot();
    await plantLaneFile(op, 'lane-b', '{"lane":"lane-b"}');
    const error = await getLaneState('lane-b', op).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoKernelError);
    expect((error as RepoKernelError).kind).toBe('IO_ERROR');
  });
});
