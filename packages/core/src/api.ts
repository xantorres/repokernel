import { satisfies, validRange } from 'semver';
import { type LoadConfigResult, loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { buildGraph } from './graph/build.js';
import type { Graph } from './graph/types.js';
import { type ParsedProject, parseProject } from './parser/parseProject.js';
import type { EntityType, Finding } from './schemas/finding.js';
import { compareFindings } from './schemas/finding.js';
import { FINDING_CODES } from './validator/codes.js';
import { runValidators, type ValidatorScope } from './validator/engine.js';
import { runStrictPlanningValidation } from './validator/strictPlanning.js';

export interface LoadProjectResult {
  readonly ok: true;
  readonly cwd: string;
  readonly configPath: string;
  readonly config: Config;
  readonly parsed: ParsedProject;
  readonly graph: Graph;
  readonly warnings: readonly Finding[];
}

export interface LoadProjectFailure {
  readonly ok: false;
  readonly cwd: string;
  readonly configPath: string;
  readonly findings: readonly Finding[];
  readonly errorPhase: 'config' | 'parse' | 'graph';
}

export type LoadProjectOutcome = LoadProjectResult | LoadProjectFailure;

export async function loadProject(opts: { cwd: string }): Promise<LoadProjectOutcome> {
  const cfg: LoadConfigResult = await loadConfig({ cwd: opts.cwd });
  if (!cfg.ok) {
    return {
      ok: false,
      cwd: cfg.cwd,
      configPath: cfg.configPath,
      findings: [cfg.finding],
      errorPhase: 'config',
    };
  }
  const parsed = await parseProject({ cwd: cfg.cwd, config: cfg.config });
  const blockingParseFindings = parsed.findings.filter(
    (f) => f.severity === 'P0' || f.severity === 'P1',
  );
  if (blockingParseFindings.length > 0) {
    return {
      ok: false,
      cwd: cfg.cwd,
      configPath: cfg.configPath,
      findings: [...parsed.findings].sort(compareFindings),
      errorPhase: 'parse',
    };
  }
  const duplicateFindings = detectDuplicateIds(parsed);
  if (duplicateFindings.length > 0) {
    // Surface non-blocking parse findings (P2/P3) alongside the duplicate
    // failures so users see the full diagnostic picture in one pass instead
    // of fixing duplicates and re-running to discover the next batch.
    return {
      ok: false,
      cwd: cfg.cwd,
      configPath: cfg.configPath,
      findings: [...duplicateFindings, ...parsed.findings].sort(compareFindings),
      errorPhase: 'graph',
    };
  }
  const graph = buildGraph(parsed);
  return {
    ok: true,
    cwd: cfg.cwd,
    configPath: cfg.configPath,
    config: cfg.config,
    parsed,
    graph,
    warnings: cfg.warnings,
  };
}

function detectDuplicateIds(parsed: ParsedProject): Finding[] {
  return [
    ...duplicateEntityIds(parsed.sprints, FINDING_CODES.DUPLICATE_SPRINT_ID, 'sprint'),
    ...duplicateEntityIds(parsed.epics, FINDING_CODES.DUPLICATE_EPIC_ID, 'epic'),
    ...duplicateEntityIds(parsed.reviews, FINDING_CODES.DUPLICATE_REVIEW_ID, 'review'),
  ];
}

function duplicateEntityIds(
  items: readonly { readonly id: string; readonly file?: string }[],
  code: (typeof FINDING_CODES)[keyof typeof FINDING_CODES],
  entityType: EntityType,
): Finding[] {
  const byId = new Map<string, string[]>();
  for (const item of items) {
    const files = byId.get(item.id) ?? [];
    files.push(item.file ?? '<unknown>');
    byId.set(item.id, files);
  }
  const out: Finding[] = [];
  for (const [id, files] of byId) {
    if (files.length <= 1) continue;
    out.push({
      severity: 'P0',
      code,
      message: `${entityType} id "${id}" appears ${files.length} times`,
      file: files[0],
      entityType,
      entityId: id,
      data: { files },
    });
  }
  return out;
}

export interface ValidateProjectInput {
  readonly cwd: string;
  readonly runtimeVersion?: string;
  /** Validator scope filter. Default `'live'` (skip historical-hygiene rules). Pass `'all'` to include `audit`. */
  readonly scope?: ValidatorScope | 'all';
  /** Include opt-in planning-contract checks for sprint markdown bodies. */
  readonly strict?: boolean;
}

export interface ValidationReport {
  readonly cwd: string;
  readonly configPath: string;
  readonly findings: readonly Finding[];
  readonly project: LoadProjectResult | null;
  readonly config: Config | null;
}

export async function validateProject(opts: ValidateProjectInput): Promise<ValidationReport> {
  const outcome = await loadProject(opts);
  if (!outcome.ok) {
    return {
      cwd: outcome.cwd,
      configPath: outcome.configPath,
      findings: [...outcome.findings].sort(compareFindings),
      project: null,
      config: null,
    };
  }
  const validatorFindings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  });
  const strictFindings =
    opts.strict === true
      ? await runStrictPlanningValidation({
          cwd: outcome.cwd,
          parsed: outcome.parsed,
          includeTerminal: opts.scope === 'all',
        })
      : [];
  const allFindings: Finding[] = [...outcome.warnings, ...validatorFindings, ...strictFindings];
  if (opts.runtimeVersion && outcome.config.requires) {
    const range = outcome.config.requires;
    if (validRange(range) === null) {
      allFindings.push({
        severity: 'P1',
        code: FINDING_CODES.CONFIG_REQUIRES_NOT_MET,
        message: `requires: "${range}" is not a valid semver range`,
        file: outcome.configPath,
        suggestion: 'use a valid semver range expression, e.g. ">=1.0.0"',
      });
    } else if (!satisfies(opts.runtimeVersion, range)) {
      allFindings.push({
        severity: 'P1',
        code: FINDING_CODES.CONFIG_REQUIRES_NOT_MET,
        message: `rk ${opts.runtimeVersion} does not satisfy required range "${range}"`,
        file: outcome.configPath,
        suggestion: `upgrade rk to satisfy "${range}"`,
      });
    }
  }
  const findings = allFindings.sort(compareFindings);
  return {
    cwd: outcome.cwd,
    configPath: outcome.configPath,
    findings,
    project: outcome,
    config: outcome.config,
  };
}
