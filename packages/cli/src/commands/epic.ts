import { join, resolve } from 'node:path';
import type { Finding, Sprint } from '@repokernel/core';
import {
  loadProject,
  meetsThreshold,
  RepoKernelError,
  reviewIntegrityRule,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { sprintIcon } from '../format/progress.js';
import { runConfiguredChecksFromConfig } from '../lifecycle/checks.js';
import { mutateEpicFrontmatter } from '../lifecycle/mutate.js';
import { withLifecycleTransaction } from '../lifecycle/transaction.js';
import { isoNow } from '../templates/time.js';
import { reconcileTaskAliases } from './fastpath/taskAlias.js';
import { runRegistryCommand } from './registry.js';
import type { CommandResult } from './validate.js';
import { runValidateCommand } from './validate.js';

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

// — epic close —

export interface EpicCloseOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly runChecks?: boolean;
  readonly checksCmd?: string;
}

export async function runEpicCloseCommand(
  id: string,
  opts: EpicCloseOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const epic = outcome.graph.epics.get(id);
    if (!epic) return notFound('epic', id);

    if (epic.status === 'done') {
      return err('ALREADY_CLOSED', `${id} is already closed (status: done)`);
    }
    if (epic.status === 'cancelled') {
      return err(
        'INVALID_STATUS',
        `${id} is cancelled — edit status in epic frontmatter to reopen`,
      );
    }

    const sprintIds = outcome.graph.sprintsByEpic.get(id) ?? [];
    const sprints = sprintIds
      .map((sid) => outcome.graph.sprints.get(sid))
      .filter(Boolean) as Sprint[];

    const incomplete = sprints.filter((s) => s.status !== 'shipped' && s.status !== 'cancelled');
    if (incomplete.length > 0 && !opts.force) {
      const lines = [
        `${id} has ${incomplete.length} incomplete sprint(s):`,
        ...incomplete.map((s) => `  ${s.id}  ${s.status.padEnd(10)}  ${s.title}`),
        '',
        'Ship or cancel all sprints before closing the epic.',
        'Use --force to close anyway.',
      ];
      return err('INCOMPLETE_SPRINTS', lines.join('\n'));
    }

    // Pre-flight review-integrity gate.
    //
    // Catches the failure mode that DomicileVault hit in 2026-04-28:
    // sprints with `review_id` set but no review file (or pointing at
    // another sprint's review). Without this gate `rk epic close`
    // cheerfully marks the epic done while the review audit trail is
    // broken. Findings are scoped to the epic's sprints so unrelated
    // project-wide review issues do not block close.
    const sprintIdSet = new Set(sprints.map((s) => s.id));
    const allFindings = reviewIntegrityRule({
      graph: outcome.graph,
      parsed: outcome.parsed,
      config: outcome.config,
    });
    const reviewBlocking = allFindings.filter(
      (f) =>
        meetsThreshold(f.severity, 'P1') && f.entityId !== undefined && sprintIdSet.has(f.entityId),
    );
    if (reviewBlocking.length > 0 && !opts.force) {
      const lines = [
        `${id} has ${reviewBlocking.length} review-integrity issue(s):`,
        ...reviewBlocking.map((f) => `  ${f.code}  ${f.entityId ?? ''}  ${f.message}`),
        '',
        'Run `rk review-reconcile --apply` to repair, or pass --force to close anyway.',
      ];
      return err('REVIEW_INTEGRITY_BLOCKED', lines.join('\n'));
    }

    const effectiveChecksCmd = opts.checksCmd ?? outcome.config.automation.checksCmd;
    if (opts.runChecks === true) {
      if (!effectiveChecksCmd) {
        return err(
          'NO_CHECKS_CMD',
          'no check command configured',
          'set automation.checksCmd in repokernel.config.yaml or pass --checks-cmd <cmd>',
        );
      }
      if (!opts.dryRun) {
        const { ok, code } = await runConfiguredChecksFromConfig(
          outcome.config,
          cwd,
          effectiveChecksCmd,
        );
        if (!ok) {
          return err(
            'CHECKS_FAILED',
            `checks failed (exit ${code})`,
            'fix check failures before closing the epic',
          );
        }
      }
    }

    if (opts.dryRun) {
      return dryRunOk('epic close', {
        id,
        from: epic.status,
        to: 'done',
        incomplete: incomplete.length,
      });
    }

    const closedAt = isoNow();
    let findings: readonly Finding[] = [];
    let aliasUpdates: Awaited<ReturnType<typeof reconcileTaskAliases>> = [];
    await withLifecycleTransaction(
      { cwd, command: 'epic-close', args: { epicId: id } },
      async (tx) => {
        await mutateEpicFrontmatter(join(cwd, epic.file), { status: 'done', closed_at: closedAt });
        ({ findings } = await tx.refreshRegistry());
        aliasUpdates = await reconcileTaskAliases(cwd, outcome.config, { epicId: id });
      },
    );
    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const shippedCount = sprints.filter((s) => s.status === 'shipped').length;
    const cancelledCount = sprints.filter((s) => s.status === 'cancelled').length;

    const out = [
      `Closed ${id}`,
      '',
      `  ${pc.bold('Epic')}      ${id} — ${epic.title}`,
      `  ${pc.bold('Sprints')}   ${shippedCount} shipped`,
      ...(cancelledCount > 0 ? [`  ${pc.bold('Cancelled')} ${cancelledCount} cancelled`] : []),
      ...(incomplete.length > 0 && opts.force
        ? [
            `  ${pc.yellow('Warning')}   ${incomplete.length} sprint(s) not yet shipped (--force used)`,
          ]
        : []),
      '',
      'Updated:',
      `  ${epic.file}`,
      `  ${outcome.config.paths.registry}`,
      ...aliasUpdates.map((u) => `  ${u.relativePath}  (${u.previousStatus} → ${u.nextStatus})`),
      '',
      pc.dim('Metadata files updated. Commit RepoKernel changes.'),
      '',
      `Next: ${pc.dim(`git add -- ${[epic.file, outcome.config.paths.registry, ...aliasUpdates.map((u) => u.relativePath)].map(shellQuote).join(' ')} && git commit -m ${shellQuote(`chore: close ${id}`)}`)}`,
    ];

    if (blocking.length > 0) {
      out.push(
        '',
        pc.yellow(`Warning: ${blocking.length} finding(s) after mutation — run rk validate`),
      );
    }

    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — epic ship —

export interface EpicShipOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly runChecks?: boolean;
}

