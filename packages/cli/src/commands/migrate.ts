import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  listMarkdownFiles,
  loadConfig,
  QUEUE_SCHEMA_VERSION,
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
  readonly kind: 'sprint' | 'queue' | 'run';
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
