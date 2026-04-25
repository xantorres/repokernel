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

export interface ValidationContext extends ValidationInput {
  readonly parseFindings: readonly Finding[];
}

export function runValidators(ctx: ValidationContext): Finding[] {
  const out: Finding[] = [...ctx.parseFindings];
  const input: ValidationInput = {
    graph: ctx.graph,
    config: ctx.config,
    parsed: ctx.parsed,
  };
  for (const rule of rules) {
    out.push(...rule(input));
  }
  out.sort(compareFindings);
  return out;
}