export async function runEpicShipCommand(
  id: string,
  opts: EpicShipOptions,
): Promise<CommandResult> {
  const steps: Array<{
    label: string;
    status: 'passed' | 'failed';
    exitCode: number;
    summary: string;
  }> = [];

  if (!opts.dryRun) {
    const validate = await runValidateCommand({ cwd: opts.cwd, json: true, failOn: 'P1' });
    steps.push({
      label: 'validate',
      status: validate.exitCode === 0 ? 'passed' : 'failed',
      exitCode: validate.exitCode,
      summary: validate.exitCode === 0 ? 'validation passed' : 'validation failed',
    });
    if (validate.exitCode !== 0) return formatEpicShip(id, steps, opts.json, validate.exitCode);

    const registry = await runRegistryCommand({
      cwd: opts.cwd,
      write: false,
      check: true,
      explain: true,
      json: true,
    });
    steps.push({
      label: 'registry-check',
      status: registry.exitCode === 0 ? 'passed' : 'failed',
      exitCode: registry.exitCode,
      summary: registry.exitCode === 0 ? 'registry has no drift' : 'registry drift detected',
    });
    if (registry.exitCode !== 0) return formatEpicShip(id, steps, opts.json, registry.exitCode);
  }

  const close = await runEpicCloseCommand(id, {
    cwd: opts.cwd,
    dryRun: opts.dryRun,
    force: false,
    runChecks: opts.runChecks === true,
  });
  steps.push({
    label: 'epic-close',
    status: close.exitCode === 0 ? 'passed' : 'failed',
    exitCode: close.exitCode,
    summary: close.exitCode === 0 ? 'epic closed' : close.stderr.trim(),
  });
  if (opts.dryRun || close.exitCode !== 0)
    return formatEpicShip(id, steps, opts.json, close.exitCode);

  const validate = await runValidateCommand({ cwd: opts.cwd, json: true, failOn: 'P1' });
  steps.push({
    label: 'validate-post-close',
    status: validate.exitCode === 0 ? 'passed' : 'failed',
    exitCode: validate.exitCode,
    summary:
      validate.exitCode === 0 ? 'post-close validation passed' : 'post-close validation failed',
  });
  if (validate.exitCode !== 0) return formatEpicShip(id, steps, opts.json, validate.exitCode);

  const registry = await runRegistryCommand({
    cwd: opts.cwd,
    write: false,
    check: true,
    explain: true,
    json: true,
  });
  steps.push({
    label: 'registry-check-post-close',
    status: registry.exitCode === 0 ? 'passed' : 'failed',
    exitCode: registry.exitCode,
    summary:
      registry.exitCode === 0
        ? 'post-close registry has no drift'
        : 'post-close registry drift detected',
  });
  return formatEpicShip(id, steps, opts.json, registry.exitCode);
}

