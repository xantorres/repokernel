import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CONTEXT_BUDGET_SAFETY_FACTOR,
  CONTEXT_PROFILE_BUDGETS,
  CONTEXT_PROFILE_TARGET_RULES,
  type ContextDepStatus,
  type ContextImplementPacket,
  type ContextOmission,
  type ContextPacket,
  type ContextProfile,
  type ContextRelatedSprint,
  type ContextReviewChangedFilesSource,
  type ContextReviewPacket,
  type ContextScopedManifest,
  type ContextWavePacket,
  type ContextWaveSprint,
  canonicalJson,
  effectiveBudget as computeEffectiveBudget,
  estimateTokens,
  type Finding,
  type LoadProjectOutcome,
  type LoadProjectResult,
  loadProject,
  RepoKernelError,
  type Review,
  type Sprint,
  validateProject,
} from '@repokernel/core';
import {
  EXIT_BUDGET_EXCEEDED,
  EXIT_BUDGET_TOO_SMALL,
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_RUNTIME,
} from '../exitCodes.js';

const execFileAsync = promisify(execFile);

const SPRINT_ID_RE = /^S-\d{3,}$/;
const EPIC_ID_RE = /^E-\d{3,}$/;
const MANIFEST_CAP = 50;
const RELATED_CAP = 5;
const PARALLEL_SAFE_CAP = 10;

export interface ContextCommandOptions {
  readonly cwd: string;
  readonly target?: string;
  readonly profile?: ContextProfile;
  readonly format: 'md' | 'json';
  readonly budget?: number;
  readonly check: boolean;
  readonly validate: boolean;
  readonly schema?: ContextProfile;
  readonly runtimeVersion?: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ExitReason {
  readonly code: number;
  readonly name: string;
  readonly message: string;
}

function exitReasonJson(reason: ExitReason): string {
  return `${canonicalJson({ exit_reason: reason.name })}`;
}

function fail(reason: ExitReason, extraStderr = ''): CommandResult {
  return {
    exitCode: reason.code,
    stdout: '',
    stderr: `${reason.message}\n${extraStderr}${exitReasonJson(reason)}`,
  };
}

export async function runContextCommand(opts: ContextCommandOptions): Promise<CommandResult> {
  if (opts.schema !== undefined) {
    return { exitCode: EXIT_OK, stdout: renderJsonSchema(opts.schema), stderr: '' };
  }

  if (opts.target === undefined) {
    return fail({
      code: EXIT_RUNTIME,
      name: 'context_target_missing',
      message: 'rk context requires a target id (S-NNN or E-NNN), or --schema <profile>.',
    });
  }

  const profile = resolveProfile(opts);
  const targetCheck = validateProfileTarget(profile, opts.target);
  if (!targetCheck.ok) {
    return fail({
      code: EXIT_RUNTIME,
      name: 'context_profile_target_mismatch',
      message: targetCheck.message,
    });
  }

  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd: opts.cwd });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return fail({
        code: EXIT_RUNTIME,
        name: 'context_load_failed',
        message: e.message,
      });
    }
    throw e;
  }
  if (!outcome.ok) {
    return fail({
      code: EXIT_RUNTIME,
      name: 'context_load_failed',
      message: `failed to load project (${outcome.errorPhase}): ${outcome.findings[0]?.message ?? 'unknown error'}`,
    });
  }

  let validatorFindings: readonly Finding[] = outcome.parsed.findings;
  if (opts.validate) {
    try {
      const report = await validateProject({
        cwd: opts.cwd,
        ...(opts.runtimeVersion !== undefined ? { runtimeVersion: opts.runtimeVersion } : {}),
      });
      validatorFindings = report.findings;
    } catch (e) {
      if (e instanceof RepoKernelError) {
        return fail({
          code: EXIT_RUNTIME,
          name: 'context_validate_failed',
          message: e.message,
        });
      }
      throw e;
    }
  }

  const rawBudget = opts.budget ?? CONTEXT_PROFILE_BUDGETS[profile];
  if (rawBudget <= 0) {
    return fail({
      code: EXIT_RUNTIME,
      name: 'context_budget_invalid',
      message: `--budget must be positive, got ${rawBudget}`,
    });
  }
  const effective = computeEffectiveBudget(rawBudget);
  if (effective <= 0) {
    return fail({
      code: EXIT_RUNTIME,
      name: 'context_budget_invalid',
      message: `effective budget computed to ${effective} (raw ${rawBudget}); raise --budget`,
    });
  }

  let packet: ContextPacket;
  let findingsBreaching = false;
  switch (profile) {
    case 'implement': {
      const built = await buildImplementPacket({
        cwd: opts.cwd,
        target: opts.target,
        project: outcome,
        findings: validatorFindings,
        effective,
        validate: opts.validate,
      });
      if ('error' in built) return fail(built.error);
      packet = built.packet;
      findingsBreaching = built.breaching;
      break;
    }
    case 'review': {
      const built = await buildReviewPacket({
        cwd: opts.cwd,
        target: opts.target,
        project: outcome,
        findings: validatorFindings,
        effective,
        validate: opts.validate,
      });
      if ('error' in built) return fail(built.error);
      packet = built.packet;
      findingsBreaching = built.breaching;
      break;
    }
    case 'wave': {
      const built = buildWavePacket({
        target: opts.target,
        project: outcome,
        findings: validatorFindings,
        effective,
        validate: opts.validate,
      });
      if ('error' in built) return fail(built.error);
      packet = built.packet;
      findingsBreaching = built.breaching;
      break;
    }
  }

  // Estimate full render first.
  let rendered = renderPacket(packet, opts.format);
  const fullTokens = estimateTokens(rendered);

  if (opts.check) {
    // --check: do not omit. Fail with the right code.
    if (fullTokens > effective) {
      const essentialTokens = estimateEssentialTokens(packet, opts.format);
      if (essentialTokens > effective) {
        const stderr = `essential capsule (${essentialTokens} tokens) exceeds effective budget (${effective}); raise --budget\n`;
        return fail({
          code: EXIT_BUDGET_TOO_SMALL,
          name: 'context_budget_too_small',
          message: stderr.trimEnd(),
        });
      }
      const stderr = `rendered ${fullTokens} tokens > effective budget ${effective}\n`;
      return {
        exitCode: EXIT_BUDGET_EXCEEDED,
        stdout: '',
        stderr: `${stderr}${exitReasonJson({
          code: EXIT_BUDGET_EXCEEDED,
          name: 'context_budget_exceeded',
          message: '',
        })}`,
      };
    }
    // fits — fall through to render full.
    packet = setEstimatedTokens(packet, fullTokens);
    rendered = renderPacket(packet, opts.format);
    return {
      exitCode: findingsBreaching && opts.validate ? EXIT_FINDINGS : EXIT_OK,
      stdout: rendered,
      stderr:
        findingsBreaching && opts.validate
          ? `validation findings present (P0/P1)\n${exitReasonJson({
              code: EXIT_FINDINGS,
              name: 'context_validation_findings',
              message: '',
            })}`
          : '',
    };
  }

  // Default (no --check): apply opportunistic omissions to fit, print result.
  let omissionsApplied: ContextOmission[] = [];
  let tokens = fullTokens;
  if (fullTokens > effective) {
    const reduced = reduceForBudget(packet, effective, opts.format);
    if (reduced.essentialOverflow) {
      const stderr = `essential capsule (${reduced.essentialTokens} tokens) exceeds effective budget (${effective}); raise --budget\n`;
      return fail({
        code: EXIT_BUDGET_TOO_SMALL,
        name: 'context_budget_too_small',
        message: stderr.trimEnd(),
      });
    }
    packet = reduced.packet;
    rendered = reduced.rendered;
    tokens = reduced.tokens;
    omissionsApplied = reduced.omissions;
  }

  packet = setEstimatedTokens(packet, tokens);
  rendered = renderPacket(packet, opts.format);

  const omissionStderr = omissionsApplied
    .map((o) => `omitted: ${o.section} — ${o.reason}`)
    .join('\n');

  // Validation findings exit gate (only when --validate).
  if (opts.validate && findingsBreaching) {
    const stderr = `${omissionStderr ? `${omissionStderr}\n` : ''}validation findings present (P0/P1)\n`;
    return {
      exitCode: EXIT_FINDINGS,
      stdout: rendered,
      stderr: `${stderr}${exitReasonJson({
        code: EXIT_FINDINGS,
        name: 'context_validation_findings',
        message: '',
      })}`,
    };
  }

  return {
    exitCode: EXIT_OK,
    stdout: rendered,
    stderr: omissionStderr ? `${omissionStderr}\n` : '',
  };
}

