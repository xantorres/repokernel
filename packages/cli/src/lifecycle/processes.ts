import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

/**
 * Result of a termination sweep. `terminated` counts processes this call
 * successfully signalled and later confirmed dead; `failed` counts processes
 * it tried and could not kill (permission denied, or still alive after
 * SIGKILL). Processes that were already gone by the time they were reached
 * count toward neither — they were never ours to take credit for.
 */
export interface ProcessTerminationResult {
  readonly terminated: number;
  readonly failed: number;
}

interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly tty: string;
  readonly command: string;
}

const POLL_INTERVAL_MS = 100;
const SIGKILL_CONFIRM_MS = 300;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const CANDIDATE_CAP = 20;

/**
 * Terminate processes whose working directory (or an absolute path in their
 * argv) is rooted inside `dir`, before the caller removes that directory.
 * `git worktree remove` does not touch live processes: a build daemon or
 * watcher left running in the tree survives the removal, reparents, and
 * keeps burning CPU with its cwd pointing at a directory that no longer
 * exists. This is a best-effort safety sweep, not a guarantee — any
 * unexpected failure (missing `ps`, permission errors, malformed output)
 * falls back to doing nothing rather than risking a wrong kill or blocking
 * the caller's removal.
 *
 * A process is swept wholesale, together with its descendants, only when
 * its OWN cwd is inside `dir` — that's ownership. A process that merely
 * mentions `dir` somewhere in its argv is weaker evidence (an editor, an
 * LSP client, a tmux server can all reference a path without being owned by
 * it), so it is matched individually and its descendant tree is left alone.
 */
export function terminateProcessesRootedIn(dir: string, graceMs = 5000): ProcessTerminationResult {
  try {
    return findAndSignalRootedProcesses(dir, graceMs);
  } catch {
    return { terminated: 0, failed: 0 };
  }
}

function findAndSignalRootedProcesses(dir: string, graceMs: number): ProcessTerminationResult {
  // No `process.getuid` means a non-POSIX platform, where the `ps`/`lsof`
  // invocations below wouldn't work anyway.
  if (typeof process.getuid !== 'function') return { terminated: 0, failed: 0 };
  const selfUid = process.getuid();
  const rootReal = realpathSync(dir);

  // Snapshot both processes and cwd map once. Matching against two moving
  // targets read at different instants would let a process both appear and
  // disappear between reads and either miss it or misclassify it.
  const snapshot = parsePsSnapshot(execCapture('ps', ['-axo', 'pid=,ppid=,uid=,tty=,command=']));
  const byPid = new Map<number, ProcRow>(snapshot.map((row) => [row.pid, row]));
  const cwdByPid = parseLsofCwdMap(execLsofCwdSnapshot());

  // R1: process cwd is inside the worktree — this process belongs to the
  // worktree, so its whole descendant tree goes too (R3, below).
  const cwdRooted = new Set<number>();
  for (const [pid, cwdPath] of cwdByPid) {
    if (isUnderRoot(cwdPath, rootReal)) cwdRooted.add(pid);
  }
  // R2: an absolute argv token points inside the worktree (catches a process
  // that was launched with the worktree as an argument but cwd'd elsewhere,
  // e.g. a bundler invoked with an explicit --root). Relative tokens are
  // skipped — resolving them would test against our own cwd, not the
  // target process's. Deliberately does NOT seed R3: an argv mention is not
  // ownership, so only the matched process itself becomes a candidate, not
  // its descendants.
  const argvRooted = new Set<number>();
  for (const row of snapshot) {
    for (const token of row.command.split(/\s+/)) {
      if (token[0] !== '/') continue;
      if (isUnderRoot(token, rootReal)) {
        argvRooted.add(row.pid);
        break;
      }
    }
  }
  // R3: descendants of R1 (cwd) matches only, via the snapshot's ppid map —
  // a watcher's child process may have neither a matching cwd nor argv of
  // its own, but it dies with its cwd-owning parent regardless.
  const childrenOf = new Map<number, number[]>();
  for (const row of snapshot) {
    const siblings = childrenOf.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenOf.set(row.ppid, [row.pid]);
  }
  const rooted = new Set<number>(cwdRooted);
  const queue = [...cwdRooted];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of childrenOf.get(pid) ?? []) {
      if (!rooted.has(child)) {
        rooted.add(child);
        queue.push(child);
      }
    }
  }
  for (const pid of argvRooted) rooted.add(pid);

  // Self-protection: never signal our own process or anything in our
  // ancestor chain (a parked shell, the process manager that launched us,
  // etc). The chain is walked from the snapshot; a gap in the snapshot
  // (a parent that raced past between the ps read and now) falls back to a
  // fresh lookup rather than stopping the walk short and risking a false
  // negative on "is this our ancestor".
  const ancestors = ancestorChainOf(process.pid, byPid);

  const filtered: ProcRow[] = [];
  for (const pid of rooted) {
    const row = byPid.get(pid);
    if (!row) continue;
    if (row.uid !== selfUid) continue;
    // A controlling tty means an interactive session — a user's shell
    // parked in the worktree directory must never be signalled. macOS
    // reports "??" for no controlling tty; Linux procps reports "?" — accept
    // any tty field that starts with '?' rather than pinning one platform's
    // exact spelling.
    if (!row.tty.startsWith('?')) continue;
    if (row.pid <= 1) continue;
    if (row.pid === process.pid) continue;
    if (ancestors.has(row.pid)) continue;
    filtered.push(row);
  }

  // An oversized match means the root/prefix classification is wrong
  // somewhere upstream (e.g. realpath collapsed to a shared shallow
  // directory) — refuse to act rather than mass-kill on a bad match.
  if (filtered.length > CANDIDATE_CAP) {
    return { terminated: 0, failed: filtered.length };
  }

  return signalAndConfirm(filtered, graceMs);
}

