import type { Sprint } from '@repokernel/core';

/**
 * Render a deterministic PR body from a sprint. The output is plain
 * markdown so any provider that accepts markdown bodies (GitHub, GitLab,
 * Bitbucket) renders it identically.
 *
 * The body is intentionally pure — same sprint in, same body out — so
 * the description is regenerable from version control without churn from
 * non-deterministic timestamps or signatures.
 */

export interface PrBodyOptions {
  readonly sprint: Sprint;
  readonly agentSummary?: string;
}

export function renderPrBody(opts: PrBodyOptions): string {
  const { sprint, agentSummary } = opts;
  const lines: string[] = [];

  lines.push('## Description');
  lines.push('');
  lines.push(sprint.title);
  if (sprint.body && sprint.body.trim().length > 0) {
    lines.push('');
    lines.push(sprint.body.trim());
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Sprint:** ${sprint.id}`);
  lines.push(`**Lane:** ${sprint.lane}`);
  if (sprint.allowed_paths.length > 0) {
    lines.push(`**Allowed paths:** ${sprint.allowed_paths.join(', ')}`);
  }
  lines.push(`**Review required:** ${sprint.review_required ? 'yes' : 'no'}`);
  lines.push(`**Status:** ${sprint.status}`);

  if (agentSummary && agentSummary.trim().length > 0) {
    lines.push('');
    lines.push('## Agent Summary');
    lines.push('');
    lines.push(agentSummary.trim());
  }

  lines.push('');
  lines.push('## Checklist');
  lines.push('');
  lines.push('- [ ] Tests passing');
  lines.push('- [ ] No new warnings');
  lines.push('- [ ] Documentation updated');
  lines.push('- [ ] Ready for review');
  lines.push('');

  return lines.join('\n');
}