function resolveProfile(opts: ContextCommandOptions): ContextProfile {
  if (opts.profile !== undefined) return opts.profile;
  if (opts.target && EPIC_ID_RE.test(opts.target)) return 'wave';
  return 'implement';
}

function validateProfileTarget(
  profile: ContextProfile,
  target: string,
): { ok: true } | { ok: false; message: string } {
  const expect = CONTEXT_PROFILE_TARGET_RULES[profile];
  if (expect === 'sprint' && !SPRINT_ID_RE.test(target)) {
    return {
      ok: false,
      message: `CONTEXT_PROFILE_TARGET_MISMATCH: profile "${profile}" requires a sprint id like S-001, got "${target}". Example: rk context S-001 --profile ${profile}`,
    };
  }
  if (expect === 'epic' && !EPIC_ID_RE.test(target)) {
    return {
      ok: false,
      message: `CONTEXT_PROFILE_TARGET_MISMATCH: profile "${profile}" requires an epic id like E-001, got "${target}". Example: rk context E-001 --profile ${profile}`,
    };
  }
  return { ok: true };
}

// — implement packet —

interface BuildImplementInput {
  readonly cwd: string;
  readonly target: string;
  readonly project: LoadProjectResult;
  readonly findings: readonly Finding[];
  readonly effective: number;
  readonly validate: boolean;
}

interface BuildResult<T extends ContextPacket> {
  readonly packet: T;
  readonly breaching: boolean;
}

