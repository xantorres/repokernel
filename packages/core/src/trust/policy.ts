import type { AgentDefinition, Automation, Config } from '../config/schema.js';
import type { EpicFrontmatter } from '../schemas/epic.js';
import { isSensitiveEnvName, type RepoTrustGrant, type ReviewerGrant } from './schema.js';

export type TrustScope = 'checks_cmd' | 'agent' | 'env_passthrough' | 'reviewer';

export interface TrustRequest {
  readonly scope: TrustScope;
  /** For scope='agent': agent name. For scope='reviewer': reviewer id. For scope='env_passthrough': env var name. For scope='checks_cmd': undefined. */
  readonly key?: string;
  /** Human-readable origin (file + line/source) for diagnostics. */
  readonly source: string;
}

export interface TrustViolation extends TrustRequest {
  readonly reason: string;
}

export interface TrustEvaluation {
  readonly requests: readonly TrustRequest[];
  readonly violations: readonly TrustViolation[];
}

/**
 * Walk a Config and enumerate every privileged action the repo wants. Used by
 * `rk trust audit` to emit the trust grants needed to keep current behavior.
 * Reviewer requests come from `summarizeReviewerRequests(epics)` since they
 * live in epic frontmatter, not the top-level config.
 */
export function summarizeRepoRequests(config: Config): readonly TrustRequest[] {
  const requests: TrustRequest[] = [];

  if (config.automation.checksCmd !== undefined) {
    requests.push({
      scope: 'checks_cmd',
      source: `automation.checksCmd = ${JSON.stringify(config.automation.checksCmd)}`,
    });
  }
  if (config.automation.checksPhases !== undefined) {
    for (const [phase, command] of Object.entries(config.automation.checksPhases)) {
      if (typeof command !== 'string') continue;
      requests.push({
        scope: 'checks_cmd',
        source: `automation.checksPhases.${phase} = ${JSON.stringify(command)}`,
      });
    }
  }

  for (const [agentName, def] of Object.entries(config.agents ?? {})) {
    requests.push({ scope: 'agent', key: agentName, source: `agents.${agentName}` });
    for (const envName of def.envPassthrough) {
      requests.push({
        scope: 'env_passthrough',
        key: envName,
        source: `agents.${agentName}.envPassthrough`,
      });
    }
  }

  return dedupeRequests(requests);
}

/**
 * Enumerate reviewer requests declared in epic panel_review rules. Reviewer
 * commands live in user-local trust (not in epic frontmatter), so the
 * audit/check flow needs to walk frontmatter separately and surface ids that
 * still need manual grants.
 */
export function summarizeReviewerRequests(
  epics: readonly EpicFrontmatter[],
): readonly TrustRequest[] {
  const requests: TrustRequest[] = [];
  for (const epic of epics) {
    for (const rule of epic.quality_rules ?? []) {
      if (rule.type !== 'panel_review') continue;
      for (const r of rule.reviewers) {
        requests.push({
          scope: 'reviewer',
          key: r.id,
          source: `${epic.id ?? 'epic'}:quality_rules.panel_review.reviewers.${r.id}`,
        });
      }
    }
  }
  return dedupeRequests(requests);
}

export interface EvaluateRepoOptions {
  readonly epics?: readonly EpicFrontmatter[] | undefined;
}

export function evaluateRepo(
  config: Config,
  grant: RepoTrustGrant,
  opts: EvaluateRepoOptions = {},
): TrustEvaluation {
  const requests = [
    ...summarizeRepoRequests(config),
    ...(opts.epics ? summarizeReviewerRequests(opts.epics) : []),
  ];
  const violations: TrustViolation[] = [];

  for (const req of requests) {
    const violation = violationFor(req, grant);
    if (violation) violations.push(violation);
  }

  return { requests, violations };
}