function formatEpicShip(
  epicId: string,
  steps: ReadonlyArray<{
    readonly label: string;
    readonly status: string;
    readonly exitCode: number;
    readonly summary: string;
  }>,
  json: boolean,
  exitCode: number,
): CommandResult {
  if (json)
    return { exitCode, stdout: `${JSON.stringify({ epicId, steps }, null, 2)}\n`, stderr: '' };
  const lines = [
    `Ship epic ${epicId}`,
    '',
    ...steps.map((s) => `${s.status.padEnd(7)} ${s.label} — ${s.summary}`),
  ];
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

// — epic add-sprint —

export interface EpicAddSprintOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export async function runEpicAddSprintCommand(
  epicId: string,
  sprintId: string,
  opts: EpicAddSprintOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const epic = outcome.graph.epics.get(epicId);
    if (!epic) return notFound('epic', epicId);

    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) return notFound('sprint', sprintId);

    if (sprint.epic_id !== epicId) {
      return err(
        'SPRINT_EPIC_MISMATCH',
        `sprint ${sprintId} belongs to ${sprint.epic_id ?? '(no epic)'}, not ${epicId}`,
        `update the sprint's epic_id field first`,
      );
    }

    const current: string[] = Array.isArray(epic.sprints) ? [...epic.sprints] : [];

    if (current.includes(sprintId)) {
      const result = { epicId, sprintId, added: false, reason: 'already present' };
      if (opts.json) {
        return { exitCode: EXIT_OK, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
      }
      return {
        exitCode: EXIT_OK,
        stdout: `${sprintId} already in ${epicId} sprints[] — no change\n`,
        stderr: '',
      };
    }

    if (opts.dryRun) {
      return dryRunOk(`rk epic add-sprint ${epicId} ${sprintId}`, {
        epicId,
        sprintId,
        currentCount: current.length,
        newCount: current.length + 1,
      });
    }

    const updated = [...current, sprintId];
    await withLifecycleTransaction(
      { cwd, command: 'epic-add-sprint', args: { epicId, sprintId } },
      async (tx) => {
        await mutateEpicFrontmatter(join(cwd, epic.file), { sprints: updated });
        await tx.refreshRegistry();
      },
    );

    const result = { epicId, sprintId, added: true };
    if (opts.json) {
      return { exitCode: EXIT_OK, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
    }
    return {
      exitCode: EXIT_OK,
      stdout: `Added ${sprintId} to ${epicId} sprints[]\n`,
      stderr: '',
    };
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
  return err(`${type.toUpperCase()}_NOT_FOUND`, `${type} ${id} not found`);
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
  const message = e instanceof Error ? e.message : String(e);
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${message}\n` };
}

function err(_code: string, message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${lines.join('\n')}\n` };
}

function dryRunOk(command: string, info: Record<string, unknown>): CommandResult {
  const lines = [`dry-run: ${command}`, ''];
  for (const [k, v] of Object.entries(info)) lines.push(`  ${k}: ${String(v)}`);
  lines.push('', 'No files written.');
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