async function buildImplementPacket(
  input: BuildImplementInput,
): Promise<BuildResult<ContextImplementPacket> | { error: ExitReason }> {
  const sprint = input.project.parsed.sprints.find((s) => s.id === input.target);
  if (!sprint) {
    return {
      error: {
        code: EXIT_RUNTIME,
        name: 'context_sprint_not_found',
        message: `sprint ${input.target} not found in project`,
      },
    };
  }
  const epic = input.project.parsed.epics.find((e) => e.id === sprint.epic_id);
  const epicTitle = epic?.title ?? '';

  const allSprints = input.project.parsed.sprints;
  const deps = sortDeps(sprint.depends_on.map((id) => buildDepStatus(id, allSprints)));
  const blockers = sortDeps(sprint.blocked_by.map((id) => buildDepStatus(id, allSprints)));

  const targetFindings = filterFindingsForEntity(input.findings, sprint.id, sprint.epic_id);

  const manifest = await buildScopedManifest(input.cwd, sprint.allowed_paths);
  const related = buildRelatedSprints(sprint, allSprints);
  const objective = singleLine(sprint.title);
  const objectiveExcerpt = truncate(sprint.body.trim(), 400);
  const minimalCommands = buildImplementCommands(sprint);

  const breaching = targetFindings.some((f) => f.severity === 'P0' || f.severity === 'P1');

  const packet: ContextImplementPacket = {
    profile: 'implement',
    target: sprint.id,
    capsule: {
      id: sprint.id,
      status: sprint.status,
      lane: sprint.lane,
      objective,
      epic_id: sprint.epic_id,
      epic_title: epicTitle,
      allowed_paths: [...sprint.allowed_paths].sort(),
      denied_paths: [...sprint.denied_paths].sort(),
      deps,
      blockers,
      review_required: sprint.review_required,
      minimal_commands: minimalCommands,
    },
    objective_excerpt: objectiveExcerpt || undefined,
    findings: [...targetFindings],
    related_sprints: related,
    scoped_manifest: manifest,
    omissions: [],
    estimated_tokens: 0,
    effective_budget: input.effective,
  };
  return { packet, breaching };
}

function buildDepStatus(id: string, sprints: readonly Sprint[]): ContextDepStatus {
  const found = sprints.find((s) => s.id === id);
  if (!found) return { id, status: 'missing' };
  return { id, status: found.status };
}

function sortDeps(deps: ContextDepStatus[]): ContextDepStatus[] {
  return [...deps].sort((a, b) => a.id.localeCompare(b.id));
}

function buildRelatedSprints(target: Sprint, all: readonly Sprint[]): ContextRelatedSprint[] {
  const out: ContextRelatedSprint[] = [];
  for (const s of all) {
    if (s.id === target.id) continue;
    if (s.status !== 'shipped') continue;
    if (s.epic_id !== target.epic_id) continue;
    const isDep =
      target.depends_on.includes(s.id) ||
      target.blocked_by.includes(s.id) ||
      s.depends_on.includes(target.id) ||
      s.blocked_by.includes(target.id);
    const overlap = pathsOverlap(target.allowed_paths, s.allowed_paths);
    if (!isDep && !overlap) continue;
    out.push({
      id: s.id,
      title: s.title,
      closed_at: s.closed_at ?? null,
      relation: isDep ? 'dep' : 'path_overlap',
    });
  }
  out.sort((a, b) => {
    const aDate = a.closed_at ?? '';
    const bDate = b.closed_at ?? '';
    const cmp = bDate.localeCompare(aDate);
    if (cmp !== 0) return cmp;
    return a.id.localeCompare(b.id);
  });
  return out.slice(0, RELATED_CAP);
}

function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const aSet = new Set(a);
  for (const p of b) {
    if (aSet.has(p)) return true;
  }
  return false;
}

async function buildScopedManifest(
  cwd: string,
  allowedPaths: readonly string[],
): Promise<ContextScopedManifest> {
  if (allowedPaths.length === 0) {
    return { files: [], omitted_count: 0, available: false };
  }
  const collected = new Set<string>();
  for (const glob of allowedPaths) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'ls-files', '--', glob]);
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) collected.add(trimmed.split('\\').join('/'));
      }
    } catch {
      // ls-files may fail in non-git or empty fixtures — skip gracefully.
    }
  }
  const all = [...collected].sort();
  const files = all.slice(0, MANIFEST_CAP);
  const omitted_count = all.length - files.length;
  return { files, omitted_count, available: true };
}

function buildImplementCommands(sprint: Sprint): string[] {
  return [
    `rk validate --fail-on P0,P1`,
    `rk start ${sprint.id}`,
    `rk run ${sprint.id} --strict`,
    `rk review ${sprint.id}`,
    `rk close ${sprint.id}`,
  ];
}

// — review packet —

interface BuildReviewInput extends BuildImplementInput {}

