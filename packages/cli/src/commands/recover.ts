import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { atomicWriteText } from '../lifecycle/atomicWrite.js';
import { laneStateRoot, operationalRoot } from '../lifecycle/controlPaths.js';
import { listRunsWithCorruption } from '../lifecycle/runState.js';
import type { CommandResult } from './validate.js';

const execFileAsync = promisify(execFile);

export interface RecoverCommandOptions {
  readonly cwd: string;
  readonly preview: boolean;
  readonly apply: boolean;
  readonly json: boolean;
}

export interface RecoveryFinding {
  readonly kind:
    | 'corrupt_worktrees_json'
    | 'corrupt_run_file'
    | 'stale_lane_claim'
    | 'orphan_lane_pid';
  readonly path: string;
  readonly detail: string;
  readonly suggestion: string;
}

export interface RecoveryAction {
  readonly kind:
    | 'quarantine_worktrees_json'
    | 'rebuild_worktrees_json'
    | 'quarantine_run_file'
    | 'release_stale_lane';
  readonly path: string;
  readonly detail: string;
}

interface LaneClaimEntry {
  readonly file: string;
  readonly run_id: string;
  readonly pid?: number;
}

/**
 * Audit and (optionally) repair operational state under
 * `<git-common-dir>/repokernel/`.
 *
 * Detects:
 *   - worktrees.json that fails to parse
 *   - RUN-NNN.json files that fail to parse or schema-validate
 *   - lane-state files whose owning run/pid is no longer alive
 *
 * `--preview` (default) reports findings only. `--apply` quarantines the
 * corrupt files as `<path>.corrupt.<isoUtcTimestamp>` before rewriting
 * (so nothing is destroyed) and rebuilds `worktrees.json` from
 * `git worktree list --porcelain`.
 */
export async function runRecoverCommand(opts: RecoverCommandOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  if (opts.preview && opts.apply) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: '--preview and --apply are mutually exclusive\n',
    };
  }
  const apply = opts.apply === true;

  let opRoot: string;
  try {
    opRoot = await operationalRoot(cwd);
  } catch (cause) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `${(cause as Error).message}\n`,
    };
  }

  const findings: RecoveryFinding[] = [];
  const actions: RecoveryAction[] = [];

  // 1. worktrees.json
  const worktreesJson = join(opRoot, 'worktrees.json');
  if (existsSync(worktreesJson)) {
    let parsed = false;
    try {
      JSON.parse(await readFile(worktreesJson, 'utf8'));
      parsed = true;
    } catch (cause) {
      findings.push({
        kind: 'corrupt_worktrees_json',
        path: worktreesJson,
        detail: `failed to parse: ${(cause as Error).message}`,
        suggestion: 'rk recover --apply rebuilds from `git worktree list --porcelain`',
      });
    }
    if (!parsed && apply) {
      const quarantined = await quarantine(worktreesJson);
      actions.push({
        kind: 'quarantine_worktrees_json',
        path: quarantined,
        detail: 'corrupt file moved aside before rebuild',
      });
      const rebuiltPath = await rebuildWorktreesJson(cwd, opRoot);
      actions.push({
        kind: 'rebuild_worktrees_json',
        path: rebuiltPath,
        detail: 'rebuilt from git worktree list --porcelain',
      });
    }
  }

  // 2. corrupt run files
  const runs = await listRunsWithCorruption(opRoot);
  for (const c of runs.corrupt) {
    findings.push({
      kind: 'corrupt_run_file',
      path: c.file,
      detail: c.reason,
      suggestion: 'rk recover --apply moves the file aside; the run becomes invisible to listRuns',
    });
    if (apply) {
      const quarantined = await quarantine(c.file);
      actions.push({
        kind: 'quarantine_run_file',
        path: quarantined,
        detail: c.reason,
      });
    }
  }

  // 3. stale lane claims
  const lanes = await readLaneClaims(opRoot);
  const runsById = new Map(runs.runs.map((r) => [r.id, r]));
  for (const lane of lanes) {
    const run = runsById.get(lane.run_id);
    const runTerminal =
      run !== undefined &&
      (run.status === 'completed' || run.status === 'aborted' || run.status === 'failed');
    const pidDead = lane.pid !== undefined && !isPidAlive(lane.pid);
    if (runTerminal || pidDead) {
      const reason = runTerminal
        ? `owner run ${lane.run_id} is ${run?.status}`
        : `owner pid ${lane.pid} is no longer alive`;
      findings.push({
        kind: pidDead ? 'orphan_lane_pid' : 'stale_lane_claim',
        path: lane.file,
        detail: reason,
        suggestion: 'rk recover --apply unlinks the lane claim file',
      });
      if (apply) {
        const quarantined = await quarantine(lane.file);
        actions.push({
          kind: 'release_stale_lane',
          path: quarantined,
          detail: reason,
        });
      }
    }
  }

  return formatResult({ findings, actions, apply, json: opts.json === true });
}

async function quarantine(path: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const dest = `${path}.corrupt.${ts}`;
  await rename(path, dest);
  return dest;
}

interface RebuildResult {
  readonly path: string;
}

