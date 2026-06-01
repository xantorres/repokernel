import {
  type LoadProjectOutcome,
  loadProject,
  RepoKernelError,
  type Sprint,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { gitDiffNameOnlyZ } from '../lifecycle/gitPorcelain.js';
import type { CommandResult } from './validate.js';

export interface AuditTrailCommandOptions {
  readonly cwd: string;
  readonly epicId: string;
  readonly json?: boolean;
}

interface AuditRow {
  readonly sprint_id: string;
  readonly status: string;
  readonly base_sha: string | null;
  readonly end_sha: string | null;
  readonly reviewer: string | null;
  readonly verdict: string | null;
  readonly changed_files: number | null;
}

/**
 * Per-epic provenance for handoffs: every sprint with its base_sha/end_sha,
 * reviewer, verdict, and changed-file count in one view. The file count is
 * best-effort — null when there is no base_sha or git can't resolve the range
 * (mirrors `rk doctor`'s tolerance for unreachable SHAs).
 */
export async function runAuditTrailCommand(opts: AuditTrailCommandOptions): Promise<CommandResult> {
  const json = opts.json === true;
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd: opts.cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!outcome.ok) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: 'project config is invalid; run rk validate\n',
    };
  }

  const epic = outcome.graph.epics.get(opts.epicId);
  if (!epic) {
    const known = [...outcome.graph.epics.keys()].sort().join(', ') || 'none';
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: `epic not found: ${opts.epicId}\nKnown epics: ${known}\n`,
    };
  }

  const rows: AuditRow[] = [];
  for (const id of epic.sprints) {
    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      rows.push({
        sprint_id: id,
        status: 'missing',
        base_sha: null,
        end_sha: null,
        reviewer: null,
        verdict: null,
        changed_files: null,
      });
      continue;
    }
    const review = sprint.review_id ? outcome.graph.reviews.get(sprint.review_id) : undefined;
    rows.push({
      sprint_id: sprint.id,
      status: sprint.status,
      base_sha: sprint.base_sha ?? null,
      end_sha: sprint.end_sha ?? null,
      reviewer: review?.reviewer ?? null,
      verdict: review?.verdict ?? null,
      changed_files: await changedCount(opts.cwd, sprint),
    });
  }

  if (json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${emitJson({ epic_id: epic.id, title: epic.title, status: epic.status, sprints: rows })}\n`,
      stderr: '',
    };
  }

  const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : '-');
  const lines = [`Audit trail: ${epic.id} — ${epic.title}  (${epic.status})`, ''];
  if (rows.length === 0) {
    lines.push('  no sprints');
  } else {
    for (const r of rows) {
      lines.push(
        `${r.sprint_id}  ${r.status}  reviewer=${r.reviewer ?? '-'}  verdict=${r.verdict ?? '-'}  files=${r.changed_files ?? '-'}  ${short(r.base_sha)}..${short(r.end_sha)}`,
      );
    }
  }
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/**
 * Count files in the sprint's commit range: base..end_sha for shipped sprints
 * (a stable historical count) or base..HEAD for in-flight ones. Returns null
 * when there is no base_sha or git can't resolve the range.
 */
async function changedCount(cwd: string, sprint: Sprint): Promise<number | null> {
  if (!sprint.base_sha) return null;
  const end = sprint.status === 'shipped' && sprint.end_sha ? sprint.end_sha : 'HEAD';
  try {
    const files = await gitDiffNameOnlyZ(cwd, `${sprint.base_sha}..${end}`);
    return files.length;
  } catch {
    return null;
  }
}