async function buildReviewPacket(
  input: BuildReviewInput,
): Promise<BuildResult<ContextReviewPacket> | { error: ExitReason }> {
  const sprint = input.project.parsed.sprints.find((s) => s.id === input.target);
  if (!sprint) {
    return {
      error: {
        code: EXIT_RUNTIME,
        name: 'context_sprint_not_found',
        message: `sprint ${input.target} not found in project`,
      },
    };
  }
  const review = sprint.review_id
    ? input.project.parsed.reviews.find((r) => r.id === sprint.review_id)
    : input.project.parsed.reviews.find((r) => r.sprint_id === sprint.id);

  const baseSha = review?.base_sha ?? sprint.base_sha ?? null;
  const endSha = review?.end_sha ?? sprint.end_sha ?? null;

  const changedResolved = await resolveChangedFiles({
    cwd: input.cwd,
    sprintId: sprint.id,
    review: review ?? null,
    baseSha,
    endSha,
  });
  const sortedChanged = [...changedResolved.files].sort();
  const cappedChanged = sortedChanged.slice(0, MANIFEST_CAP);
  const changed_files_omitted = sortedChanged.length - cappedChanged.length;

  const reviewFindings: Finding[] = (review?.findings ?? []).map((f) => ({
    severity: severityFromReview(f.severity),
    code: 'PARSER_FAILURE',
    message: f.message,
    entityType: 'review',
    entityId: review?.id,
  }));

  const acceptance = singleLine(extractAcceptance(sprint.body) || sprint.title);

  const breaching = (review?.findings ?? []).some(
    (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH',
  );

  const packet: ContextReviewPacket = {
    profile: 'review',
    target: sprint.id,
    capsule: {
      id: sprint.id,
      sprint_status: sprint.status,
      review_id: review?.id ?? null,
      verdict: review?.verdict ?? null,
      base_sha: baseSha,
      end_sha: endSha,
      acceptance,
      changed_files: cappedChanged,
      changed_files_source: changedResolved.source,
      changed_files_omitted,
      verification_commands: [
        `rk inspect ${sprint.id}`,
        `rk validate --fail-on P0,P1`,
        review ? `rk review-verdict ${review.id} accepted` : `rk review ${sprint.id}`,
      ],
    },
    review_findings: reviewFindings,
    omissions: [],
    estimated_tokens: 0,
    effective_budget: input.effective,
  };
  return { packet, breaching };
}

function severityFromReview(s: string): Finding['severity'] {
  switch (s) {
    case 'CRITICAL':
      return 'P0';
    case 'HIGH':
      return 'P1';
    case 'MEDIUM':
      return 'P2';
    default:
      return 'P3';
  }
}

interface ResolveChangedInput {
  readonly cwd: string;
  readonly sprintId: string;
  readonly review: Review | null;
  readonly baseSha: string | null;
  readonly endSha: string | null;
}

interface ResolveChangedResult {
  readonly files: readonly string[];
  readonly source: ContextReviewChangedFilesSource;
}

async function resolveChangedFiles(input: ResolveChangedInput): Promise<ResolveChangedResult> {
  if (input.review?.changed_files && input.review.changed_files.length > 0) {
    return { files: [...input.review.changed_files], source: 'review_committed' };
  }
  if (input.baseSha && input.endSha) {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        input.cwd,
        'diff',
        '--name-only',
        `${input.baseSha}..${input.endSha}`,
      ]);
      const files = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (files.length > 0) return { files, source: 'git_diff' };
    } catch {
      // fall through to next source
    }
  }
  const head = await readWorktreeHead(input.cwd, input.sprintId);
  if (head && input.baseSha) {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        input.cwd,
        'diff',
        '--name-only',
        `${input.baseSha}..${head}`,
      ]);
      const files = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (files.length > 0) return { files, source: 'worktree_head' };
    } catch {
      // fall through
    }
  }
  return { files: [], source: 'unavailable' };
}

interface WorktreeRecord {
  readonly type?: 'epic' | 'sprint';
  readonly sprintId?: string;
  readonly path?: string;
}

async function readWorktreeHead(cwd: string, sprintId: string): Promise<string | null> {
  const candidates = [
    join(cwd, '.repokernel', 'op', 'worktrees.json'),
    join(cwd, '.repokernel', 'worktrees.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      const data = JSON.parse(raw) as { worktrees?: WorktreeRecord[] };
      const record = data.worktrees?.find((w) => w.type === 'sprint' && w.sprintId === sprintId);
      if (record?.path) {
        try {
          const { stdout } = await execFileAsync('git', ['-C', record.path, 'rev-parse', 'HEAD']);
          const sha = stdout.trim();
          if (/^[0-9a-f]{7,}$/.test(sha)) return sha;
        } catch {
          // ignore
        }
      }
    } catch {
      // file missing or unreadable — try next candidate
    }
  }
  return null;
}

function extractAcceptance(body: string): string {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^#+\s+acceptance/i.test(line)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = (lines[j] ?? '').trim();
        if (next.length > 0) return next.replace(/^[-*]\s*/, '');
      }
    }
  }
  return '';
}

// — wave packet —

interface BuildWaveInput {
  readonly target: string;
  readonly project: LoadProjectResult;
  readonly findings: readonly Finding[];
  readonly effective: number;
  readonly validate: boolean;
}