async function rebuildWorktreesJson(cwd: string, opRoot: string): Promise<string> {
  const records: Array<{
    path: string;
    branch: string;
    epicId: string;
    sprintId?: string;
    type?: 'epic' | 'sprint';
  }> = [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'worktree', 'list', '--porcelain']);
    let cur: { path?: string; branch?: string } = {};
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur.path) recordIfRk(cur, records);
        cur = { path: line.slice('worktree '.length).trim() };
      } else if (line.startsWith('branch ')) {
        cur.branch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line.length === 0) {
        if (cur.path) recordIfRk(cur, records);
        cur = {};
      }
    }
    if (cur.path) recordIfRk(cur, records);
  } catch {
    // git worktree list failed — write an empty array so the file is at
    // least valid JSON. The operator can re-run after the git error
    // resolves.
  }

  const target = join(opRoot, 'worktrees.json');
  await atomicWriteText(target, JSON.stringify({ worktrees: records }, null, 2));
  return target;
}

function recordIfRk(
  cur: { path?: string; branch?: string },
  out: Array<{
    path: string;
    branch: string;
    epicId: string;
    sprintId?: string;
    type?: 'epic' | 'sprint';
  }>,
): void {
  if (!cur.path || !cur.branch) return;
  // RepoKernel branch shape: `<prefix>E-NNN[/S-NNN]`. We accept any
  // prefix and look for the canonical id pattern.
  const m = cur.branch.match(/E-(\d+)(?:[/]S-(\d+))?$/);
  if (!m) return;
  const epicId = `E-${m[1]}` as `E-${string}`;
  const sprintId = m[2] ? (`S-${m[2]}` as `S-${string}`) : undefined;
  out.push({
    path: cur.path,
    branch: cur.branch,
    epicId,
    ...(sprintId ? { sprintId, type: 'sprint' as const } : { type: 'epic' as const }),
  });
}

async function readLaneClaims(opRoot: string): Promise<LaneClaimEntry[]> {
  const dir = laneStateRoot(opRoot);
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: LaneClaimEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const path = join(dir, f);
    try {
      const raw = await readFile(path, 'utf8');
      const data = JSON.parse(raw) as { run_id?: unknown; pid?: unknown };
      if (typeof data.run_id !== 'string') continue;
      out.push({
        file: path,
        run_id: data.run_id,
        ...(typeof data.pid === 'number' ? { pid: data.pid } : {}),
      });
    } catch {
      // Skip — corrupt lane claim file is its own finding (future)
    }
  }
  return out;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EPERM';
  }
}

interface FormatInput {
  readonly findings: readonly RecoveryFinding[];
  readonly actions: readonly RecoveryAction[];
  readonly apply: boolean;
  readonly json: boolean;
}

function formatResult(input: FormatInput): CommandResult {
  const { findings, actions, apply, json } = input;
  if (json) {
    return {
      // After --apply, findings represent state that was just repaired,
      // so the command exits 0. In --preview, any finding is a problem
      // for the operator and we exit non-zero so CI scripts can pick it up.
      exitCode: apply || findings.length === 0 ? EXIT_OK : EXIT_FINDINGS,
      stdout: `${JSON.stringify({ findings, actions, apply }, null, 2)}\n`,
      stderr: '',
    };
  }

  if (findings.length === 0) {
    return {
      exitCode: EXIT_OK,
      stdout: 'rk recover: operational state looks healthy — nothing to fix.\n',
      stderr: '',
    };
  }

  const lines: string[] = [];
  lines.push(pc.bold(apply ? 'rk recover: applied repairs' : 'rk recover: preview only'));
  lines.push('');
  for (const f of findings) {
    lines.push(`${pc.yellow('•')} ${pc.bold(f.kind)}`);
    lines.push(`  Path:   ${f.path}`);
    lines.push(`  Reason: ${f.detail}`);
    if (!apply) lines.push(`  Fix:    ${f.suggestion}`);
    lines.push('');
  }
  if (apply) {
    lines.push(pc.bold('Actions taken:'));
    for (const a of actions) {
      lines.push(`  ${pc.green('✓')} ${a.kind}  ${a.path}`);
    }
    lines.push('');
  } else {
    lines.push(pc.dim('Re-run with --apply to repair.'));
    lines.push('');
  }

  return {
    exitCode: apply ? EXIT_OK : EXIT_FINDINGS,
    stdout: `${lines.join('\n')}`,
    stderr: '',
  };
}

// Throw-if-corrupt helper for `rk doctor` / `rk validate` to surface
// worktrees.json and run-state corruption without re-implementing the
// detection.
export async function detectOperationalCorruption(
  cwd: string,
): Promise<readonly RecoveryFinding[]> {
  let opRoot: string;
  try {
    opRoot = await operationalRoot(cwd);
  } catch {
    return [];
  }
  const findings: RecoveryFinding[] = [];

  const wt = join(opRoot, 'worktrees.json');
  if (existsSync(wt)) {
    try {
      JSON.parse(await readFile(wt, 'utf8'));
    } catch (cause) {
      findings.push({
        kind: 'corrupt_worktrees_json',
        path: wt,
        detail: `failed to parse: ${(cause as Error).message}`,
        suggestion: 'rk recover --preview',
      });
    }
  }

  try {
    const { corrupt } = await listRunsWithCorruption(opRoot);
    for (const c of corrupt) {
      findings.push({
        kind: 'corrupt_run_file',
        path: c.file,
        detail: c.reason,
        suggestion: 'rk recover --preview',
      });
    }
  } catch (cause) {
    if (!(cause instanceof RepoKernelError)) throw cause;
  }

  return findings;
}

export type { RebuildResult };
