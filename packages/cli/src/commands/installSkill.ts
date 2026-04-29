import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepoKernelError } from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export const PLUGIN_NAME = 'repokernel';

export interface InstallSkillCommandOptions {
  readonly sourceDir: string;
  readonly target: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly printPath: boolean;
}

interface SettingsShape {
  enabledPlugins?: readonly string[];
  [key: string]: unknown;
}

interface ChangePlan {
  readonly pluginAction: 'create' | 'overwrite' | 'noop';
  readonly settingsAction: 'create' | 'update' | 'noop';
  readonly pluginDest: string;
  readonly settingsPath: string;
}

export async function runInstallSkillCommand(
  opts: InstallSkillCommandOptions,
): Promise<CommandResult> {
  const target = resolve(opts.target);
  const pluginDest = join(target, 'plugins', PLUGIN_NAME);
  const settingsPath = join(target, 'settings.json');

  if (opts.printPath) {
    return { exitCode: EXIT_OK, stdout: `${pluginDest}\n`, stderr: '' };
  }

  if (!isPlausibleClaudeRoot(target)) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: `target ${target} does not look like a Claude config root (parent must exist)\n`,
    };
  }

  if (!(await directoryExists(opts.sourceDir))) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `plugin source not found at ${opts.sourceDir}\n`,
    };
  }

  const existingPluginInstall = await directoryExists(pluginDest);

  let pluginAction: ChangePlan['pluginAction'] = 'create';
  if (existingPluginInstall) {
    const identical = await directoriesAreIdentical(opts.sourceDir, pluginDest);
    if (identical) {
      pluginAction = 'noop';
    } else if (opts.force) {
      pluginAction = 'overwrite';
    } else {
      return {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `plugin already installed at ${pluginDest} and differs from source. Re-run with --force to overwrite.\n`,
      };
    }
  }

  const settingsBefore = await readSettingsSafe(settingsPath);
  const settingsAfter = ensurePluginEnabled(settingsBefore, PLUGIN_NAME);
  const settingsChanged = !shallowEqual(settingsBefore, settingsAfter);
  const settingsExists = await fileExists(settingsPath);
  const settingsAction: ChangePlan['settingsAction'] = settingsChanged
    ? settingsExists
      ? 'update'
      : 'create'
    : 'noop';

  const plan: ChangePlan = {
    pluginAction,
    settingsAction,
    pluginDest,
    settingsPath,
  };

  if (opts.dryRun) {
    return { exitCode: EXIT_OK, stdout: formatPlan(plan), stderr: '' };
  }

  if (pluginAction === 'noop' && settingsAction === 'noop') {
    return {
      exitCode: EXIT_OK,
      stdout: 'RepoKernel plugin already installed and up to date.\n',
      stderr: '',
    };
  }

  let backupPath: string | null = null;
  try {
    if (settingsAction === 'update' && settingsExists) {
      backupPath = `${settingsPath}.bak.${Date.now()}`;
      await copyFile(settingsPath, backupPath);
    }

    if (pluginAction !== 'noop') {
      await mkdir(pluginDest, { recursive: true });
      await copyDir(opts.sourceDir, pluginDest);
    }

    if (settingsAction !== 'noop') {
      const serialized = `${JSON.stringify(settingsAfter, null, 2)}\n`;
      JSON.parse(serialized);
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, serialized, 'utf8');
    }
  } catch (cause) {
    if (backupPath !== null) {
      await safeRestore(backupPath, settingsPath);
    }
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `installation failed: ${(cause as Error).message}\n`,
    };
  }

  const summary: string[] = [];
  summary.push(formatPlan(plan).trimEnd());
  if (backupPath !== null) summary.push(`Backup: ${backupPath}`);
  summary.push('');
  summary.push('Restart Claude Code to load the plugin, then verify with /rk-status.');
  summary.push('');
  summary.push('If your harness does not auto-discover plugins from settings, load directly:');
  summary.push(`  claude --plugin-dir ${pluginDest}`);
  return { exitCode: EXIT_OK, stdout: `${summary.join('\n')}\n`, stderr: '' };
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

export function ensurePluginEnabled(settings: SettingsShape, pluginName: string): SettingsShape {
  const enabled = Array.isArray(settings.enabledPlugins) ? [...settings.enabledPlugins] : [];
  if (enabled.includes(pluginName)) return settings;
  enabled.push(pluginName);
  return { ...settings, enabledPlugins: enabled };
}

function isPlausibleClaudeRoot(target: string): boolean {
  if (target === '/' || target === '') return false;
  const parent = dirname(target);
  if (!existsSync(parent)) return false;
  const projectMarkers = ['package.json', 'repokernel.config.yaml', '.git'];
  for (const marker of projectMarkers) {
    if (existsSync(join(target, marker))) return false;
  }
  return true;
}

async function readSettingsSafe(path: string): Promise<SettingsShape> {
  if (!(await fileExists(path))) return {};
  const raw = await readFile(path, 'utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json must contain a JSON object');
    }
    return parsed as SettingsShape;
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `cannot parse ${path}: ${(cause as Error).message}`,
      cause,
    );
  }
}

function shallowEqual(a: SettingsShape, b: SettingsShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatPlan(plan: ChangePlan): string {
  const lines: string[] = ['RepoKernel install plan:'];
  if (plan.pluginAction === 'create') lines.push(`  create   ${plan.pluginDest}`);
  if (plan.pluginAction === 'overwrite') lines.push(`  overwrite ${plan.pluginDest}`);
  if (plan.pluginAction === 'noop') lines.push(`  unchanged ${plan.pluginDest}`);
  if (plan.settingsAction === 'create')
    lines.push(`  create   ${plan.settingsPath} (enable plugin "${PLUGIN_NAME}")`);
  if (plan.settingsAction === 'update')
    lines.push(`  update   ${plan.settingsPath} (enable plugin "${PLUGIN_NAME}")`);
  if (plan.settingsAction === 'noop') lines.push(`  unchanged ${plan.settingsPath}`);
  return `${lines.join('\n')}\n`;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function directoriesAreIdentical(a: string, b: string): Promise<boolean> {
  const filesA = await listFilesRelative(a);
  const filesB = await listFilesRelative(b);
  if (filesA.length !== filesB.length) return false;
  for (let i = 0; i < filesA.length; i += 1) {
    const relA = filesA[i];
    const relB = filesB[i];
    if (relA === undefined || relB === undefined || relA !== relB) return false;
    const contentA = await readFile(join(a, relA));
    const contentB = await readFile(join(b, relB));
    if (!contentA.equals(contentB)) return false;
  }
  return true;
}

async function listFilesRelative(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        result.push(relative(root, abs));
      }
    }
  }
  await walk(root);
  return result.sort();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw new RepoKernelError('IO_ERROR', `cannot access ${path}`, cause);
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw new RepoKernelError('IO_ERROR', `cannot access ${path}`, cause);
  }
}

async function safeRestore(backup: string, original: string): Promise<void> {
  try {
    await rename(backup, original);
  } catch {
    // Best-effort restore; the backup file remains on disk for manual recovery.
  }
}
