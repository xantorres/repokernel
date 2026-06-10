import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  EpicIdSchema,
  LaneNameSchema,
  loadProject,
  RepoKernelError,
  SprintIdSchema,
  toErrorMessage,
} from '@repokernel/core';
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
  for (const field of ['lane', 'status', 'target_date', 'body', 'body_file']) {
    if (r[field] !== undefined && typeof r[field] !== 'string') {
      return { error: `entry ${index + 1}: "${field}" must be a string` };
    }
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
    parsed = parseYaml(text, { strict: true, maxAliasCount: 100 });
  } catch (cause) {
    return fail(`could not parse YAML: ${toErrorMessage(cause)}`);
  }
  if (!Array.isArray(parsed)) return fail('expected a top-level YAML list of sprint specs');
  if (parsed.length === 0) return fail('no sprint specs found in file');

  const specs: SprintSpec[] = [];
  for (const [index, raw] of parsed.entries()) {
    const { spec, error } = parseSpec(raw, index);
    if (error !== undefined) return fail(error);
    if (spec) specs.push(spec);
  }

  // Pre-flight EVERY spec against the project before any write, mirroring the
  // single-sprint create validations, so a malformed spec anywhere in the file
  // fails the whole batch with nothing written (true all-or-nothing on input).
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
    const where = `"${spec.title}"`;
    if (spec.status !== undefined && spec.status !== 'planned' && spec.status !== 'pending') {
      return fail(`${where}: status must be planned or pending (got: ${spec.status})`);
    }
    if (!EpicIdSchema.safeParse(spec.epic).success) {
      return fail(`${where}: invalid epic "${spec.epic}" (expected E-NNN)`);
    }
    if (!outcome.graph.epics.has(spec.epic)) {
      return fail(`epic ${spec.epic} not found (referenced by ${where})`);
    }
    const lane = spec.lane ?? defaultLane;
    if (!LaneNameSchema.safeParse(lane).success) {
      return fail(`${where}: invalid lane "${lane}"`);
    }
    if (spec.enqueue && !existsSync(join(cwd, outcome.config.paths.queues, `${lane}.md`))) {
      return fail(
        `${where} needs --enqueue but lane "${lane}" has no queue; run rk create queue --lane ${lane}`,
      );
    }
    const seenDeps = new Set<string>();
    for (const dep of spec.after ?? []) {
      if (!SprintIdSchema.safeParse(dep).success) {
        return fail(`${where}: invalid after value "${dep}" (expected S-NNN)`);
      }
      if (seenDeps.has(dep)) return fail(`${where}: duplicate after value ${dep}`);
      seenDeps.add(dep);
      if (!outcome.graph.sprints.has(dep)) {
        return fail(`${where}: after references missing sprint ${dep}`);
      }
    }
    if (spec.target_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(spec.target_date)) {
      return fail(`${where}: target_date must be yyyy-mm-dd (got: ${spec.target_date})`);
    }
    if (spec.body !== undefined && spec.body_file !== undefined) {
      return fail(`${where}: body and body_file are mutually exclusive`);
    }
    if (spec.body_file !== undefined) {
      const resolved = resolve(cwd, spec.body_file);
      if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
        return fail(`${where} body_file escapes the project root: ${spec.body_file}`);
      }
      try {
        await stat(resolved);
      } catch {
        return fail(`${where} body_file not found: ${spec.body_file}`);
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
    const madeSoFar = (): string => created.map((c) => c.id).join(', ') || 'none';
    let result: CommandResult;
    try {
      result = await runCreateSprintCommand(spec.title, sprintOpts);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: `create sprints: unexpected error on "${spec.title}" after creating ${madeSoFar()}\n${message}\n`,
      };
    }
    if (result.exitCode !== EXIT_OK) {
      const detail = result.stderr.trim() || result.stdout.trim();
      return {
        exitCode: result.exitCode,
        stdout: '',
        stderr: `create sprints: failed on "${spec.title}" after creating ${madeSoFar()}\n${detail}\n`,
      };
    }
    let env: { id: string; file: string };
    try {
      env = JSON.parse(result.stdout) as { id: string; file: string };
    } catch {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: `create sprints: unexpected non-JSON output creating "${spec.title}" after ${madeSoFar()}\n`,
      };
    }
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