export type ChecksCmdGrantResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function evaluateChecksCmdGrant(
  automation: Automation,
  grant: RepoTrustGrant,
): ChecksCmdGrantResult {
  const hasChecks = automation.checksCmd !== undefined || automation.checksPhases !== undefined;
  if (!hasChecks) return { allowed: true };
  if (grant.checks_cmd) return { allowed: true };
  const source =
    automation.checksCmd !== undefined ? 'automation.checksCmd' : 'automation.checksPhases';
  return {
    allowed: false,
    reason: `repo declares ${source} but user has not granted 'checks_cmd' for this repo`,
  };
}

export interface DroppedEnv {
  readonly name: string;
  readonly reason: string;
}

export type AgentGrantEvaluation =
  | {
      readonly allowed: true;
      readonly allowedEnv: readonly string[];
      readonly droppedEnv: readonly DroppedEnv[];
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly allowedEnv: readonly [];
      readonly droppedEnv: readonly DroppedEnv[];
    };

export function evaluateAgentGrant(
  agentName: string,
  agent: AgentDefinition,
  grant: RepoTrustGrant,
): AgentGrantEvaluation {
  if (!grant.agents.includes(agentName)) {
    return {
      allowed: false,
      reason: `agent '${agentName}' is not granted in user-local trust for this repo`,
      allowedEnv: [],
      droppedEnv: agent.envPassthrough.map((name) => ({ name, reason: 'agent not granted' })),
    };
  }

  const allowedEnv: string[] = [];
  const droppedEnv: DroppedEnv[] = [];
  for (const name of agent.envPassthrough) {
    if (name.includes('*')) {
      droppedEnv.push({ name, reason: 'wildcards not allowed in agent envPassthrough' });
      continue;
    }
    if (!grant.env_passthrough.includes(name)) {
      droppedEnv.push({
        name,
        reason: isSensitiveEnvName(name)
          ? `sensitive env name not in user-local trust env_passthrough`
          : `env name not in user-local trust env_passthrough`,
      });
      continue;
    }
    allowedEnv.push(name);
  }

  return { allowed: true, allowedEnv, droppedEnv };
}

export type ReviewerGrantResult =
  | { readonly allowed: true; readonly reviewer: ReviewerGrant }
  | { readonly allowed: false; readonly reason: string };

export function evaluateReviewerGrant(
  reviewerId: string,
  grant: RepoTrustGrant,
): ReviewerGrantResult {
  const reviewer = grant.reviewers[reviewerId];
  if (!reviewer) {
    return {
      allowed: false,
      reason: `reviewer id '${reviewerId}' has no user-local trust grant; add it to ~/.repokernel/trust.yaml under repos.<repo>.reviewers.${reviewerId}`,
    };
  }
  return { allowed: true, reviewer };
}

function violationFor(req: TrustRequest, grant: RepoTrustGrant): TrustViolation | null {
  switch (req.scope) {
    case 'checks_cmd':
      return grant.checks_cmd
        ? null
        : { ...req, reason: `grant 'checks_cmd: true' for this repo to allow` };
    case 'agent':
      return grant.agents.includes(req.key ?? '')
        ? null
        : { ...req, reason: `add '${req.key}' to repos.<repo>.agents to allow` };
    case 'env_passthrough':
      return grant.env_passthrough.includes(req.key ?? '')
        ? null
        : {
            ...req,
            reason: isSensitiveEnvName(req.key ?? '')
              ? `sensitive env name '${req.key}' requires explicit listing in repos.<repo>.env_passthrough`
              : `add '${req.key}' to repos.<repo>.env_passthrough to allow`,
          };
    case 'reviewer':
      return Object.hasOwn(grant.reviewers, req.key ?? '')
        ? null
        : { ...req, reason: `add 'reviewers.${req.key}' (with command + args) to allow` };
  }
}

function dedupeRequests(requests: readonly TrustRequest[]): readonly TrustRequest[] {
  const seen = new Set<string>();
  const out: TrustRequest[] = [];
  for (const r of requests) {
    const key = r.scope === 'checks_cmd' ? `${r.scope}::${r.source}` : `${r.scope}::${r.key ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
