import { existsSync } from 'node:fs';
import { readdir, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  epicBranchPatternFor,
  escapeRegexLiteral,
  loadConfig,
  type RecoverReport,
  RepoKernelError,
  sprintBranchPatternFor,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { atomicWriteText } from '../lifecycle/atomicWrite.js';
import { laneStateRoot, operationalRoot } from '../lifecycle/controlPaths.js';
import { git } from '../lifecycle/gitExec.js';
import { type JournalScanResult, scanAndHealJournals } from '../lifecycle/journal.js';
import { withLockRetrying } from '../lifecycle/locks.js';
import { listRunsWithCorruption } from '../lifecycle/runState.js';
import { reconcileTaskAliases } from './fastpath/taskAlias.js';
import { invalidatePreflightCache } from './preflight.js';
import type { CommandResult } from './validate.js';

export interface RecoverCommandOptions {
  readonly cwd: string;
  readonly preview: boolean;
  readonly apply: boolean;
  readonly json: boolean;
  readonly journalOnly?: boolean;
}

export interface RecoveryFinding {
  readonly kind:
    | 'corrupt_worktrees_json'
    | 'corrupt_run_file'
    | 'stale_lane_claim'
    | 'orphan_lane_pid'
    | 'pending_journal'
    | 'unrecoverable_journal'
    | 'replayed_journal'
    | 'stale_task_alias';
  readonly path: string;
  readonly detail: string;
  readonly suggestion: string;
}

export interface RecoveryAction {
  readonly kind:
    | 'quarantine_worktrees_json'
    | 'rebuild_worktrees_json'
    | 'quarantine_run_file'
    | 'release_stale_lane'
    | 'replay_journal_step'
    | 'mark_journal_done'
    | 'quarantine_journal'
    | 'reconcile_task_alias';
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

  const journalOnly = opts.journalOnly === true;

  // --apply mutates operational state. Take a recover-scoped lock so two
  // concurrent invocations (CI parallel jobs, accidental double-click,
  // watchdog re-trigger) cannot rebuild over each other.
  if (apply) {
    return withLockRetrying(
      'recover',
      opRoot,
      () => collectAndRepair({ cwd, opRoot, apply, json: opts.json === true, journalOnly }),
      { deadlineMs: 10_000 },
    );
  }

  return collectAndRepair({ cwd, opRoot, apply, json: opts.json === true, journalOnly });
}

async function collectAndRepair(input: {
  cwd: string;
  opRoot: string;
  apply: boolean;
  json: boolean;
  journalOnly: boolean;
}): Promise<CommandResult> {
  const { cwd, opRoot, apply, journalOnly } = input;
  const findings: RecoveryFinding[] = [];
  const actions: RecoveryAction[] = [];
  let journalResults: JournalScanResult[] = [];

  if (journalOnly) {
    journalResults = await runJournalPhase({ opRoot, apply, findings, actions });
    if (apply && (journalResults.some((j) => j.stepsApplied > 0) || actions.length > 0)) {
      await invalidatePreflightCache(opRoot);
    }
    if (apply) await writeRecoverReport(opRoot, journalResults);
    return formatResult({ findings, actions, apply, json: input.json });
  }

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

  // 4. journal phase — replay pending journals (or surface them in --preview)
  journalResults = await runJournalPhase({ opRoot, apply, findings, actions });

  // 5. plan-state reconciliation — stale fastpath aliases are not operational
  // corruption, but this is the recovery command users reach for after an
  // interrupted or out-of-order lifecycle sequence.
  await runTaskAliasPhase({ cwd, apply, findings, actions });

  if (apply && (actions.length > 0 || journalResults.some((j) => j.stepsApplied > 0))) {
    // Replayed steps may have written sprint/registry files the cache shadowed.
    await invalidatePreflightCache(opRoot);
  }

  if (apply) {
    await writeRecoverReport(opRoot, journalResults);
  }

  return formatResult({ findings, actions, apply, json: input.json });
}

async function runTaskAliasPhase(input: {
  cwd: string;
  apply: boolean;
  findings: RecoveryFinding[];
  actions: RecoveryAction[];
}): Promise<void> {
  const cfg = await loadConfig({ cwd: input.cwd }).catch(() => null);
  if (!cfg?.ok) return;

  const updates = await reconcileTaskAliases(input.cwd, cfg.config, { apply: input.apply });
  for (const update of updates) {
    const detail = `${update.id} status is ${update.previousStatus}; linked sprint ${update.alias.sprint_id} is ${update.nextStatus}`;
    input.findings.push({
      kind: 'stale_task_alias',
      path: update.path,
      detail,
      suggestion: 'rk recover --apply reconciles task alias status from the linked sprint',
    });
    if (input.apply) {
      input.actions.push({
        kind: 'reconcile_task_alias',
        path: update.path,
        detail,
      });
    }
  }
}

async function runJournalPhase(input: {
  opRoot: string;
  apply: boolean;
  findings: RecoveryFinding[];
  actions: RecoveryAction[];
}): Promise<JournalScanResult[]> {
  const { opRoot, apply, findings, actions } = input;
  const results = await scanAndHealJournals({ opRoot, apply });
  for (const r of results) {
    switch (r.classification) {
      case 'safe_replay':
        findings.push({
          kind: 'replayed_journal',
          path: r.path,
          detail: r.detail,
          suggestion: 'rk recover --apply replays the journal forward and renames it to .done.json',
        });
        if (apply) {
          actions.push({
            kind: 'replay_journal_step',
            path: r.path,
            detail: `${r.stepsApplied} step(s) replayed, ${r.stepsAlreadyApplied} already applied`,
          });
        }
        break;
      case 'already_applied':
        if (apply) {
          actions.push({
            kind: 'mark_journal_done',
            path: r.path,
            detail: 'all steps already on disk — marked complete and renamed to .done.json',
          });
        } else {
          findings.push({
            kind: 'replayed_journal',
            path: r.path,
            detail: 'all steps already applied — recover --apply will mark and rename',
            suggestion: 'rk recover --apply',
          });
        }
        break;
      case 'diverged':
        findings.push({
          kind: 'unrecoverable_journal',
          path: r.path,
          detail: r.detail,
          suggestion: 'inspect target files manually — recover quarantines this journal as unsafe',
        });
        if (apply && r.quarantinedPath) {
          actions.push({
            kind: 'quarantine_journal',
            path: r.quarantinedPath,
            detail: r.detail,
          });
        }
        break;
      case 'unknown_schema':
        findings.push({
          kind: 'pending_journal',
          path: r.path,
          detail: r.detail,
          suggestion:
            'upgrade rk to a version that supports this journal schemaVersion — file is left untouched',
        });
        break;
      case 'corrupt':
        findings.push({
          kind: 'unrecoverable_journal',
          path: r.path,
          detail: r.detail,
          suggestion: 'journal is unreadable or tampered — recover quarantines it',
        });
        if (apply && r.quarantinedPath) {
          actions.push({
            kind: 'quarantine_journal',
            path: r.quarantinedPath,
            detail: r.detail,
          });
        }
        break;
    }
  }
  return results;
}

async function writeRecoverReport(
  opRoot: string,
  journalResults: readonly JournalScanResult[],
): Promise<void> {
  const report: RecoverReport = {
    schemaVersion: 1,
    ranAt: new Date().toISOString(),
    apply: true,
    journals: journalResults.map((r) => ({
      opId: r.opId,
      path: r.path,
      classification: r.classification,
      detail: r.detail,
      stepsApplied: r.stepsApplied,
      stepsAlreadyApplied: r.stepsAlreadyApplied,
    })),
  };
  await atomicWriteText(
    join(opRoot, 'recover.report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

async function quarantine(path: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  // Add 6 bytes of entropy so two `rk recover --apply` invocations within
  // the same millisecond cannot rename onto each other's quarantine
  // sibling. POSIX `rename` is silent-overwrite-on-collision otherwise.
  const rand = Math.random().toString(36).slice(2, 8);
  const dest = `${path}.corrupt.${ts}.${rand}`;
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

  // Load config to anchor the branch-shape regex on the project's
  // configured `worktrees.branchPrefix`. Without this anchor, foreign
  // branches like `feature/E-001` get adopted as RK records and a later
  // `rk close` would try to release a branch it doesn't own.
  let branchMatchers = defaultBranchMatchers('rk/');
  try {
    const cfg = await loadConfig({ cwd });
    if (cfg.ok) {
      branchMatchers = [
        patternMatcher(
          epicBranchPatternFor(cfg.config.worktrees),
          cfg.config.worktrees.branchPrefix,
          'epic',
        ),
        patternMatcher(
          sprintBranchPatternFor(cfg.config.worktrees),
          cfg.config.worktrees.branchPrefix,
          'sprint',
        ),
      ].filter((m): m is BranchMatcher => m !== null);
    }
  } catch {
    // Fall back to default — if config is corrupt, we'd rather still
    // rebuild the rk/-prefixed records than refuse altogether.
  }

  try {
    const { stdout } = await git(['-C', cwd, 'worktree', 'list', '--porcelain']);
    let cur: { path?: string; branch?: string } = {};
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur.path) recordIfRk(cur, records, branchMatchers);
        cur = { path: line.slice('worktree '.length).trim() };
      } else if (line.startsWith('branch ')) {
        cur.branch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line.length === 0) {
        if (cur.path) recordIfRk(cur, records, branchMatchers);
        cur = {};
      }
    }
    if (cur.path) recordIfRk(cur, records, branchMatchers);
  } catch {
    // git worktree list failed — write an empty array so the file is at
    // least valid JSON. The operator can re-run after the git error
    // resolves.
  }

  const target = join(opRoot, 'worktrees.json');
  await atomicWriteText(target, JSON.stringify({ worktrees: records }, null, 2));
  return target;
}

interface BranchMatcher {
  readonly re: RegExp;
  readonly type: 'epic' | 'sprint';
  readonly captures: ReadonlyArray<'epicId' | 'sprintId'>;
}

function defaultBranchMatchers(branchPrefix: string): BranchMatcher[] {
  return [
    patternMatcher('{branchPrefix}epic/{epicId}', branchPrefix, 'epic'),
    patternMatcher('{branchPrefix}sprint/{epicId}/{sprintId}', branchPrefix, 'sprint'),
    patternMatcher('{branchPrefix}{epicId}/{sprintId}', branchPrefix, 'sprint'),
  ].filter((m): m is BranchMatcher => m !== null);
}

function patternMatcher(
  pattern: string,
  branchPrefix: string,
  type: 'epic' | 'sprint',
): BranchMatcher | null {
  const captures: Array<'epicId' | 'sprintId'> = [];
  let source = '^';
  let idx = 0;
  for (const match of pattern.matchAll(/\{([a-zA-Z]+)\}/g)) {
    const start = match.index ?? idx;
    source += escapeRegexLiteral(pattern.slice(idx, start));
    const token = match[1];
    if (token === 'branchPrefix') source += escapeRegexLiteral(branchPrefix);
    else if (token === 'epicId') {
      source += '(E-\\d+)';
      captures.push('epicId');
    } else if (token === 'sprintId') {
      source += '(S-\\d+)';
      captures.push('sprintId');
    } else return null;
    idx = start + match[0].length;
  }
  source += `${escapeRegexLiteral(pattern.slice(idx))}$`;
  return { re: new RegExp(source), type, captures };
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
  branchMatchers: readonly BranchMatcher[],
): void {
  if (!cur.path || !cur.branch) return;
  for (const matcher of branchMatchers) {
    const m = matcher.re.exec(cur.branch);
    if (!m) continue;
    let epicId: string | undefined;
    let sprintId: string | undefined;
    matcher.captures.forEach((kind, i) => {
      const value = m[i + 1];
      if (kind === 'epicId') epicId = value;
      if (kind === 'sprintId') sprintId = value;
    });
    if (epicId === undefined) return;
    out.push({
      path: cur.path,
      branch: cur.branch,
      epicId,
      ...(sprintId ? { sprintId, type: 'sprint' as const } : { type: matcher.type }),
    });
    return;
  }
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