function signalAndConfirm(
  candidates: readonly ProcRow[],
  graceMs: number,
): ProcessTerminationResult {
  let terminated = 0;
  let failed = 0;
  const pending: ProcRow[] = [];

  const sorted = [...candidates].sort((a, b) => a.pid - b.pid);
  for (const row of sorted) {
    // Re-verify immediately before every signal: the pid may have exited and
    // been reused by an unrelated process since the snapshot was taken.
    if (!commandStillMatches(row.pid, row.command)) continue;
    try {
      process.kill(row.pid, 'SIGTERM');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EPERM') failed += 1;
      // ESRCH: already gone — we never signalled it, so no credit either way.
      continue;
    }
    pending.push(row);
  }

  const reapDead = (): void => {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (isDeadByStat(pending[i]!.pid)) {
        terminated += 1;
        pending.splice(i, 1);
      }
    }
  };

  // Check before the first sleep: a target that already died from SIGTERM
  // must cost zero wait, not a guaranteed poll tick.
  reapDead();
  const deadline = Date.now() + graceMs;
  while (pending.length > 0 && Date.now() < deadline) {
    sleepSync(POLL_INTERVAL_MS);
    reapDead();
  }

  for (const row of pending) {
    if (!commandStillMatches(row.pid, row.command)) {
      // Gone (or pid reused) between the last poll and now — the original
      // target is no longer running, which is the outcome we wanted.
      terminated += 1;
      continue;
    }
    try {
      process.kill(row.pid, 'SIGKILL');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') terminated += 1;
      else failed += 1;
      continue;
    }
    // SIGKILL is unblockable but delivery isn't synchronous with kill()
    // returning — give the kernel a short window to actually reap the
    // process before writing it off as failed.
    if (waitForDeath(row.pid, SIGKILL_CONFIRM_MS)) terminated += 1;
    else failed += 1;
  }

  return { terminated, failed };
}

function waitForDeath(pid: number, budgetMs: number): boolean {
  if (isDeadByStat(pid)) return true;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    sleepSync(POLL_INTERVAL_MS);
    if (isDeadByStat(pid)) return true;
  }
  return isDeadByStat(pid);
}

function ancestorChainOf(pid: number, byPid: ReadonlyMap<number, ProcRow>): Set<number> {
  const chain = new Set<number>();
  let current = pid;
  for (;;) {
    const ppid = byPid.get(current)?.ppid ?? fetchPpidFresh(current);
    if (ppid === undefined || ppid === current || chain.has(ppid)) break;
    chain.add(ppid);
    if (ppid <= 1) break;
    current = ppid;
  }
  return chain;
}

function fetchPpidFresh(pid: number): number | undefined {
  try {
    const out = execCapture('ps', ['-o', 'ppid=', '-p', String(pid)]).trim();
    // Empty output means "no such process" on platforms where that exits 0
    // instead of throwing. `Number('')` is 0, which would misread as a real
    // ppid and let the ancestor walk stop believing it safely reached the
    // top — guard explicitly so it instead reports "unknown" and the walk
    // breaks without asserting anything false.
    if (out.length === 0) return undefined;
    const ppid = Number(out);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

function commandStillMatches(pid: number, expectedCommand: string): boolean {
  try {
    const out = execCapture('ps', ['-p', String(pid), '-o', 'command=']);
    return out.replace(/\n$/, '') === expectedCommand;
  } catch {
    return false;
  }
}

function isDeadByStat(pid: number): boolean {
  try {
    const stat = execCapture('ps', ['-o', 'stat=', '-p', String(pid)]).trim();
    return stat.length === 0 || stat.startsWith('Z');
  } catch {
    return true;
  }
}

function isUnderRoot(candidatePath: string, rootReal: string): boolean {
  try {
    const real = realpathSync(candidatePath);
    return real === rootReal || real.startsWith(rootReal + sep);
  } catch {
    return false;
  }
}

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

function parsePsSnapshot(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const match = PS_LINE_RE.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      tty: match[4]!,
      command: match[5]!,
    });
  }
  return rows;
}

/** Pairs of `p<pid>` / `n<path>` lines; `f<fdtype>` lines are ignored. */
function parseLsofCwdMap(output: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid: number | undefined;
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      const pid = Number(value);
      currentPid = Number.isInteger(pid) ? pid : undefined;
    } else if (tag === 'n' && currentPid !== undefined) {
      map.set(currentPid, value);
    }
  }
  return map;
}

function execCapture(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: MAX_BUFFER_BYTES,
  });
}

/**
 * `lsof -a -d cwd -Fpn` exits 1 whenever it can't read another user's
 * process (routine, not a failure) but still writes everything it could
 * read to stdout. execFileSync throws on that non-zero exit, so the usable
 * output has to be recovered from the error object.
 *
 * Any other failure (lsof missing, timeout, unexpected exit status)
 * degrades to an empty cwd map instead of propagating: R1 (cwd matching)
 * just finds nothing, while R2 (argv) and R3 (closure over R1) still run
 * against the `ps` snapshot. One optional signal being unavailable
 * shouldn't lose the whole sweep.
 */
function execLsofCwdSnapshot(): string {
  try {
    return execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BUFFER_BYTES,
    });
  } catch (cause) {
    const spawnError = cause as { status?: number | null; stdout?: string };
    if (spawnError.status === 1 && typeof spawnError.stdout === 'string') {
      return spawnError.stdout;
    }
    return '';
  }
}

/** Blocks the event loop for `ms` — deliberate: call sites are synchronous. */
function sleepSync(ms: number): void {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(flag, 0, 0, ms);
}
