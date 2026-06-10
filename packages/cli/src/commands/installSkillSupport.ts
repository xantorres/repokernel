import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RepoKernelError, toErrorMessage } from '@repokernel/core';
import { EXIT_USAGE } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export const PLUGIN_NAME = 'repokernel';
export const MARKETPLACE_NAME = 'repokernel';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

const USER_SCOPE = 'user';
const INSTALLED_PLUGINS_SCHEMA_VERSION = 2;

export interface SettingsShape {
  enabledPlugins?: Record<string, boolean> | readonly string[];
  extraKnownMarketplaces?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string | Record<string, unknown>;
  readonly homepage?: string;
  readonly repository?: string | Record<string, unknown>;
  readonly license?: string;
  readonly keywords?: readonly string[];
}

export interface InstallPaths {
  readonly target: string;
  readonly settingsPath: string;
  readonly marketplaceRoot: string;
  readonly marketplaceManifestPath: string;
  readonly marketplacePluginDest: string;
  readonly pluginCacheDest: string;
  readonly knownMarketplacesPath: string;
  readonly installedPluginsPath: string;
}

export interface ChangePlan {
  readonly pluginAction: 'create' | 'overwrite' | 'noop';
  readonly marketplaceAction: 'create' | 'update' | 'noop';
  readonly settingsAction: 'create' | 'update' | 'noop';
  readonly knownMarketplacesAction: 'create' | 'update' | 'noop';
  readonly installedPluginsAction: 'create' | 'update' | 'noop';
  readonly pluginDest: string;
  readonly marketplaceRoot: string;
  readonly settingsPath: string;
  readonly knownMarketplacesPath: string;
  readonly installedPluginsPath: string;
}

export type PluginManifestReadResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly result: CommandResult };

export type PluginCopyPlanResult =
  | { readonly ok: true; readonly pluginAction: ChangePlan['pluginAction'] }
  | { readonly ok: false; readonly result: CommandResult };

export function ensurePluginEnabled(settings: SettingsShape, pluginId: string): SettingsShape {
  const enabled = normalizeEnabledPlugins(settings.enabledPlugins);
  if (
    !Array.isArray(settings.enabledPlugins) &&
    isRecord(settings.enabledPlugins) &&
    settings.enabledPlugins[pluginId] === true
  ) {
    return settings;
  }
  return { ...settings, enabledPlugins: { ...enabled, [pluginId]: true } };
}

export function buildInstallPaths(target: string, version: string): InstallPaths {
  const marketplaceRoot = join(target, 'plugins', 'marketplaces', MARKETPLACE_NAME);
  return {
    target,
    settingsPath: join(target, 'settings.json'),
    marketplaceRoot,
    marketplaceManifestPath: join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    marketplacePluginDest: join(marketplaceRoot, 'plugins', PLUGIN_NAME),
    pluginCacheDest: join(target, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, version),
    knownMarketplacesPath: join(target, 'plugins', 'known_marketplaces.json'),
    installedPluginsPath: join(target, 'plugins', 'installed_plugins.json'),
  };
}

export function isPlausibleClaudeRoot(target: string): boolean {
  if (target === '/' || target === '') return false;
  const parent = dirname(target);
  if (!existsSyncCompat(parent)) return false;
  const projectMarkers = ['package.json', 'repokernel.config.yaml', '.git'];
  for (const marker of projectMarkers) {
    if (existsSyncCompat(join(target, marker))) return false;
  }
  return true;
}