function buildWavePacket(
  input: BuildWaveInput,
): BuildResult<ContextWavePacket> | { error: ExitReason } {
  const epic = input.project.parsed.epics.find((e) => e.id === input.target);
  if (!epic) {
    return {
      error: {
        code: EXIT_RUNTIME,
        name: 'context_epic_not_found',
        message: `epic ${input.target} not found in project`,
      },
    };
  }
  const sprints = input.project.parsed.sprints.filter((s) => s.epic_id === epic.id);
  const all = input.project.parsed.sprints;
  const lanes = input.project.parsed.lanes;

  const runnable: ContextWaveSprint[] = [];
  const blocked: ContextWaveSprint[] = [];
  const gated: ContextWaveSprint[] = [];
  const planned: ContextWaveSprint[] = [];

  // Bucket rule:
  //   shipped / cancelled → skipped (terminal)
  //   gated              → gated
  //   blocked deps       → blocked
  //   active/review      → runnable (in flight)
  //   pending/queued     → runnable (next to pick up)
  //   planned no blocker → runnable (ready)
  //   reopened           → runnable
  // The `planned` bucket is left for sprints intentionally held back via
  // future config (epic execution_strategy gates, etc.); it stays empty in v1.
  for (const s of sprints) {
    const base = { id: s.id, title: s.title, lane: s.lane, status: s.status };
    if (s.status === 'shipped' || s.status === 'cancelled') continue;
    const blockReasons = blockingReasons(s, all);
    if (s.gate) {
      gated.push({ ...base, reason: `gate ${s.gate}` });
      continue;
    }
    if (blockReasons.length > 0) {
      blocked.push({ ...base, reason: blockReasons.join('; ') });
      continue;
    }
    runnable.push(base);
  }

  runnable.sort((a, b) => a.id.localeCompare(b.id));
  blocked.sort((a, b) => a.id.localeCompare(b.id));
  gated.sort((a, b) => a.id.localeCompare(b.id));
  planned.sort((a, b) => a.id.localeCompare(b.id));

  const parallelSafeAll = parallelSafeCandidates(runnable, sprints, lanes);
  const parallel_safe = parallelSafeAll.slice(0, PARALLEL_SAFE_CAP);
  const parallel_safe_omitted = parallelSafeAll.length - parallel_safe.length;

  const findings = input.findings.filter((f) => f.entityType === 'epic' && f.entityId === epic.id);
  const breaching = findings.some((f) => f.severity === 'P0' || f.severity === 'P1');

  const packet: ContextWavePacket = {
    profile: 'wave',
    target: epic.id,
    capsule: {
      id: epic.id,
      title: epic.title,
      status: epic.status,
      runnable,
      blocked,
      gated,
      planned,
      parallel_safe,
      parallel_safe_omitted,
      minimal_commands: [
        `rk validate --fail-on P0,P1`,
        `rk epic status ${epic.id}`,
        `rk next --epic ${epic.id}`,
      ],
    },
    findings: [...findings],
    omissions: [],
    estimated_tokens: 0,
    effective_budget: input.effective,
  };
  return { packet, breaching };
}

function blockingReasons(s: Sprint, all: readonly Sprint[]): string[] {
  const reasons: string[] = [];
  for (const dep of s.depends_on) {
    const found = all.find((x) => x.id === dep);
    if (!found) reasons.push(`dep ${dep} missing`);
    else if (found.status !== 'shipped') reasons.push(`dep ${dep} ${found.status}`);
  }
  for (const dep of s.blocked_by) {
    const found = all.find((x) => x.id === dep);
    if (!found) reasons.push(`blocker ${dep} missing`);
    else if (found.status !== 'shipped') reasons.push(`blocker ${dep} ${found.status}`);
  }
  return reasons;
}

function parallelSafeCandidates(
  runnable: ContextWaveSprint[],
  sprintsInEpic: readonly Sprint[],
  lanes: readonly { name: string }[],
): ContextWaveSprint[] {
  const result: ContextWaveSprint[] = [];
  const usedLanes = new Set<string>();
  const consumedPaths = new Set<string>();
  const laneNames = new Set(lanes.map((l) => l.name));
  for (const candidate of runnable) {
    if (laneNames.size > 0 && usedLanes.has(candidate.lane)) continue;
    const sprint = sprintsInEpic.find((s) => s.id === candidate.id);
    if (!sprint) continue;
    const overlaps = sprint.allowed_paths.some((p) => consumedPaths.has(p));
    if (overlaps) continue;
    result.push(candidate);
    usedLanes.add(candidate.lane);
    for (const p of sprint.allowed_paths) consumedPaths.add(p);
  }
  return result;
}

// — finding utilities —

function filterFindingsForEntity(
  findings: readonly Finding[],
  sprintId: string,
  epicId: string,
): Finding[] {
  return findings
    .filter((f) => {
      if (f.entityId === sprintId) return true;
      if (f.entityType === 'epic' && f.entityId === epicId) return true;
      return false;
    })
    .filter((f) => f.severity === 'P0' || f.severity === 'P1');
}

// — rendering —

function renderPacket(packet: ContextPacket, format: 'md' | 'json'): string {
  if (format === 'json') return canonicalJson(packet);
  return renderMarkdown(packet);
}

