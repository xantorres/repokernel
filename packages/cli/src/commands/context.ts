import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildExecutionWaves,
  buildSatisfiedSprints,
  buildWavePreview,
  CONTEXT_BUDGET_SAFETY_FACTOR,
  CONTEXT_PROFILE_BUDGETS,
  CONTEXT_PROFILE_TARGET_RULES,
  type ContextDepStatus,
  type ContextImplementPacket,
  type ContextOmission,
  type ContextPacket,
  ContextPacketSchema,
  type ContextProfile,
  type ContextRelatedSprint,
  type ContextReviewChangedFilesSource,
  type ContextReviewPacket,
  type ContextScopedManifest,
  type ContextWavePacket,
  type ContextWaveSprint,
  canonicalJson,
  effectiveBudget as computeEffectiveBudget,
  contextPacketJsonSchema,
  EPIC_ID_RE,
  estimateTokens,
  type Finding,
  type LoadProjectOutcome,
  type LoadProjectResult,
  loadProject,
  RepoKernelError,
  type Review,
  SPRINT_ID_RE,
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
import { detectPathConflicts } from '../lifecycle/pathConflict.js';
import { findSprintWorktreePath } from '../lifecycle/worktree.js';

const execFileAsync = promisify(execFile);

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

  packet = validateContextPacket(packet);

  // Estimate full render first. The estimate is part of the packet, so render
  // until the printed estimate and the actual estimate agree.
  const full = renderWithStableEstimate(packet, opts.format);
  packet = full.packet;
  let rendered = full.rendered;
  const fullTokens = full.tokens;

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
  if (fullTokens > effective) {
    const reduced = reduceForBudget(packet, effective, opts.format);
    if (reduced.essentialOverflow) {
      const stderr = `reduced context (${reduced.tokens} tokens; essential ${reduced.essentialTokens}) exceeds effective budget (${effective}); raise --budget\n`;
      return fail({
        code: EXIT_BUDGET_TOO_SMALL,
        name: 'context_budget_too_small',
        message: stderr.trimEnd(),
      });
    }
    packet = reduced.packet;
    rendered = reduced.rendered;
    omissionsApplied = reduced.omissions;
  }

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
  const review = findSprintReview(input.project.parsed.reviews, sprint);

  const targetFindings = selectSprintContextFindings(input.findings, sprint, review);

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
  return detectPathConflicts([
    { id: 'S-000', allowed_paths: [...a] } as Sprint,
    { id: 'S-999', allowed_paths: [...b] } as Sprint,
  ]).hasConflicts;
}

async function buildScopedManifest(
  cwd: string,
  allowedPaths: readonly string[],
): Promise<ContextScopedManifest> {
  if (allowedPaths.length === 0) {
    return { files: [], omitted_count: 0, available: false };
  }
  const collected = new Set<string>();
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      cwd,
      'ls-files',
      '-z',
      '--',
      ...allowedPaths,
    ]);
    for (const path of parseNulPaths(stdout)) {
      collected.add(path);
    }
  } catch {
    // ls-files may fail in non-git or empty fixtures — skip gracefully.
  }
  const all = [...collected].sort();
  const files = all.slice(0, MANIFEST_CAP);
  const omitted_count = all.length - files.length;
  return { files, omitted_count, available: true };
}