export async function readPluginManifest(sourceDir: string): Promise<PluginManifestReadResult> {
  const manifestPath = join(sourceDir, '.claude-plugin', 'plugin.json');
  if (!(await fileExists(manifestPath))) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `plugin source must contain .claude-plugin/plugin.json at ${manifestPath}\n`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `cannot parse ${manifestPath}: ${toErrorMessage(cause)}\n`,
      },
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `${manifestPath} must contain a JSON object\n`,
      },
    };
  }

  const name = readRequiredString(parsed, 'name');
  if (name !== PLUGIN_NAME) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `expected plugin name "${PLUGIN_NAME}" in ${manifestPath}, got "${name ?? '<missing>'}"\n`,
      },
    };
  }

  const version = readRequiredString(parsed, 'version');
  if (version === undefined || !isSafePathSegment(version)) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `plugin manifest ${manifestPath} must include a safe string version\n`,
      },
    };
  }

  const description = readOptionalString(parsed, 'description');
  const author = readAuthor(parsed.author);
  const homepage = readOptionalString(parsed, 'homepage');
  const repository = readRepository(parsed.repository);
  const license = readOptionalString(parsed, 'license');
  const keywords = readStringArray(parsed.keywords);

  return {
    ok: true,
    manifest: {
      name,
      version,
      ...(description !== undefined ? { description } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
      ...(repository !== undefined ? { repository } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
    },
  };
}

export async function validateSourceTargetSeparation(
  sourceDir: string,
  target: string,
): Promise<CommandResult | null> {
  const sourceRealpath = await realpath(sourceDir);
  const targetPath = await existingRealpathOrResolved(target);
  if (isSameOrInside(sourceRealpath, targetPath) || isSameOrInside(targetPath, sourceRealpath)) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: `plugin source ${sourceRealpath} and Claude target ${targetPath} must not overlap\n`,
    };
  }
  return null;
}

export async function planPluginCopies(
  sourceDir: string,
  paths: InstallPaths,
  force: boolean,
): Promise<PluginCopyPlanResult> {
  const destinations = [paths.marketplacePluginDest, paths.pluginCacheDest];
  let existingCount = 0;
  let missingCount = 0;
  let divergentPath: string | null = null;

  for (const destination of destinations) {
    if (!(await directoryExists(destination))) {
      missingCount += 1;
      continue;
    }
    existingCount += 1;
    if (!(await directoriesAreIdentical(sourceDir, destination))) {
      divergentPath = destination;
    }
  }

  if (divergentPath !== null && !force) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `plugin already installed at ${divergentPath} and differs from source. Re-run with --force to overwrite.\n`,
      },
    };
  }

  if (divergentPath !== null) return { ok: true, pluginAction: 'overwrite' };
  if (missingCount > 0) {
    return { ok: true, pluginAction: existingCount > 0 ? 'overwrite' : 'create' };
  }
  return { ok: true, pluginAction: 'noop' };
}

export function buildMarketplaceManifest(manifest: PluginManifest): Record<string, unknown> {
  return {
    name: MARKETPLACE_NAME,
    metadata: {
      description: 'RepoKernel local marketplace',
    },
    owner: marketplaceOwner(manifest),
    plugins: [
      {
        name: PLUGIN_NAME,
        description:
          manifest.description ??
          'Agent-operated workflow for RepoKernel projects and review gates.',
        source: `./plugins/${PLUGIN_NAME}`,
        ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
      },
    ],
  };
}

export function ensureMarketplaceConfigured(
  settings: SettingsShape,
  marketplaceRoot: string,
): SettingsShape {
  const existing = isRecord(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const entry = marketplaceSettingsEntry(marketplaceRoot);
  if (jsonEqual(existing[MARKETPLACE_NAME], entry)) return settings;
  return {
    ...settings,
    extraKnownMarketplaces: {
      ...existing,
      [MARKETPLACE_NAME]: entry,
    },
  };
}

export function ensureKnownMarketplace(
  file: Record<string, unknown>,
  marketplaceRoot: string,
  timestamp: string,
): Record<string, unknown> {
  const current = file[MARKETPLACE_NAME];
  if (
    isRecord(current) &&
    jsonEqual(current.source, marketplaceSettingsEntry(marketplaceRoot).source) &&
    current.installLocation === marketplaceRoot &&
    typeof current.lastUpdated === 'string'
  ) {
    return file;
  }

  return {
    ...file,
    [MARKETPLACE_NAME]: {
      ...marketplaceSettingsEntry(marketplaceRoot),
      installLocation: marketplaceRoot,
      lastUpdated: timestamp,
    },
  };
}

export function ensureInstalledPlugin(
  file: Record<string, unknown>,
  pluginCacheDest: string,
  version: string,
  timestamp: string,
  pluginAction: ChangePlan['pluginAction'],
): Record<string, unknown> {
  const plugins = isRecord(file.plugins) ? file.plugins : {};
  const existingEntries = Array.isArray(plugins[PLUGIN_ID])
    ? (plugins[PLUGIN_ID] as readonly unknown[]).filter(isRecord)
    : [];
  const userIndex = existingEntries.findIndex((entry) => entry.scope === USER_SCOPE);
  const userEntry = userIndex >= 0 ? existingEntries[userIndex] : undefined;

  if (
    file.version === INSTALLED_PLUGINS_SCHEMA_VERSION &&
    userEntry !== undefined &&
    userEntry.installPath === pluginCacheDest &&
    userEntry.version === version &&
    typeof userEntry.installedAt === 'string' &&
    typeof userEntry.lastUpdated === 'string' &&
    pluginAction === 'noop'
  ) {
    return file;
  }

  const nextUserEntry = {
    ...(userEntry ?? {}),
    scope: USER_SCOPE,
    installPath: pluginCacheDest,
    version,
    installedAt: readOptionalString(userEntry, 'installedAt') ?? timestamp,
    lastUpdated: timestamp,
  };
  const nextEntries =
    userIndex >= 0
      ? existingEntries.map((entry, index) => (index === userIndex ? nextUserEntry : entry))
      : [...existingEntries, nextUserEntry];

  return {
    ...file,
    version: INSTALLED_PLUGINS_SCHEMA_VERSION,
    plugins: {
      ...plugins,
      [PLUGIN_ID]: nextEntries,
    },
  };
}

export async function readSettingsSafe(path: string): Promise<SettingsShape> {
  return (await readJsonObjectSafe(path)) as SettingsShape;
}

export async function readJsonObjectSafe(path: string): Promise<Record<string, unknown>> {
  if (!(await fileExists(path))) return {};
  const raw = await readFile(path, 'utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('JSON file must contain an object');
    }
    return parsed;
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `cannot parse ${path}: ${toErrorMessage(cause)}`, cause);
  }
}

