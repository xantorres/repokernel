import { resolve } from 'node:path';
import {
  IMPORT_PLAN_SCHEMA_VERSION,
  type ImportPlan,
  ImportPlanSchema,
  loadProject,
  type Sprint,
} from '@repokernel/core';
import { stringify as stringifyYaml } from 'yaml';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export interface ExportCommandOptions {
  readonly cwd: string;
}

/**
 * Emit the current project as an import plan (YAML on stdout) with `alias` set to
 * each entity's id, so `rk export | rk import --skip-existing` round-trips to zero
 * new entities. Statuses that the import schema does not accept (queued, active,
 * shipped, …) are omitted; `--skip-existing` re-creates nothing, so the live
 * status is not lost.
 */
export async function runExportCommand(opts: ExportCommandOptions): Promise<CommandResult> {
  const outcome = await loadProject({ cwd: resolve(opts.cwd) });
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
    };
  }
  const { graph } = outcome;

  const epics = [...graph.epics.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((epic) => {
      const sprintIds = graph.sprintsByEpic.get(epic.id) ?? [];
      const sprints = sprintIds
        .map((sid) => graph.sprints.get(sid))
        .filter((s): s is Sprint => s !== undefined)
        .map(exportSprint);
      return {
        alias: epic.id,
        title: epic.title,
        ...(epic.adr_links.length > 0 ? { adr_links: [...epic.adr_links] } : {}),
        ...(hasEntries(epic.extras) ? { extras: epic.extras } : {}),
        sprints,
      };
    });

  const plan: ImportPlan = { schemaVersion: IMPORT_PLAN_SCHEMA_VERSION, epics };
  // Validate our own output so a schema drift surfaces here, not on re-import.
  ImportPlanSchema.parse(plan);
  return { exitCode: EXIT_OK, stdout: stringifyYaml(plan), stderr: '' };
}

function exportSprint(sprint: Sprint): ImportPlan['epics'][number]['sprints'][number] {
  const status: 'planned' | 'pending' | undefined =
    sprint.status === 'planned' || sprint.status === 'pending' ? sprint.status : undefined;
  // The sprint template owns the frontmatter↔body separator and gray-matter
  // parses the body to include that leading blank line. Strip it on export so
  // re-import does not prepend a second separator each round-trip (idempotency).
  const body = sprint.body.replace(/^\n+/, '');
  return {
    alias: sprint.id,
    title: sprint.title,
    ...(sprint.lane !== 'main' ? { lane: sprint.lane } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(sprint.depends_on.length > 0 ? { depends_on: [...sprint.depends_on] } : {}),
    ...(sprint.allowed_paths.length > 0 ? { allowed_paths: [...sprint.allowed_paths] } : {}),
    ...(sprint.denied_paths.length > 0 ? { denied_paths: [...sprint.denied_paths] } : {}),
    ...(sprint.adr_links.length > 0 ? { adr_links: [...sprint.adr_links] } : {}),
    ...(sprint.target_date ? { target_date: sprint.target_date } : {}),
    ...(body.trim().length > 0 ? { body } : {}),
    ...(hasEntries(sprint.extras) ? { extras: sprint.extras } : {}),
  };
}

function hasEntries(extras: Record<string, unknown> | undefined): boolean {
  return extras !== undefined && Object.keys(extras).length > 0;
}