function renderMarkdown(packet: ContextPacket): string {
  switch (packet.profile) {
    case 'implement':
      return renderImplementMarkdown(packet);
    case 'review':
      return renderReviewMarkdown(packet);
    case 'wave':
      return renderWaveMarkdown(packet);
  }
}

function renderImplementMarkdown(p: ContextImplementPacket): string {
  const lines: string[] = [];
  lines.push(`# Sprint ${p.capsule.id} — implement context`);
  lines.push('');
  lines.push(`- Status: ${p.capsule.status}`);
  lines.push(`- Lane: ${p.capsule.lane}`);
  lines.push(`- Epic: ${p.capsule.epic_id} ${p.capsule.epic_title}`);
  lines.push(`- Review required: ${p.capsule.review_required}`);
  lines.push('');
  lines.push(`## Objective`);
  lines.push(p.capsule.objective);
  if (p.objective_excerpt) {
    lines.push('');
    lines.push(p.objective_excerpt);
  }
  lines.push('');
  lines.push(`## Allowed paths`);
  if (p.capsule.allowed_paths.length === 0) lines.push('_(none)_');
  else for (const a of p.capsule.allowed_paths) lines.push(`- ${a}`);
  if (p.capsule.denied_paths.length > 0) {
    lines.push('');
    lines.push(`## Denied paths`);
    for (const d of p.capsule.denied_paths) lines.push(`- ${d}`);
  }
  lines.push('');
  lines.push(`## Dependencies`);
  if (p.capsule.deps.length === 0) lines.push('_(none)_');
  else for (const d of p.capsule.deps) lines.push(`- ${d.id} (${d.status})`);
  if (p.capsule.blockers.length > 0) {
    lines.push('');
    lines.push(`## Blockers`);
    for (const d of p.capsule.blockers) lines.push(`- ${d.id} (${d.status})`);
  }
  lines.push('');
  lines.push(`## Scoped file manifest`);
  if (!p.scoped_manifest.available) {
    lines.push('_(no scoped manifest available — sprint has no allowed_paths)_');
  } else if (p.scoped_manifest.files.length === 0) {
    lines.push('_(no files matched allowed_paths)_');
  } else {
    for (const f of p.scoped_manifest.files) lines.push(`- ${f}`);
    if (p.scoped_manifest.omitted_count > 0) {
      lines.push('');
      lines.push(
        `_${p.scoped_manifest.omitted_count} additional files omitted (cap ${MANIFEST_CAP})_`,
      );
    }
  }
  if (p.findings.length > 0) {
    lines.push('');
    lines.push(`## Findings (P0/P1)`);
    for (const f of p.findings) lines.push(`- [${f.severity}] ${f.code}: ${f.message}`);
  }
  if (p.related_sprints.length > 0) {
    lines.push('');
    lines.push(`## Related shipped sprints`);
    for (const r of p.related_sprints) {
      lines.push(`- ${r.id} ${r.title} (${r.relation}${r.closed_at ? `, ${r.closed_at}` : ''})`);
    }
  }
  lines.push('');
  lines.push(`## Minimal commands`);
  for (const c of p.capsule.minimal_commands) lines.push(`- \`${c}\``);
  if (p.omissions.length > 0) {
    lines.push('');
    lines.push(`## Omissions`);
    for (const o of p.omissions) lines.push(`- ${o.section}: ${o.reason}`);
  }
  lines.push('');
  lines.push(`_estimated_tokens: ${p.estimated_tokens} / effective_budget: ${p.effective_budget}_`);
  return `${lines.join('\n')}\n`;
}

function renderReviewMarkdown(p: ContextReviewPacket): string {
  const lines: string[] = [];
  lines.push(`# Sprint ${p.capsule.id} — review context`);
  lines.push('');
  lines.push(`- Sprint status: ${p.capsule.sprint_status}`);
  lines.push(`- Review id: ${p.capsule.review_id ?? '(none)'}`);
  lines.push(`- Verdict: ${p.capsule.verdict ?? '(none)'}`);
  lines.push(`- base_sha: ${p.capsule.base_sha ?? '(unset)'}`);
  lines.push(`- end_sha: ${p.capsule.end_sha ?? '(unset)'}`);
  lines.push('');
  lines.push(`## Acceptance`);
  lines.push(p.capsule.acceptance);
  lines.push('');
  lines.push(`## Changed files (source: ${p.capsule.changed_files_source})`);
  if (p.capsule.changed_files_source === 'unavailable') {
    lines.push(
      '_(changed files unavailable — review.changed_files empty, no SHA range, no live worktree)_',
    );
  } else if (p.capsule.changed_files.length === 0) {
    lines.push('_(no changed files)_');
  } else {
    for (const f of p.capsule.changed_files) lines.push(`- ${f}`);
    if (p.capsule.changed_files_omitted > 0) {
      lines.push('');
      lines.push(
        `_${p.capsule.changed_files_omitted} additional files omitted (cap ${MANIFEST_CAP})_`,
      );
    }
  }
  if (p.review_findings.length > 0) {
    lines.push('');
    lines.push(`## Review findings`);
    for (const f of p.review_findings) lines.push(`- [${f.severity}] ${f.message}`);
  }
  lines.push('');
  lines.push(`## Verification commands`);
  for (const c of p.capsule.verification_commands) lines.push(`- \`${c}\``);
  if (p.omissions.length > 0) {
    lines.push('');
    lines.push(`## Omissions`);
    for (const o of p.omissions) lines.push(`- ${o.section}: ${o.reason}`);
  }
  lines.push('');
  lines.push(`_estimated_tokens: ${p.estimated_tokens} / effective_budget: ${p.effective_budget}_`);
  return `${lines.join('\n')}\n`;
}

