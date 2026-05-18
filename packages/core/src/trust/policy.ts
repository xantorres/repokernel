import type { AgentDefinition, Automation, Config } from '../config/schema.js';
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
 */
export function summarizeRepoRequests(config: Config): readonly TrustRequest[] {
  const requests: TrustRequest[] = [];

  if (config.automation.checksCmd !== undefined) {
    requests.push({
      scope: 'checks_cmd',
      source: `automation.checksCmd = ${JSON.stringify(config.automation.checksCmd)}`,
    });
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

export function evaluateRepo(config: Config, grant: RepoTrustGrant): TrustEvaluation {
  const requests = summarizeRepoRequests(config);
  const violations: TrustViolation[] = [];

  for (const req of requests) {
    const violation = violationFor(req, grant);
    if (violation) violations.push(violation);
  }

  return { requests, violations };
}

export function evaluateChecksCmdGrant(
  automation: Automation,
  grant: RepoTrustGrant,
): { allowed: boolean; reason?: string } {
  if (automation.checksCmd === undefined) return { allowed: true };
  if (grant.checks_cmd) return { allowed: true };
  return {
    allowed: false,
    reason: `repo declares automation.checksCmd but user has not granted 'checks_cmd' for this repo`,
  };
}

export interface AgentGrantEvaluation {
  readonly allowed: boolean;
  readonly reason?: string;
  /** Env var names that survive filtering (intersection of agent.envPassthrough and grant.env_passthrough). */
  readonly allowedEnv: readonly string[];
  /** Env var names the agent requested that were dropped, with reason. */
  readonly droppedEnv: ReadonlyArray<{ name: string; reason: string }>;
}

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
  const droppedEnv: Array<{ name: string; reason: string }> = [];
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

export function evaluateReviewerGrant(
  reviewerId: string,
  grant: RepoTrustGrant,
): { allowed: true; reviewer: ReviewerGrant } | { allowed: false; reason: string } {
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
      return grant.reviewers[req.key ?? '']
        ? null
        : { ...req, reason: `add 'reviewers.${req.key}' (with command + args) to allow` };
  }
}

function dedupeRequests(requests: readonly TrustRequest[]): readonly TrustRequest[] {
  const seen = new Set<string>();
  const out: TrustRequest[] = [];
  for (const r of requests) {
    const key = `${r.scope}::${r.key ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
