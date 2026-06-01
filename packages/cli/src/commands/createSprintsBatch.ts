import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadProject, RepoKernelError } from '@repokernel/core';
import { parse as parseYaml } from 'yaml';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { type CreateSprintOptions, runCreateSprintCommand } from './create.js';
import type { CommandResult } from './validate.js';

export interface CreateSprintsBatchOptions {
  readonly cwd: string;
  readonly fromFile: string;
  readonly json?: boolean;
}

interface SprintSpec {
  readonly title: string;
  readonly epic: string;
  readonly lane?: string;
  readonly status?: string;
  readonly after?: readonly string[];
  readonly allowed_paths?: readonly string[];
  readonly denied_paths?: readonly string[];
  readonly adr_links?: readonly string[];
  readonly target_date?: string;
  readonly body?: string;
  readonly body_file?: string;
  readonly enqueue?: boolean;
}

function fail(message: string): CommandResult {
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `create sprints: ${message}\n` };
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as readonly string[];
}

/** Validate one raw YAML entry into a SprintSpec, or return an indexed error. */
function parseSpec(raw: unknown, index: number): { spec?: SprintSpec; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `entry ${index + 1} is not a mapping` };
  }
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (title === '') return { error: `entry ${index + 1} is missing a non-empty "title"` };
  if (typeof r.epic !== 'string' || r.epic.trim() === '') {
    return { error: `entry ${index + 1} ("${title}") is missing "epic"` };
  }
  const epic = r.epic;
  const arrayFields: Array<keyof SprintSpec> = [
    'after',
    'allowed_paths',
    'denied_paths',
    'adr_links',
  ];
  const arrays: Record<string, readonly string[] | undefined> = {};
  for (const field of arrayFields) {
    if (r[field] === undefined) continue;
    const parsed = asStringArray(r[field]);
    if (parsed === null)
      return { error: `entry ${index + 1}: "${field}" must be a list of strings` };
    arrays[field] = parsed;
  }
  if (r.enqueue !== undefined && typeof r.enqueue !== 'boolean') {
    return { error: `entry ${index + 1}: "enqueue" must be a boolean` };
  }
  const optionalString = (key: string): string | undefined =>
    typeof r[key] === 'string' ? (r[key] as string) : undefined;
  const lane = optionalString('lane');
  const status = optionalString('status');
  const targetDate = optionalString('target_date');
  const body = optionalString('body');
  const bodyFile = optionalString('body_file');
  return {
    spec: {
      title,
      epic,
      ...(lane !== undefined ? { lane } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(arrays.after ? { after: arrays.after } : {}),
      ...(arrays.allowed_paths ? { allowed_paths: arrays.allowed_paths } : {}),
      ...(arrays.denied_paths ? { denied_paths: arrays.denied_paths } : {}),
      ...(arrays.adr_links ? { adr_links: arrays.adr_links } : {}),
      ...(targetDate !== undefined ? { target_date: targetDate } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(bodyFile !== undefined ? { body_file: bodyFile } : {}),
      ...(typeof r.enqueue === 'boolean' ? { enqueue: r.enqueue } : {}),
    },
  };
}

export async function runCreateSprintsBatchCommand(
  opts: CreateSprintsBatchOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  let text: string;
  try {
    text = await readFile(resolve(cwd, opts.fromFile), 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return fail(`file not found: ${opts.fromFile}`);
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    return fail(`could not parse YAML: ${(cause as Error).message}`);
  }
  if (!Array.isArray(parsed)) return fail('expected a top-level YAML list of sprint specs');
  if (parsed.length === 0) return fail('no sprint specs found in file');

  const specs: SprintSpec[] = [];
  for (const [index, raw] of parsed.entries()) {
    const { spec, error } = parseSpec(raw, index);
    if (error !== undefined) return fail(error);
    if (spec) specs.push(spec);
  }

  // Pre-flight against the project so a missing epic or queue fails the whole
  // batch before any sprint file is written (no orphans from bad input).
  let outcome: Awaited<ReturnType<typeof loadProject>>;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!outcome.ok) return fail('project config is invalid; run rk validate');

  const defaultLane = outcome.config.policies.defaultLane;
  for (const spec of specs) {
    if (!outcome.graph.epics.has(spec.epic)) {
      return fail(`epic ${spec.epic} not found (referenced by "${spec.title}")`);
    }
    if (spec.enqueue) {
      const lane = spec.lane ?? defaultLane;
      if (!existsSync(join(cwd, outcome.config.paths.queues, `${lane}.md`))) {
        return fail(
          `"${spec.title}" needs --enqueue but lane "${lane}" has no queue; run rk create queue --lane ${lane}`,
        );
      }
    }
  }

  const created: Array<{ id: string; file: string }> = [];
  for (const spec of specs) {
    const sprintOpts: CreateSprintOptions = {
      cwd,
      epic: spec.epic,
      lane: spec.lane ?? defaultLane,
      status: spec.status ?? 'planned',
      json: true,
      ...(spec.after ? { after: spec.after } : {}),
      ...(spec.allowed_paths ? { allowedPaths: spec.allowed_paths } : {}),
      ...(spec.denied_paths ? { deniedPaths: spec.denied_paths } : {}),
      ...(spec.adr_links ? { adrLinks: spec.adr_links } : {}),
      ...(spec.target_date !== undefined ? { targetDate: spec.target_date } : {}),
      ...(spec.body !== undefined ? { body: spec.body } : {}),
      ...(spec.body_file !== undefined ? { bodyFile: spec.body_file } : {}),
      ...(spec.enqueue !== undefined ? { enqueue: spec.enqueue } : {}),
    };
    const result = await runCreateSprintCommand(spec.title, sprintOpts);
    if (result.exitCode !== EXIT_OK) {
      const detail = result.stderr.trim() || result.stdout.trim();
      const madeSoFar = created.map((c) => c.id).join(', ') || 'none';
      return {
        exitCode: result.exitCode,
        stdout: '',
        stderr: `create sprints: failed on "${spec.title}" after creating ${madeSoFar}\n${detail}\n`,
      };
    }
    const env = JSON.parse(result.stdout) as { id: string; file: string };
    created.push({ id: env.id, file: env.file });
  }

  if (opts.json === true) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ created, count: created.length }),
      stderr: '',
    };
  }
  const lines = [`Created ${created.length} sprint${created.length === 1 ? '' : 's'}:`];
  for (const c of created) lines.push(`  ${c.id}  ${c.file}`);
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
