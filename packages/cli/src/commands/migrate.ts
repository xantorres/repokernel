import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  isV1Review,
  listMarkdownFiles,
  loadConfig,
  migrateReviewV1ToV2,
  QUEUE_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  RepoKernelError,
  RUN_SCHEMA_VERSION,
  SPRINT_SCHEMA_VERSION,
} from '@repokernel/core';
import matter from 'gray-matter';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { operationalRoot, runStateRoot } from '../lifecycle/controlPaths.js';
import type { CommandResult } from './validate.js';

export interface MigrateCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
}

interface MigrateResult {
  readonly file: string;
  readonly kind: 'sprint' | 'queue' | 'run' | 'review';
  readonly action: 'upgraded' | 'already_current' | 'skipped';
  readonly fromVersion?: number;
  readonly toVersion: number;
}

async function migrateMarkdownFile(
  filePath: string,
  kind: 'sprint' | 'queue',
  targetVersion: number,
  dryRun: boolean,
): Promise<MigrateResult> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const current = parsed.data.schema_version;

  if (typeof current === 'number' && current >= targetVersion) {
    return { file: filePath, kind, action: 'already_current', toVersion: current };
  }

  if (!dryRun) {
    const updatedData = { ...parsed.data, schema_version: targetVersion };
    await writeFile(filePath, matter.stringify(parsed.content, updatedData), 'utf8');
  }

  return {
    file: filePath,
    kind,
    action: 'upgraded',
    ...(typeof current === 'number' ? { fromVersion: current } : {}),
    toVersion: targetVersion,
  };
}

async function migrateReviewFile(filePath: string, dryRun: boolean): Promise<MigrateResult> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const current = typeof data.schema_version === 'number' ? data.schema_version : undefined;

  if (current !== undefined && current >= REVIEW_SCHEMA_VERSION) {
    return {
      file: filePath,
      kind: 'review',
      action: 'already_current',
      toVersion: current,
    };
  }

  // Pre-v1 files have no schema_version; either v1 in shape or already-v2 except
  // for the schema_version field itself. Both cases: migrate.
  if (!isV1Review(data) && current === undefined) {
    // No v1 fingerprints — just stamp the schema_version field.
    if (!dryRun) {
      const updated = { ...data, schema_version: REVIEW_SCHEMA_VERSION };
      await writeFile(filePath, matter.stringify(parsed.content, updated), 'utf8');
    }
    return {
      file: filePath,
      kind: 'review',
      action: 'upgraded',
      toVersion: REVIEW_SCHEMA_VERSION,
    };
  }

  const result = migrateReviewV1ToV2(data);
  if (!dryRun) {
    await writeFile(filePath, matter.stringify(parsed.content, result.migrated), 'utf8');
  }
  return {
    file: filePath,
    kind: 'review',
    action: 'upgraded',
    ...(current !== undefined ? { fromVersion: current } : {}),
    toVersion: REVIEW_SCHEMA_VERSION,
  };
}

async function migrateRunFile(
  filePath: string,
  targetVersion: number,
  dryRun: boolean,
): Promise<MigrateResult> {
  const raw = await readFile(filePath, 'utf8');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { file: filePath, kind: 'run', action: 'skipped', toVersion: targetVersion };
  }

  const current = data.schema_version;
  if (typeof current === 'number' && current >= targetVersion) {
    return { file: filePath, kind: 'run', action: 'already_current', toVersion: current };
  }

  if (!dryRun) {
    data.schema_version = targetVersion;
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    file: filePath,
    kind: 'run',
    action: 'upgraded',
    ...(typeof current === 'number' ? { fromVersion: current } : {}),
    toVersion: targetVersion,
  };
}

export async function runMigrateCommand(opts: MigrateCommandOptions): Promise<CommandResult> {
  const startCwd = resolve(opts.cwd);

  try {
    const configResult = await loadConfig({ cwd: startCwd });
    if (!configResult.ok) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${configResult.finding.message}\n` };
    }
    const { config } = configResult;
    const cwd = configResult.cwd;

    const opRoot = await operationalRoot(cwd);
    const results: MigrateResult[] = [];

    // Migrate sprint files
    const sprintFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.sprints));
    for (const rel of sprintFiles) {
      const result = await migrateMarkdownFile(
        join(cwd, rel),
        'sprint',
        SPRINT_SCHEMA_VERSION,
        opts.dryRun,
      );
      results.push(result);
    }

    // Migrate queue files
    const queueFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.queues));
    for (const rel of queueFiles) {
      const result = await migrateMarkdownFile(
        join(cwd, rel),
        'queue',
        QUEUE_SCHEMA_VERSION,
        opts.dryRun,
      );
      results.push(result);
    }

    // Migrate review files (v1 → v2 transform when applicable)
    const reviewFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.reviews));
    for (const rel of reviewFiles) {
      const result = await migrateReviewFile(join(cwd, rel), opts.dryRun);
      results.push(result);
    }

    // Migrate run JSON files
    const runsDir = runStateRoot(opRoot);
    const runFiles = await readdir(runsDir).catch(() => [] as string[]);
    for (const f of runFiles) {
      if (!/^RUN-\d+\.json$/.test(f)) continue;
      const result = await migrateRunFile(join(runsDir, f), RUN_SCHEMA_VERSION, opts.dryRun);
      results.push(result);
    }

    // Format output
    const upgraded = results.filter((r) => r.action === 'upgraded');
    const current = results.filter((r) => r.action === 'already_current');
    const skipped = results.filter((r) => r.action === 'skipped');

    const lines: string[] = [];

    if (opts.dryRun) {
      lines.push(pc.bold(pc.yellow('dry-run — no files modified\n')));
    }

    if (upgraded.length === 0) {
      lines.push(pc.dim(`All ${results.length} file(s) already at current schema version.`));
    } else {
      lines.push(
        pc.bold(`${opts.dryRun ? 'Would upgrade' : 'Upgraded'} ${upgraded.length} file(s):\n`),
      );
      for (const r of upgraded) {
        const from = r.fromVersion !== undefined ? `v${r.fromVersion}` : 'unversioned';
        lines.push(`  ${pc.green('↑')} [${r.kind}] ${r.file}  ${from} → v${r.toVersion}`);
      }
    }

    if (current.length > 0) {
      lines.push(pc.dim(`\n${current.length} file(s) already current.`));
    }
    if (skipped.length > 0) {
      lines.push(pc.yellow(`\n${skipped.length} file(s) skipped (could not parse).`));
    }

    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}