export async function jsonFileAction(
  path: string,
  desired: Record<string, unknown>,
): Promise<'create' | 'update' | 'noop'> {
  const exists = await fileExists(path);
  if (!exists) return 'create';
  const before = await readJsonObjectSafe(path);
  return jsonEqual(before, desired) ? 'noop' : 'update';
}

export async function actionForBeforeAfter(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<'create' | 'update' | 'noop'> {
  if (jsonEqual(before, after)) return 'noop';
  return (await fileExists(path)) ? 'update' : 'create';
}

export function formatPlan(plan: ChangePlan): string {
  const lines: string[] = ['RepoKernel install plan:'];
  pushActionLine(lines, plan.marketplaceAction, plan.marketplaceRoot);
  pushActionLine(lines, plan.pluginAction, plan.pluginDest);
  pushActionLine(lines, plan.knownMarketplacesAction, plan.knownMarketplacesPath);
  pushActionLine(lines, plan.installedPluginsAction, plan.installedPluginsPath);
  if (plan.settingsAction === 'create')
    lines.push(`  create   ${plan.settingsPath} (enable plugin "${PLUGIN_ID}")`);
  if (plan.settingsAction === 'update')
    lines.push(`  update   ${plan.settingsPath} (enable plugin "${PLUGIN_ID}")`);
  if (plan.settingsAction === 'noop') lines.push(`  unchanged ${plan.settingsPath}`);
  return `${lines.join('\n')}\n`;
}

interface DirectoryReplacement {
  readonly dest: string;
  readonly staging: string;
  readonly backup: string;
  hadExisting: boolean;
}

export async function syncPluginCopies(
  src: string,
  destinations: readonly string[],
): Promise<void> {
  const replacements: DirectoryReplacement[] = [];
  try {
    for (const dest of destinations) {
      if ((await directoryExists(dest)) && (await directoriesAreIdentical(src, dest))) {
        continue;
      }
      const parent = dirname(dest);
      await mkdir(parent, { recursive: true });
      const staging = await mkdtemp(join(parent, `.${basename(dest)}.tmp-`));
      await copyDir(src, staging);
      replacements.push({
        dest,
        staging,
        backup: `${dest}.bak.${Date.now()}.${Math.random().toString(16).slice(2)}`,
        hadExisting: false,
      });
    }

    await commitDirectoryReplacements(replacements);
  } catch (cause) {
    await cleanupDirectoryReplacements(replacements);
    throw cause;
  }
}

export async function writeJsonAtomic(path: string, value: Record<string, unknown>): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(serialized);
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.tmp.${Date.now()}.${process.pid}`);
  try {
    await writeFile(temp, serialized, 'utf8');
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true });
    throw cause;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw new RepoKernelError('IO_ERROR', `cannot access ${path}`, cause);
  }
}

export async function directoryExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw new RepoKernelError('IO_ERROR', `cannot access ${path}`, cause);
  }
}

export async function safeRestore(backup: string, original: string): Promise<void> {
  try {
    await rename(backup, original);
  } catch {
    // Best-effort restore; the backup file remains on disk for manual recovery.
  }
}

function existsSyncCompat(path: string): boolean {
  return existsSync(path);
}

async function existingRealpathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return resolve(path);
    throw cause;
  }
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function marketplaceOwner(manifest: PluginManifest): Record<string, string> {
  if (typeof manifest.author === 'string' && manifest.author.trim() !== '') {
    return { name: manifest.author.trim() };
  }
  if (isRecord(manifest.author)) {
    const name = readOptionalString(manifest.author, 'name');
    const email = readOptionalString(manifest.author, 'email');
    const url = readOptionalString(manifest.author, 'url');
    return {
      name: name ?? 'RepoKernel',
      ...(email !== undefined ? { email } : {}),
      ...(url !== undefined ? { url } : {}),
    };
  }
  return { name: 'RepoKernel', url: 'https://github.com/xantorres/repokernel' };
}

function marketplaceSettingsEntry(marketplaceRoot: string): Record<string, unknown> {
  return {
    source: {
      source: 'directory',
      path: marketplaceRoot,
    },
  };
}

function normalizeEnabledPlugins(
  enabledPlugins: SettingsShape['enabledPlugins'],
): Record<string, boolean> {
  if (Array.isArray(enabledPlugins)) {
    return Object.fromEntries(
      enabledPlugins
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => [normalizePluginId(value), true]),
    );
  }

  if (!isRecord(enabledPlugins)) return {};
  const entries = Object.entries(enabledPlugins).filter(
    (entry): entry is [string, boolean] =>
      typeof entry[0] === 'string' && typeof entry[1] === 'boolean',
  );
  return Object.fromEntries(entries.map(([key, value]) => [normalizePluginId(key), value]));
}

function normalizePluginId(pluginId: string): string {
  return pluginId === PLUGIN_NAME ? PLUGIN_ID : pluginId;
}

function pushActionLine(
  lines: string[],
  action: 'create' | 'overwrite' | 'update' | 'noop',
  path: string,
): void {
  if (action === 'create') lines.push(`  create   ${path}`);
  if (action === 'overwrite') lines.push(`  overwrite ${path}`);
  if (action === 'update') lines.push(`  update   ${path}`);
  if (action === 'noop') lines.push(`  unchanged ${path}`);
}

async function commitDirectoryReplacements(replacements: readonly DirectoryReplacement[]) {
  const applied: DirectoryReplacement[] = [];
  try {
    for (const replacement of replacements) {
      replacement.hadExisting = await directoryExists(replacement.dest);
      if (replacement.hadExisting) {
        await rename(replacement.dest, replacement.backup);
      }
      try {
        await rename(replacement.staging, replacement.dest);
      } catch (cause) {
        if (
          replacement.hadExisting &&
          !(await directoryExists(replacement.dest)) &&
          (await directoryExists(replacement.backup))
        ) {
          await rename(replacement.backup, replacement.dest);
        }
        throw cause;
      }
      applied.push(replacement);
    }
  } catch (cause) {
    for (const replacement of applied.reverse()) {
      await rm(replacement.dest, { recursive: true, force: true });
      if (replacement.hadExisting && (await directoryExists(replacement.backup))) {
        await rename(replacement.backup, replacement.dest);
      }
    }
    throw cause;
  }

  for (const replacement of replacements) {
    if (replacement.hadExisting) {
      await rm(replacement.backup, { recursive: true, force: true });
    }
  }
}

async function cleanupDirectoryReplacements(
  replacements: readonly DirectoryReplacement[],
): Promise<void> {
  for (const replacement of replacements) {
    await rm(replacement.staging, { recursive: true, force: true });
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readOptionalString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readAuthor(value: unknown): PluginManifest['author'] {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (isRecord(value)) return value;
  return undefined;
}

function readRepository(value: unknown): PluginManifest['repository'] {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (isRecord(value)) return value;
  return undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

function isSafePathSegment(value: string): boolean {
  return (
    value !== '' && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..'
  );
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