function renderWaveMarkdown(p: ContextWavePacket): string {
  const lines: string[] = [];
  lines.push(`# Epic ${p.capsule.id} — wave context`);
  lines.push('');
  lines.push(`- Title: ${p.capsule.title}`);
  lines.push(`- Status: ${p.capsule.status}`);
  lines.push('');
  lines.push(`## Runnable`);
  if (p.capsule.runnable.length === 0) lines.push('_(none)_');
  else
    for (const s of p.capsule.runnable)
      lines.push(`- ${s.id} (${s.status}, lane ${s.lane}) — ${s.title}`);
  lines.push('');
  lines.push(`## Parallel-safe candidates`);
  if (p.capsule.parallel_safe.length === 0) lines.push('_(none)_');
  else
    for (const s of p.capsule.parallel_safe) lines.push(`- ${s.id} (lane ${s.lane}) — ${s.title}`);
  if (p.capsule.parallel_safe_omitted > 0) {
    lines.push(
      `_${p.capsule.parallel_safe_omitted} additional candidates omitted (cap ${PARALLEL_SAFE_CAP})_`,
    );
  }
  if (p.capsule.blocked.length > 0) {
    lines.push('');
    lines.push(`## Blocked`);
    for (const s of p.capsule.blocked) lines.push(`- ${s.id} — ${s.reason ?? 'blocked'}`);
  }
  if (p.capsule.gated.length > 0) {
    lines.push('');
    lines.push(`## Gated`);
    for (const s of p.capsule.gated) lines.push(`- ${s.id} — ${s.reason ?? 'gated'}`);
  }
  if (p.capsule.planned.length > 0) {
    lines.push('');
    lines.push(`## Planned`);
    for (const s of p.capsule.planned) lines.push(`- ${s.id} — ${s.title}`);
  }
  if (p.findings.length > 0) {
    lines.push('');
    lines.push(`## Findings (P0/P1)`);
    for (const f of p.findings) lines.push(`- [${f.severity}] ${f.code}: ${f.message}`);
  }
  lines.push('');
  lines.push(`## Minimal commands`);
  for (const c of p.capsule.minimal_commands) lines.push(`- \`${c}\``);
  if (p.omissions.length > 0) {
    lines.push('');
    lines.push(`## Omissions`);
    for (const o of p.omissions) lines.push(`- ${o.section}: ${o.reason}`);
  }
  lines.push('');
  lines.push(`_estimated_tokens: ${p.estimated_tokens} / effective_budget: ${p.effective_budget}_`);
  return `${lines.join('\n')}\n`;
}

// — budget reduction —

interface ReduceResult {
  readonly packet: ContextPacket;
  readonly rendered: string;
  readonly tokens: number;
  readonly omissions: ContextOmission[];
  readonly essentialOverflow: boolean;
  readonly essentialTokens: number;
}

function reduceForBudget(
  original: ContextPacket,
  effective: number,
  format: 'md' | 'json',
): ReduceResult {
  const omissions: ContextOmission[] = [];
  let working = original;
  let rendered = renderPacket(working, format);
  let tokens = estimateTokens(rendered);

  const omitSteps = buildOmitSteps(working);
  for (const step of omitSteps) {
    if (tokens <= effective) break;
    working = step.apply(working);
    omissions.push({ section: step.section, reason: step.reason });
    rendered = renderPacket({ ...working, omissions } as ContextPacket, format);
    tokens = estimateTokens(rendered);
  }
  working = { ...working, omissions } as ContextPacket;
  rendered = renderPacket(working, format);
  tokens = estimateTokens(rendered);

  if (tokens <= effective) {
    return {
      packet: working,
      rendered,
      tokens,
      omissions,
      essentialOverflow: false,
      essentialTokens: tokens,
    };
  }

  // Compute essential-only tokens to decide whether to fail with TOO_SMALL.
  const essentialOnly = stripToEssential(working);
  const essentialRendered = renderPacket(essentialOnly, format);
  const essentialTokens = estimateTokens(essentialRendered);
  if (essentialTokens > effective) {
    return {
      packet: working,
      rendered,
      tokens,
      omissions,
      essentialOverflow: true,
      essentialTokens,
    };
  }
  return {
    packet: working,
    rendered,
    tokens,
    omissions,
    essentialOverflow: false,
    essentialTokens,
  };
}

interface OmitStep {
  readonly section: string;
  readonly reason: string;
  readonly apply: (p: ContextPacket) => ContextPacket;
}

