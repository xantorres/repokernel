import { existsSync, readFileSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepoKernelError } from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import {
  actionForBeforeAfter,
  buildInstallPaths,
  buildMarketplaceManifest,
  type ChangePlan,
  directoryExists,
  ensureInstalledPlugin,
  ensureKnownMarketplace,
  ensureMarketplaceConfigured,
  ensurePluginEnabled,
  fileExists,
  formatPlan,
  type InstallPaths,
  isPlausibleClaudeRoot,
  jsonFileAction,
  PLUGIN_ID,
  type PluginManifest,
  planPluginCopies,
  readJsonObjectSafe,
  readPluginManifest,
  readSettingsSafe,
  type SettingsShape,
  safeRestore,
  syncPluginCopies,
  validateSourceTargetSeparation,
  writeJsonAtomic,
} from './installSkillSupport.js';
import type { CommandResult } from './validate.js';

export {
  ensurePluginEnabled,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  PLUGIN_NAME,
} from './installSkillSupport.js';

export interface InstallSkillCommandOptions {
  readonly sourceDir: string;
  readonly target: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly printPath: boolean;
}

interface InstallPlanData {
  readonly plan: ChangePlan;
  readonly paths: InstallPaths;
  readonly sourceDir: string;
  readonly manifest: PluginManifest;
  readonly settingsAction: ChangePlan['settingsAction'];
  readonly knownMarketplacesAction: ChangePlan['knownMarketplacesAction'];
  readonly installedPluginsAction: ChangePlan['installedPluginsAction'];
  readonly settingsAfter: SettingsShape;
  readonly knownMarketplacesAfter: Record<string, unknown>;
  readonly installedPluginsAfter: Record<string, unknown>;
}

interface FileRestorePoint {
  readonly path: string;
  readonly backupPath: string | null;
  readonly retainOnSuccess: boolean;
}

export async function runInstallSkillCommand(
  opts: InstallSkillCommandOptions,
): Promise<CommandResult> {
  const target = resolve(opts.target);
  const sourceDir = resolve(opts.sourceDir);

  const preflight = await preflightInstall(sourceDir, target);
  if (!preflight.ok) return preflight.result;

  const { manifest, paths } = preflight;
  if (opts.printPath) {
    return { exitCode: EXIT_OK, stdout: `${paths.pluginCacheDest}\n`, stderr: '' };
  }

  const planned = await buildInstallPlan({ sourceDir, manifest, paths, force: opts.force });
  if (!planned.ok) return planned.result;

  if (opts.dryRun) {
    return { exitCode: EXIT_OK, stdout: formatPlan(planned.data.plan), stderr: '' };
  }

  if (isNoopPlan(planned.data.plan)) {
    return {
      exitCode: EXIT_OK,
      stdout: 'RepoKernel plugin already installed and up to date.\n',
      stderr: '',
    };
  }

  return applyInstallPlan(planned.data);
}

export function resolveDefaultSourceDir(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (pkg.name === 'repokernel') {
          const pluginDir = join(dir, 'plugin');
          if (existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))) {
            return pluginDir;
          }
        }
      } catch {
        // Ignore unreadable package.json; continue walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new RepoKernelError(
    'IO_ERROR',
    'cannot resolve default plugin source dir from package layout',
  );
}

export function resolveDefaultTarget(): string {
  return join(homedir(), '.claude');
}

async function preflightInstall(
  sourceDir: string,
  target: string,
): Promise<
  | {
      readonly ok: true;
      readonly manifest: PluginManifest;
      readonly paths: InstallPaths;
    }
  | { readonly ok: false; readonly result: CommandResult }
> {
  if (!isPlausibleClaudeRoot(target)) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `target ${target} does not look like a Claude config root (parent must exist)\n`,
      },
    };
  }

  if (!(await directoryExists(sourceDir))) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: `plugin source not found at ${sourceDir}\n`,
      },
    };
  }

  const manifestResult = await readPluginManifest(sourceDir);
  if (!manifestResult.ok) return { ok: false, result: manifestResult.result };

  const paths = buildInstallPaths(target, manifestResult.manifest.version);
  const overlapError = await validateSourceTargetSeparation(sourceDir, target);
  if (overlapError !== null) return { ok: false, result: overlapError };

  return { ok: true, manifest: manifestResult.manifest, paths };
}