function buildImplementCommands(sprint: Sprint): string[] {
  return [
    `rk inspect ${sprint.id}`,
    `rk start ${sprint.id}`,
    `rk validate --fail-on P0,P1`,
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
  const review = findSprintReview(input.project.parsed.reviews, sprint);

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
  const validatorFindings = selectSprintContextFindings(input.findings, sprint, review);
  const allReviewFindings = mergeFindings(reviewFindings, validatorFindings);

  const acceptance = singleLine(extractAcceptance(sprint.body) || sprint.title);

  const breaching = allReviewFindings.some((f) => f.severity === 'P0' || f.severity === 'P1');

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
      verification_commands: review
        ? [
            `rk inspect ${sprint.id}`,
            `rk validate --fail-on P0,P1`,
            `rk review-verdict ${review.id} accepted`,
            `rk review-verdict ${review.id} changes_requested`,
          ]
        : [`rk inspect ${sprint.id}`, `rk validate --fail-on P0,P1`, `rk review ${sprint.id}`],
    },
    review_findings: allReviewFindings,
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
  if (input.review?.changed_files !== undefined) {
    return { files: [...input.review.changed_files], source: 'review_committed' };
  }
  if (input.baseSha && input.endSha) {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        input.cwd,
        'diff',
        '--name-only',
        '-z',
        `${input.baseSha}..${input.endSha}`,
        '--',
      ]);
      return { files: parseNulPaths(stdout), source: 'git_diff' };
    } catch {
      // fall through to next source
    }
  }
  const worktreePath = await findSprintWorktreePath(input.sprintId, input.cwd);
  if (worktreePath && input.baseSha) {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        worktreePath,
        'diff',
        '--name-only',
        '-z',
        input.baseSha,
        '--',
      ]);
      return { files: parseNulPaths(stdout), source: 'worktree_head' };
    } catch {
      // fall through
    }
  }
  return { files: [], source: 'unavailable' };
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
  const shipped = buildSatisfiedSprints(input.project.graph.sprints.values());
  const executionLimit = Math.max(
    1,
    Math.min(
      epic.parallel_limit ?? input.project.config.parallel.maxConcurrentSprints,
      input.project.config.parallel.maxConcurrentSprints,
    ),
  );
  const executionWaves = buildExecutionWaves(input.project.graph, epic.id, shipped, executionLimit);
  const preview = buildWavePreview(input.project.graph, epic.id, shipped);
  const firstPreview = preview[0];

  const runnable = (executionWaves[0]?.sprints ?? []).map(toWaveSprint).sort(compareWaveSprints);
  const blocked = (firstPreview?.blocked ?? [])
    .map((b) => ({ ...toWaveSprint(b.sprint), reason: b.reason }))
    .sort(compareWaveSprints);
  const gated = (firstPreview?.gated ?? [])
    .map((s) => ({ ...toWaveSprint(s), reason: `gate ${s.gate ?? 'set'}` }))
    .sort(compareWaveSprints);
  const planned = uniqueSprints(preview.flatMap((w) => w.planned))
    .map(toWaveSprint)
    .sort(compareWaveSprints);

  const parallelSafeAll = parallelSafeCandidates(runnable, sprints);
  const parallel_safe = parallelSafeAll.slice(0, PARALLEL_SAFE_CAP);
  const parallel_safe_omitted = parallelSafeAll.length - parallel_safe.length;

  const findings = selectWaveContextFindings(
    input.findings,
    sprints,
    input.project.parsed.reviews,
    epic.id,
  );
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

function parallelSafeCandidates(
  runnable: ContextWaveSprint[],
  sprintsInEpic: readonly Sprint[],
): ContextWaveSprint[] {
  const result: ContextWaveSprint[] = [];
  const selected: Sprint[] = [];
  for (const candidate of runnable) {
    const sprint = sprintsInEpic.find((s) => s.id === candidate.id);
    if (!sprint) continue;
    if (sprint.allowed_paths.length === 0) continue;
    if (detectPathConflicts([...selected, sprint]).hasConflicts) continue;
    result.push(candidate);
    selected.push(sprint);
  }
  return result;
}

// — shared context utilities —

function findSprintReview(reviews: readonly Review[], sprint: Sprint): Review | null {
  return (
    (sprint.review_id ? reviews.find((r) => r.id === sprint.review_id) : undefined) ??
    reviews.find((r) => r.sprint_id === sprint.id) ??
    null
  );
}

function toWaveSprint(s: Sprint): ContextWaveSprint {
  return { id: s.id, title: s.title, lane: s.lane, status: s.status };
}

function compareWaveSprints(a: ContextWaveSprint, b: ContextWaveSprint): number {
  return a.id.localeCompare(b.id);
}

function uniqueSprints(sprints: readonly Sprint[]): Sprint[] {
  const seen = new Set<string>();
  const out: Sprint[] = [];
  for (const sprint of sprints) {
    if (seen.has(sprint.id)) continue;
    seen.add(sprint.id);
    out.push(sprint);
  }
  return out;
}

function parseNulPaths(stdout: string): string[] {
  return stdout
    .split('\0')
    .filter((path) => path.length > 0)
    .map((path) => path.split('\\').join('/'));
}

