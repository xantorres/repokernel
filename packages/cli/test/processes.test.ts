/**
 * Integration test for the pre-removal process sweep: real processes are
 * spawned with their cwd inside a fixture directory, and the sweep must
 * kill everything rooted there while leaving a bystander alone.
 *
 * The candidate-cap (>20 matches aborts without signalling) is not covered
 * here: exercising it needs >20 real processes or an injection seam this
 * module doesn't have. Not worth adding a seam for a single guard clause.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminateProcessesRootedIn } from '../src/lifecycle/processes.js';

function hasExecutable(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The sweep's cwd matching depends on `lsof`; without it R1 degrades to
// empty and this test's core assertions no longer hold, so skip rather than
// fail on a runner that doesn't have it installed.
const canRunIntegrationTest = process.platform !== 'win32' && hasExecutable('lsof');

const cleanupDirs: string[] = [];
const cleanupPids: number[] = [];

afterEach(async () => {
  for (const pid of cleanupPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

async function makeRealpathedTempDir(): Promise<string> {
  // realpath is required: macOS routes the temp dir through a symlink
  // (/var -> /private/var), and lsof reports the canonical path, not the
  // symlinked one — comparing against the un-resolved path would never match.
  const dir = await mkdtemp(join(tmpdir(), 'repokernel-processes-'));
  return realpath(dir);
}

/** Direct children of `parentPid`, via the same `ps` fields the module reads. */
function findChildPids(parentPid: number): number[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  const children: number[] = [];
  for (const line of out.split('\n')) {
    const [pidStr, ppidStr] = line.trim().split(/\s+/);
    if (pidStr && ppidStr && Number(ppidStr) === parentPid) children.push(Number(pidStr));
  }
  return children;
}

describe('terminateProcessesRootedIn', () => {
  it.runIf(canRunIntegrationTest)(
    'kills a direct child and a shell descendant rooted in the directory, leaves a bystander alone',
    async () => {
      const targetDir = await makeRealpathedTempDir();
      cleanupDirs.push(targetDir);
      const bystanderDir = await makeRealpathedTempDir();
      cleanupDirs.push(bystanderDir);

      const direct = spawn('sleep', ['300'], { cwd: targetDir, detached: true, stdio: 'ignore' });
      const viaShell = spawn('sh', ['-c', 'sleep 300'], {
        cwd: targetDir,
        detached: true,
        stdio: 'ignore',
      });
      const bystander = spawn('sleep', ['300'], {
        cwd: bystanderDir,
        detached: true,
        stdio: 'ignore',
      });
      const directPid = direct.pid!;
      const viaShellPid = viaShell.pid!;
      const bystanderPid = bystander.pid!;
      cleanupPids.push(directPid, viaShellPid, bystanderPid);

      // Let the children settle so ps/lsof observe their real cwd.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // `sh -c 'sleep 300'` may fork sleep as a separate grandchild pid
      // instead of exec'ing into it. Track it too, or a failed assertion
      // below leaks a 5-minute sleep that cleanup never learns about.
      cleanupPids.push(...findChildPids(viaShellPid));

      const result = terminateProcessesRootedIn(targetDir);

      expect(await waitUntil(() => !isAlive(directPid), 3000)).toBe(true);
      // sh may exec directly into sleep (same pid) or fork it as a child
      // (R3 closure case) — either way the original pid must end up dead.
      expect(await waitUntil(() => !isAlive(viaShellPid), 3000)).toBe(true);
      expect(isAlive(bystanderPid)).toBe(true);
      expect(result.terminated).toBeGreaterThanOrEqual(2);
      expect(result.failed).toBe(0);
    },
    10_000,
  );
});
