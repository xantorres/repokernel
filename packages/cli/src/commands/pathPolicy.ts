import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson, loadConfig } from '@repokernel/core';
import { EXIT_OK } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export interface PathPolicyCommandOptions {
  readonly cwd: string;
  readonly file: string;
}

/**
 * Classifies a single file path against the configured RepoKernel state paths.
 * Used by the agent state-protection hook (pre-tool-use.sh) so it stays correct
 * regardless of where the user has placed RK files via `rk init --dir`.
 *
 * Always emits JSON on stdout. Always exits 0 — failure to classify is itself
 * a `none` result, never a non-zero exit; we don't want a missing config to
 * break unrelated edits.
 */
export type PathPolicyKind =
  | 'registry'
  | 'run'
  | 'generated'
  | 'epic'
  | 'sprint'
  | 'queue'
  | 'review'
  | 'lane'
  | 'none';

interface PathPolicyResult {
  readonly kind: PathPolicyKind;
  readonly reason?: string;
}

const REASONS: Record<Exclude<PathPolicyKind, 'none'>, string> = {
  registry:
    'The registry is generated state. Use `rk registry --write` or `rk fix --apply --yes` to regenerate it.',
  run: 'Run logs are immutable. Inspect with `rk run inspect <RUN_ID>` or `rk run logs <RUN_ID>`.',
  generated: 'Generated files are rewritten by rk. Edit the source entity files instead.',
  sprint:
    'Sprint *frontmatter* (status, lane, depends_on, review_id, etc.) is owned by rk — use `rk start`, `rk gates`, `rk ship`, `rk close`, `rk reopen`, `rk cancel`, `rk sprint routing set`, `rk sprint routing clear`, or `rk fix --apply --yes`. Editing the sprint *body* (Markdown after the frontmatter) is fine — author it directly, or supply it at create time with `--body-file` / `--body`.',
  epic: 'Epic state mutations go through rk. Use `rk epic ship <E-NNN>`, `rk epic close <E-NNN>`, or `rk fix --apply --yes`. Edit epic *body* (markdown after frontmatter) is fine for documentation, but the frontmatter status / closed_at fields are owned by rk.',
  queue:
    'Queue mutations go through rk. Use `rk queue add`, `rk queue remove`, or `rk fix --apply --yes` instead of editing queue files directly.',
  review:
    'Review mutations go through rk. Use `rk review-verdict <R-NNN> <verdict>`, `rk review-evidence <R-NNN>`, or `rk review-reconcile` instead of editing review files directly.',
  lane: 'Lane state goes through rk. Use `rk lane acquire` / `rk lane release` instead of editing lane files directly.',
};

export async function runPathPolicyCommand(opts: PathPolicyCommandOptions): Promise<CommandResult> {
  try {
    const cwd = resolve(opts.cwd);
    const result = await classify(cwd, opts.file);
    return { exitCode: EXIT_OK, stdout: `${canonicalJson(result)}\n`, stderr: '' };
  } catch {
    // Always exits 0 — failure to classify is a `none` result, never an error.
    return { exitCode: EXIT_OK, stdout: `${canonicalJson({ kind: 'none' })}\n`, stderr: '' };
  }
}

async function classify(cwd: string, file: string): Promise<PathPolicyResult> {
  const cfg = await loadConfig({ cwd }).catch(() => null);
  if (!cfg || !cfg.ok) return { kind: 'none' };

  // Normalize via realpath on both ends so /var vs /private/var (macOS) and
  // similar symlinked-tmp setups don't cause spurious "outside project root"
  // misses. For paths that don't exist yet (Write at PreToolUse time), walk
  // up to the deepest existing ancestor and realpath that.
  const projectRoot = await realpathBest(cfg.cwd);
  const callerCwd = await realpathBest(cwd);
  const abs = await realpathBest(isAbsolute(file) ? resolve(file) : resolve(callerCwd, file));
  const rel = relative(projectRoot, abs);

  // Outside the project root entirely → nothing to police.
  if (rel.startsWith('..') || isAbsolute(rel)) return { kind: 'none' };

  const paths = cfg.config.paths;
  const normalized = rel.replaceAll('\\', '/');

  // Order matters: registry exact match first (it lives inside `generated`),
  // then run logs (also inside `generated`), then `generated` catch-all.
  if (matchesFile(normalized, paths.registry)) {
    return { kind: 'registry', reason: REASONS.registry };
  }
  if (matchesUnder(normalized, `${paths.generated}/runs`)) {
    return { kind: 'run', reason: REASONS.run };
  }
  // The plan/* dirs live under generated; classify them first so they aren't
  // swallowed by the generic `generated` rule.
  if (matchesUnder(normalized, paths.epics)) return { kind: 'epic', reason: REASONS.epic };
  if (matchesUnder(normalized, paths.sprints)) return { kind: 'sprint', reason: REASONS.sprint };
  if (matchesUnder(normalized, paths.queues)) return { kind: 'queue', reason: REASONS.queue };
  if (matchesUnder(normalized, paths.reviews)) return { kind: 'review', reason: REASONS.review };
  if (matchesUnder(normalized, paths.lanes)) return { kind: 'lane', reason: REASONS.lane };

  if (
    matchesUnder(normalized, `${paths.generated}/generated`) ||
    matchesFile(normalized, `${paths.generated}/authority.md`)
  ) {
    return { kind: 'generated', reason: REASONS.generated };
  }

  return { kind: 'none' };
}

async function realpathBest(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    const parentReal = await realpathBest(parent);
    return join(parentReal, basename(p));
  }
}

function normalizeConfigured(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/+$/, '');
}

function matchesFile(rel: string, configured: string): boolean {
  return rel === normalizeConfigured(configured);
}

function matchesUnder(rel: string, configured: string): boolean {
  const base = normalizeConfigured(configured);
  return rel === base || rel.startsWith(`${base}/`);
}
