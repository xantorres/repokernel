import { type LoadConfigResult, loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { buildGraph } from './graph/build.js';
import type { Graph } from './graph/types.js';
import { type ParsedProject, parseProject } from './parser/parseProject.js';
import type { Finding } from './schemas/finding.js';
import { compareFindings } from './schemas/finding.js';
import { runValidators } from './validator/engine.js';

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

export interface ValidateProjectInput {
  readonly cwd: string;
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
  });
  const findings = [...outcome.warnings, ...validatorFindings].sort(compareFindings);
  return {
    cwd: outcome.cwd,
    configPath: outcome.configPath,
    findings,
    project: outcome,
    config: outcome.config,
  };
}
