import { resolve } from 'node:path';
import type { Sprint } from '@repokernel/core';
import { loadProject, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { sprintIcon } from '../format/progress.js';
import type { CommandResult } from './validate.js';

export interface EpicStatusOptions {
  readonly cwd: string;
  readonly json: boolean;
}

export interface EpicMapOptions {
  readonly cwd: string;
  readonly json: boolean;
}

// — epic status —

export async function runEpicStatusCommand(
  id: string,
  opts: EpicStatusOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const epic = outcome.graph.epics.get(id);
    if (!epic) return notFound('epic', id);

    const sprintIds = outcome.graph.sprintsByEpic.get(id) ?? [];
    const sprints = sprintIds
      .map((sid) => outcome.graph.sprints.get(sid))
      .filter(Boolean) as Sprint[];

    const counts = countByStatus(sprints);
    const total = sprints.length;

    const active = sprints.filter((s) => s.status === 'active');
    const queued = sprints.filter((s) => s.status === 'queued');

    const current = active[0] ?? null;
    const nextUp =
      queued.find((s) => {
        const deps = s.depends_on;
        return deps.every((d) => outcome.graph.sprints.get(d)?.status === 'shipped');
      }) ?? null;

    const blocked = sprints.filter((s) => {
      if (['shipped', 'cancelled', 'active'].includes(s.status)) return false;
      return s.depends_on.some((d) => outcome.graph.sprints.get(d)?.status !== 'shipped');
    });

    // pending reviews
    const pendingReviews = sprints
      .filter((s) => s.review_id)
      .map((s) => outcome.graph.reviews.get(s.review_id!))
      .filter((r) => r && r.verdict !== 'accepted');

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            id,
            title: epic.title,
            status: epic.status,
            gate: epic.gate ?? null,
            progress: { ...counts, total },
            current: current ? serializeSprint(current) : null,
            next: nextUp ? serializeSprint(nextUp) : null,
            blocked: blocked.map(serializeSprint),
            pendingReviews: pendingReviews.map((r) => r!.id),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    const progressParts = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${status}`);

    const out = [
      `${id}: ${epic.title}`,
      '',
      `  ${pc.bold('Status')}    ${epic.status}`,
      `  ${pc.bold('Progress')}  ${progressParts.join(' / ')}  (${total} total)`,
    ];

    if (current) {
      out.push(`  ${pc.bold('Current')}   ${current.id} — ${current.title}`);
    }
    if (nextUp) {
      const blockedBy = nextUp.depends_on.filter(
        (d) => outcome.graph.sprints.get(d)?.status !== 'shipped',
      );
      const note = blockedBy.length > 0 ? `  (blocked by ${blockedBy.join(', ')})` : '';
      out.push(`  ${pc.bold('Next')}      ${nextUp.id} — ${nextUp.title}${note}`);
    }

    if (blocked.length > 0) {
      out.push('', '  Blocked:');
      for (const s of blocked) {
        const blockers = s.depends_on.filter(
          (d) => outcome.graph.sprints.get(d)?.status !== 'shipped',
        );
        out.push(`    ${s.id}  depends on ${blockers.join(', ')} (queued, not shipped)`);
      }
    }

    if (pendingReviews.length > 0) {
      const accepted = sprints.filter((s) => {
        const r = s.review_id ? outcome.graph.reviews.get(s.review_id) : null;
        return r?.verdict === 'accepted';
      }).length;
      out.push('', `  Reviews:`);
      out.push(
        `    ${accepted} accepted  |  ${pendingReviews.length} pending (${pendingReviews.map((r) => r!.id).join(', ')})`,
      );
    }

    if (epic.gate) {
      out.push('', `  ${pc.bold('Gate')}:  ${epic.gate}`);
    } else {
      out.push('', `  ${pc.bold('Gate')}:  none`);
    }

    return { exitCode: EXIT_OK, stdout: `${out.join('\n')}\n`, stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — epic map —

export async function runEpicMapCommand(id: string, opts: EpicMapOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const epic = outcome.graph.epics.get(id);
    if (!epic) return notFound('epic', id);

    const sprintIds = outcome.graph.sprintsByEpic.get(id) ?? [];
    const sprints = sprintIds
      .map((sid) => outcome.graph.sprints.get(sid))
      .filter(Boolean) as Sprint[];

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            id,
            title: epic.title,
            status: epic.status,
            sprints: sprints.map(serializeSprint),
            summary: countByStatus(sprints),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    const line = '─'.repeat(44);
    const out = [`${id}: ${epic.title}`, line];

    const active = sprints.filter((s) => s.status === 'active')[0];

    for (const s of sprints) {
      const icon = sprintIcon(s.status);
      const marker = s.id === active?.id ? '  ← current' : '';
      const blockers = s.depends_on.filter(
        (d) => outcome.graph.sprints.get(d)?.status !== 'shipped',
      );
      const note =
        s.status === 'planned' || s.status === 'pending'
          ? '  not eligible: must be queued'
          : blockers.length > 0
            ? `  blocked by ${blockers.join(', ')}`
            : '';

      const col1 = `${s.id}  ${icon} ${s.status.padEnd(10)} ${s.title}`;
      out.push(`${col1}${note}${marker}`);
    }

    out.push(line);

    const counts = countByStatus(sprints);
    const summary = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${status}`)
      .join('  ');
    out.push(summary);

    return { exitCode: EXIT_OK, stdout: `${out.join('\n')}\n`, stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — helpers —

function countByStatus(sprints: Sprint[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sprints) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  return counts;
}

function serializeSprint(s: Sprint) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    lane: s.lane,
    epic_id: s.epic_id,
    depends_on: s.depends_on,
    review_id: s.review_id ?? null,
  };
}

function notFound(type: string, id: string): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: `error: ${type} ${id} not found\n`,
  };
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}

function runtimeErr(e: unknown): CommandResult {
  if (e instanceof RepoKernelError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
  }
  throw e;
}