function buildOmitSteps(p: ContextPacket): OmitStep[] {
  if (p.profile === 'implement') {
    return [
      {
        section: 'related_sprints',
        reason: 'budget',
        apply: (pp) => (pp.profile === 'implement' ? { ...pp, related_sprints: [] } : pp),
      },
      {
        section: 'objective_excerpt',
        reason: 'budget',
        apply: (pp) => (pp.profile === 'implement' ? { ...pp, objective_excerpt: undefined } : pp),
      },
      {
        section: 'findings',
        reason: 'budget',
        apply: (pp) => (pp.profile === 'implement' ? { ...pp, findings: [] } : pp),
      },
      {
        section: 'denied_paths',
        reason: 'budget',
        apply: (pp) =>
          pp.profile === 'implement' ? { ...pp, capsule: { ...pp.capsule, denied_paths: [] } } : pp,
      },
    ];
  }
  if (p.profile === 'review') {
    return [
      {
        section: 'review_findings',
        reason: 'budget',
        apply: (pp) => (pp.profile === 'review' ? { ...pp, review_findings: [] } : pp),
      },
    ];
  }
  return [
    {
      section: 'planned',
      reason: 'budget',
      apply: (pp) =>
        pp.profile === 'wave' ? { ...pp, capsule: { ...pp.capsule, planned: [] } } : pp,
    },
    {
      section: 'gated',
      reason: 'budget',
      apply: (pp) =>
        pp.profile === 'wave' ? { ...pp, capsule: { ...pp.capsule, gated: [] } } : pp,
    },
    {
      section: 'findings',
      reason: 'budget',
      apply: (pp) => (pp.profile === 'wave' ? { ...pp, findings: [] } : pp),
    },
    {
      section: 'blocked',
      reason: 'budget',
      apply: (pp) =>
        pp.profile === 'wave' ? { ...pp, capsule: { ...pp.capsule, blocked: [] } } : pp,
    },
  ];
}

function estimateEssentialTokens(p: ContextPacket, format: 'md' | 'json'): number {
  const stripped = stripToEssential(p);
  return estimateTokens(renderPacket(stripped, format));
}

function stripToEssential(p: ContextPacket): ContextPacket {
  if (p.profile === 'implement') {
    return {
      ...p,
      objective_excerpt: undefined,
      findings: [],
      related_sprints: [],
      capsule: { ...p.capsule, denied_paths: [] },
    };
  }
  if (p.profile === 'review') {
    return {
      ...p,
      review_findings: [],
    };
  }
  return {
    ...p,
    findings: [],
    capsule: { ...p.capsule, planned: [], gated: [], blocked: [] },
  };
}

function setEstimatedTokens(p: ContextPacket, tokens: number): ContextPacket {
  return { ...p, estimated_tokens: tokens } as ContextPacket;
}

// — JSON Schema export (hand-rolled, small) —

function renderJsonSchema(profile: ContextProfile): string {
  const common = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://repokernel.dev/schemas/context-packet/${profile}.json`,
    title: `RepoKernel Context Packet — ${profile}`,
  };
  if (profile === 'implement') {
    return canonicalJson({
      ...common,
      type: 'object',
      required: [
        'profile',
        'target',
        'capsule',
        'findings',
        'related_sprints',
        'scoped_manifest',
        'omissions',
        'estimated_tokens',
        'effective_budget',
      ],
      properties: {
        profile: { const: 'implement' },
        target: { type: 'string', pattern: '^S-\\d{3,}$' },
        capsule: { type: 'object' },
        objective_excerpt: { type: 'string' },
        findings: { type: 'array' },
        related_sprints: { type: 'array' },
        scoped_manifest: {
          type: 'object',
          required: ['files', 'omitted_count', 'available'],
        },
        omissions: { type: 'array' },
        estimated_tokens: { type: 'integer', minimum: 0 },
        effective_budget: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    });
  }
  if (profile === 'review') {
    return canonicalJson({
      ...common,
      type: 'object',
      required: [
        'profile',
        'target',
        'capsule',
        'review_findings',
        'omissions',
        'estimated_tokens',
        'effective_budget',
      ],
      properties: {
        profile: { const: 'review' },
        target: { type: 'string', pattern: '^S-\\d{3,}$' },
        capsule: { type: 'object' },
        review_findings: { type: 'array' },
        omissions: { type: 'array' },
        estimated_tokens: { type: 'integer', minimum: 0 },
        effective_budget: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    });
  }
  return canonicalJson({
    ...common,
    type: 'object',
    required: [
      'profile',
      'target',
      'capsule',
      'findings',
      'omissions',
      'estimated_tokens',
      'effective_budget',
    ],
    properties: {
      profile: { const: 'wave' },
      target: { type: 'string', pattern: '^E-\\d{3,}$' },
      capsule: { type: 'object' },
      findings: { type: 'array' },
      omissions: { type: 'array' },
      estimated_tokens: { type: 'integer', minimum: 0 },
      effective_budget: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  });
}

// — text helpers —

function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

// keep CONTEXT_BUDGET_SAFETY_FACTOR import alive when consumers want raw access
export const CONTEXT_BUDGET_SAFETY = CONTEXT_BUDGET_SAFETY_FACTOR;
