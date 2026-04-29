import type { Config } from '../config/schema.js';
import type { Graph } from '../graph/types.js';
import type { ParsedProject } from '../parser/parseProject.js';
import { compareFindings, type Finding } from '../schemas/finding.js';
import { rules } from './rules/index.js';

export interface ValidationInput {
  readonly graph: Graph;
  readonly config: Config;
  readonly parsed: ParsedProject;
}

export type ValidatorRule = (input: ValidationInput) => Finding[];

/**
 * Validator scope.
 *
 * `live`  — invariants about current state. Fixable now (queue presence, missing
 *           epic refs, dependency cycles, broken links). Default for `rk validate`,
 *           `rk report`, `rk status`, lifecycle gates.
 * `audit` — historical hygiene on frozen state (e.g. shipped sprints missing
 *           fields that were not captured at close time). Re-firing on every run
 *           produces noise without an actionable target. Opt-in via `--audit`.
 */
export type ValidatorScope = 'live' | 'audit';

export interface ScopedRule {
  readonly scope: ValidatorScope;
  readonly run: ValidatorRule;
}

export interface ValidationContext extends ValidationInput {
  readonly parseFindings: readonly Finding[];
  /** Filter rules by scope. `'all'` runs both `live` and `audit`. Default `'live'`. */
  readonly scope?: ValidatorScope | 'all';
}

export function runValidators(ctx: ValidationContext): Finding[] {
  const scope = ctx.scope ?? 'live';
  const out: Finding[] = [...ctx.parseFindings];
  const input: ValidationInput = {
    graph: ctx.graph,
    config: ctx.config,
    parsed: ctx.parsed,
  };
  for (const rule of rules) {
    if (scope !== 'all' && rule.scope !== scope) continue;
    out.push(...rule.run(input));
  }
  out.sort(compareFindings);
  return out;
}