async function buildInstallPlan(input: {
  readonly sourceDir: string;
  readonly manifest: PluginManifest;
  readonly paths: InstallPaths;
  readonly force: boolean;
}): Promise<
  | { readonly ok: true; readonly data: InstallPlanData }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const timestamp = new Date().toISOString();

  try {
    const pluginPlan = await planPluginCopies(input.sourceDir, input.paths, input.force);
    if (!pluginPlan.ok) return { ok: false, result: pluginPlan.result };

    const marketplaceManifest = buildMarketplaceManifest(input.manifest);
    const marketplaceAction = await jsonFileAction(
      input.paths.marketplaceManifestPath,
      marketplaceManifest,
    );

    const settingsBefore = await readSettingsSafe(input.paths.settingsPath);
    const settingsAfter = ensurePluginEnabled(
      ensureMarketplaceConfigured(settingsBefore, input.paths.marketplaceRoot),
      PLUGIN_ID,
    );
    const settingsAction = await actionForBeforeAfter(
      input.paths.settingsPath,
      settingsBefore,
      settingsAfter,
    );

    const knownMarketplacesBefore = await readJsonObjectSafe(input.paths.knownMarketplacesPath);
    const knownMarketplacesAfter = ensureKnownMarketplace(
      knownMarketplacesBefore,
      input.paths.marketplaceRoot,
      timestamp,
    );
    const knownMarketplacesAction = await actionForBeforeAfter(
      input.paths.knownMarketplacesPath,
      knownMarketplacesBefore,
      knownMarketplacesAfter,
    );

    const installedPluginsBefore = await readJsonObjectSafe(input.paths.installedPluginsPath);
    const installedPluginsAfter = ensureInstalledPlugin(
      installedPluginsBefore,
      input.paths.pluginCacheDest,
      input.manifest.version,
      timestamp,
      pluginPlan.pluginAction,
    );
    const installedPluginsAction = await actionForBeforeAfter(
      input.paths.installedPluginsPath,
      installedPluginsBefore,
      installedPluginsAfter,
    );

    const plan: ChangePlan = {
      pluginAction: pluginPlan.pluginAction,
      marketplaceAction,
      settingsAction,
      knownMarketplacesAction,
      installedPluginsAction,
      pluginDest: input.paths.pluginCacheDest,
      marketplaceRoot: input.paths.marketplaceRoot,
      settingsPath: input.paths.settingsPath,
      knownMarketplacesPath: input.paths.knownMarketplacesPath,
      installedPluginsPath: input.paths.installedPluginsPath,
    };

    return {
      ok: true,
      data: {
        plan,
        paths: input.paths,
        sourceDir: input.sourceDir,
        manifest: input.manifest,
        settingsAction,
        knownMarketplacesAction,
        installedPluginsAction,
        settingsAfter,
        knownMarketplacesAfter,
        installedPluginsAfter,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: `installation failed: ${(cause as Error).message}\n`,
      },
    };
  }
}

async function applyInstallPlan(data: InstallPlanData): Promise<CommandResult> {
  const restorePoints: FileRestorePoint[] = [];
  let settingsBackupPath: string | null = null;
  try {
    await addRestorePoint(
      restorePoints,
      data.paths.marketplaceManifestPath,
      data.plan.marketplaceAction,
      false,
    );
    await addRestorePoint(
      restorePoints,
      data.paths.knownMarketplacesPath,
      data.knownMarketplacesAction,
      false,
    );
    await addRestorePoint(
      restorePoints,
      data.paths.installedPluginsPath,
      data.installedPluginsAction,
      false,
    );
    settingsBackupPath = await addRestorePoint(
      restorePoints,
      data.paths.settingsPath,
      data.settingsAction,
      true,
    );

    if (data.plan.marketplaceAction !== 'noop') {
      await writeJsonAtomic(
        data.paths.marketplaceManifestPath,
        buildMarketplaceManifest(data.manifest),
      );
    }

    if (data.plan.pluginAction !== 'noop') {
      await syncPluginCopies(data.sourceDir, [
        data.paths.marketplacePluginDest,
        data.paths.pluginCacheDest,
      ]);
    }

    if (data.knownMarketplacesAction !== 'noop') {
      await writeJsonAtomic(data.paths.knownMarketplacesPath, data.knownMarketplacesAfter);
    }

    if (data.installedPluginsAction !== 'noop') {
      await writeJsonAtomic(data.paths.installedPluginsPath, data.installedPluginsAfter);
    }

    if (data.settingsAction !== 'noop') {
      await writeJsonAtomic(data.paths.settingsPath, data.settingsAfter);
    }
  } catch (cause) {
    await restoreFiles(restorePoints);
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `installation failed: ${(cause as Error).message}\n`,
    };
  }

  await cleanupTransientBackups(restorePoints);

  const summary: string[] = [];
  summary.push(formatPlan(data.plan).trimEnd());
  if (settingsBackupPath !== null) summary.push(`Backup: ${settingsBackupPath}`);
  summary.push('');
  summary.push('Restart Claude Code to load the plugin, then verify with /repokernel:rk-status.');
  summary.push('');
  summary.push('Direct session load, if needed:');
  summary.push(`  claude --plugin-dir ${data.paths.pluginCacheDest}`);
  return { exitCode: EXIT_OK, stdout: `${summary.join('\n')}\n`, stderr: '' };
}

function isNoopPlan(plan: ChangePlan): boolean {
  return (
    plan.pluginAction === 'noop' &&
    plan.marketplaceAction === 'noop' &&
    plan.settingsAction === 'noop' &&
    plan.knownMarketplacesAction === 'noop' &&
    plan.installedPluginsAction === 'noop'
  );
}

async function addRestorePoint(
  points: FileRestorePoint[],
  path: string,
  action: 'create' | 'update' | 'noop',
  retainOnSuccess: boolean,
): Promise<string | null> {
  if (action === 'noop') return null;
  if (!(await fileExists(path))) {
    points.push({ path, backupPath: null, retainOnSuccess: false });
    return null;
  }
  const backupPath = `${path}.bak.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await copyFile(path, backupPath);
  points.push({ path, backupPath, retainOnSuccess });
  return backupPath;
}

async function restoreFiles(points: readonly FileRestorePoint[]): Promise<void> {
  for (const point of [...points].reverse()) {
    if (point.backupPath === null) {
      await rm(point.path, { force: true });
      continue;
    }
    await safeRestore(point.backupPath, point.path);
  }
}

async function cleanupTransientBackups(points: readonly FileRestorePoint[]): Promise<void> {
  for (const point of points) {
    if (point.backupPath !== null && !point.retainOnSuccess) {
      await rm(point.backupPath, { force: true });
    }
  }
}