function mergeFindings(first: readonly Finding[], second: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of [...first, ...second]) {
    const key = canonicalJson({
      code: finding.code,
      entityId: finding.entityId ?? null,
      entityType: finding.entityType ?? null,
      file: finding.file ?? null,
      message: finding.message,
      severity: finding.severity,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function selectSprintContextFindings(
  findings: readonly Finding[],
  sprint: Sprint,
  review: Review | null,
): Finding[] {
  return findings.filter(
    (f) =>
      isBreachingFinding(f) &&
      (isGlobalContextFinding(f) ||
        f.entityId === sprint.id ||
        (f.entityType === 'epic' && f.entityId === sprint.epic_id) ||
        (f.entityType === 'review' &&
          (f.entityId === review?.id || findingDataString(f, 'sprint_id') === sprint.id)) ||
        (f.entityType === 'lane' && f.entityId === sprint.lane) ||
        (f.entityType === 'queue' &&
          (f.entityId === sprint.id || findingDataString(f, 'sprint_id') === sprint.id))),
  );
}

function selectWaveContextFindings(
  findings: readonly Finding[],
  sprints: readonly Sprint[],
  reviews: readonly Review[],
  epicId: string,
): Finding[] {
  const sprintIds = new Set(sprints.map((s) => s.id));
  const lanes = new Set(sprints.map((s) => s.lane));
  const reviewIds = new Set(reviews.filter((r) => sprintIds.has(r.sprint_id)).map((r) => r.id));
  return findings.filter((f) => {
    if (!isBreachingFinding(f)) return false;
    if (isGlobalContextFinding(f)) return true;
    if (f.entityType === 'epic' && f.entityId === epicId) return true;
    if (f.entityId && sprintIds.has(f.entityId)) return true;
    if (f.entityType === 'lane' && f.entityId && lanes.has(f.entityId)) return true;
    if (f.entityType === 'review') {
      const sprintId = findingDataString(f, 'sprint_id');
      return (f.entityId !== undefined && reviewIds.has(f.entityId)) || sprintIds.has(sprintId);
    }
    if (f.entityType === 'queue') {
      const sprintId = findingDataString(f, 'sprint_id');
      return (f.entityId !== undefined && sprintIds.has(f.entityId)) || sprintIds.has(sprintId);
    }
    return false;
  });
}

function isBreachingFinding(f: Finding): boolean {
  return f.severity === 'P0' || f.severity === 'P1';
}

function isGlobalContextFinding(f: Finding): boolean {
  return f.entityType === undefined || f.entityType === 'config';
}

function findingDataString(f: Finding, key: string): string {
  const value = f.data?.[key];
  return typeof value === 'string' ? value : '';
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
  let stable = renderWithStableEstimate(working, format);
  let rendered = stable.rendered;
  let tokens = stable.tokens;
  working = stable.packet;

  const omitSteps = buildOmitSteps(working);
  for (const step of omitSteps) {
    if (tokens <= effective) break;
    working = step.apply(working);
    omissions.push({ section: step.section, reason: step.reason });
    stable = renderWithStableEstimate(withOmissions(working, omissions), format);
    working = stable.packet;
    rendered = stable.rendered;
    tokens = stable.tokens;
  }
  stable = renderWithStableEstimate(withOmissions(working, omissions), format);
  working = stable.packet;
  rendered = stable.rendered;
  tokens = stable.tokens;

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
  const essentialTokens = renderWithStableEstimate(essentialOnly, format).tokens;
  return {
    packet: working,
    rendered,
    tokens,
    omissions,
    essentialOverflow: true,
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
  return renderWithStableEstimate(stripped, format).tokens;
}

function stripToEssential(p: ContextPacket): ContextPacket {
  if (p.profile === 'implement') {
    return {
      ...p,
      objective_excerpt: undefined,
      findings: [],
      related_sprints: [],
      omissions: [],
    };
  }
  if (p.profile === 'review') {
    return {
      ...p,
      review_findings: [],
      omissions: [],
    };
  }
  return {
    ...p,
    findings: [],
    omissions: [],
    capsule: { ...p.capsule, planned: [], gated: [], blocked: [] },
  };
}

function withOmissions(p: ContextPacket, omissions: readonly ContextOmission[]): ContextPacket {
  return validateContextPacket({ ...p, omissions: [...omissions] });
}

interface StableRender {
  readonly packet: ContextPacket;
  readonly rendered: string;
  readonly tokens: number;
}

function renderWithStableEstimate(packet: ContextPacket, format: 'md' | 'json'): StableRender {
  let working = validateContextPacket(packet);
  for (let i = 0; i < 10; i += 1) {
    const rendered = renderPacket(working, format);
    const tokens = estimateTokens(rendered);
    if (tokens === working.estimated_tokens) return { packet: working, rendered, tokens };
    working = validateContextPacket(setEstimatedTokens(working, tokens));
  }
  const rendered = renderPacket(working, format);
  return { packet: working, rendered, tokens: estimateTokens(rendered) };
}

function setEstimatedTokens<T extends ContextPacket>(p: T, tokens: number): T {
  return { ...p, estimated_tokens: tokens } as T;
}

function validateContextPacket(packet: ContextPacket): ContextPacket {
  return ContextPacketSchema.parse(packet);
}

// — JSON Schema export —

function renderJsonSchema(profile: ContextProfile): string {
  return canonicalJson(contextPacketJsonSchema(profile));
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
