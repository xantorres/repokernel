import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePluginEnabled,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  PLUGIN_NAME,
  resolveDefaultSourceDir,
  resolveDefaultTarget,
  runInstallSkillCommand,
} from '../src/commands/installSkill.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'rk-install-skill-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

interface SourceLayout {
  readonly dir: string;
}

async function makeFakeSource(): Promise<SourceLayout> {
  const dir = join(workspace, 'src-plugin');
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await mkdir(join(dir, 'commands'), { recursive: true });
  await mkdir(join(dir, 'skills', 'repokernel'), { recursive: true });
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0' }, null, 2),
  );
  await writeFile(join(dir, 'commands', 'rk-status.md'), '# rk-status\n');
  await writeFile(join(dir, 'skills', 'repokernel', 'SKILL.md'), '# router\n');
  return { dir };
}

async function makeTargetDir(name = 'target'): Promise<string> {
  const dir = join(workspace, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(relative(root, abs));
    }
  }
  await walk(root);
  return out.sort();
}

describe('runInstallSkillCommand', () => {
  it('--print-path emits the resolved plugin destination', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      join(target, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, '0.1.0'),
    );
  });

  it('--dry-run prints a plan and writes nothing', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: true,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('install plan');
    expect(result.stdout).toContain('create');
    const targetEntries = await readdir(target);
    expect(targetEntries).toEqual([]);
  });

  it('copies the plugin tree on first install', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).toBe(0);
    const marketplaceCopy = join(
      target,
      'plugins',
      'marketplaces',
      MARKETPLACE_NAME,
      'plugins',
      PLUGIN_NAME,
    );
    const cacheCopy = join(target, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, '0.1.0');
    const marketplaceFiles = await listFiles(marketplaceCopy);
    const cacheFiles = await listFiles(cacheCopy);
    for (const files of [marketplaceFiles, cacheFiles]) {
      expect(files).toContain(join('.claude-plugin', 'plugin.json'));
      expect(files).toContain(join('commands', 'rk-status.md'));
      expect(files).toContain(join('skills', 'repokernel', 'SKILL.md'));
    }
  });

  it('creates Claude marketplace settings and plugin registries when missing', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    const settings = JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'));
    const marketplaceRoot = join(target, 'plugins', 'marketplaces', MARKETPLACE_NAME);
    const cacheRoot = join(target, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, '0.1.0');
    expect(settings.enabledPlugins).toEqual({ [PLUGIN_ID]: true });
    expect(settings.extraKnownMarketplaces).toEqual({
      [MARKETPLACE_NAME]: {
        source: { source: 'directory', path: marketplaceRoot },
      },
    });

    const marketplaceManifest = JSON.parse(
      await readFile(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'),
    );
    expect(marketplaceManifest.name).toBe(MARKETPLACE_NAME);
    expect(marketplaceManifest.plugins[0]).toMatchObject({
      name: PLUGIN_NAME,
      source: `./plugins/${PLUGIN_NAME}`,
    });

    const knownMarketplaces = JSON.parse(
      await readFile(join(target, 'plugins', 'known_marketplaces.json'), 'utf8'),
    );
    expect(knownMarketplaces[MARKETPLACE_NAME]).toMatchObject({
      source: { source: 'directory', path: marketplaceRoot },
      installLocation: marketplaceRoot,
    });

    const installedPlugins = JSON.parse(
      await readFile(join(target, 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    expect(installedPlugins.plugins[PLUGIN_ID][0]).toMatchObject({
      scope: 'user',
      installPath: cacheRoot,
      version: '0.1.0',
    });
  });

  it('merges into existing settings.json without dropping unknown keys and creates a backup', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const settingsPath = join(target, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          theme: 'dark',
          enabledPlugins: { 'some-other-plugin@custom': true },
          customKey: { nested: true },
        },
        null,
        2,
      ),
    );
    await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    const updated = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(updated.theme).toBe('dark');
    expect(updated.enabledPlugins).toEqual({
      'some-other-plugin@custom': true,
      [PLUGIN_ID]: true,
    });
    expect(updated.customKey).toEqual({ nested: true });
    const entries = await readdir(target);
    const hasBackup = entries.some((e) => e.startsWith('settings.json.bak.'));
    expect(hasBackup).toBe(true);
  });

  it('is idempotent — re-running on identical content does not duplicate', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const first = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(first.exitCode).toBe(0);
    const second = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('already installed and up to date');
    const settings = JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'));
    expect(settings.enabledPlugins).toEqual({ [PLUGIN_ID]: true });
  });

  it('refuses to overwrite a divergent existing install without --force', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const installedRoot = join(
      target,
      'plugins',
      'cache',
      MARKETPLACE_NAME,
      PLUGIN_NAME,
      '0.1.0',
      '.claude-plugin',
    );
    await mkdir(installedRoot, { recursive: true });
    await writeFile(
      join(installedRoot, 'plugin.json'),
      JSON.stringify({ name: PLUGIN_NAME, version: '0.0.1-old' }),
    );
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--force');
  });

  it('--force overwrites a divergent install', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const installedRoot = join(
      target,
      'plugins',
      'cache',
      MARKETPLACE_NAME,
      PLUGIN_NAME,
      '0.1.0',
      '.claude-plugin',
    );
    await mkdir(installedRoot, { recursive: true });
    await writeFile(
      join(installedRoot, 'plugin.json'),
      JSON.stringify({ name: PLUGIN_NAME, version: '0.0.1-old' }),
    );
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: true,
      printPath: false,
    });
    expect(result.exitCode).toBe(0);
    const newManifest = JSON.parse(
      await readFile(
        join(
          target,
          'plugins',
          'cache',
          MARKETPLACE_NAME,
          PLUGIN_NAME,
          '0.1.0',
          '.claude-plugin',
          'plugin.json',
        ),
        'utf8',
      ),
    );
    expect(newManifest.version).toBe('0.1.0');
  });

  it('--force removes stale files from a divergent install', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const installedRoots = [
      join(target, 'plugins', 'marketplaces', MARKETPLACE_NAME, 'plugins', PLUGIN_NAME),
      join(target, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, '0.1.0'),
    ];
    for (const installedRoot of installedRoots) {
      await mkdir(join(installedRoot, '.claude-plugin'), { recursive: true });
      await mkdir(join(installedRoot, 'commands'), { recursive: true });
      await writeFile(
        join(installedRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: PLUGIN_NAME, version: '0.0.1-old' }),
      );
      await writeFile(join(installedRoot, 'commands', 'stale.md'), '# stale\n');
    }
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: true,
      printPath: false,
    });
    expect(result.exitCode).toBe(0);
    for (const installedRoot of installedRoots) {
      const files = await listFiles(installedRoot);
      expect(files).toContain(join('commands', 'rk-status.md'));
      expect(files).not.toContain(join('commands', 'stale.md'));
    }
  });

  it('refuses if target looks like a project root', async () => {
    const source = await makeFakeSource();
    const projectLike = await makeTargetDir('project');
    await writeFile(join(projectLike, 'package.json'), '{}');
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target: projectLike,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('does not look like a Claude config root');
  });

  it('errors if source plugin is missing', async () => {
    const target = await makeTargetDir();
    const result = await runInstallSkillCommand({
      sourceDir: join(workspace, 'does-not-exist'),
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('plugin source not found');
  });

  it('refuses source directories without a RepoKernel plugin manifest', async () => {
    const source = join(workspace, 'not-a-plugin');
    const target = await makeTargetDir();
    await mkdir(source, { recursive: true });
    const result = await runInstallSkillCommand({
      sourceDir: source,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('.claude-plugin');
  });

  it('refuses source directories whose plugin manifest has the wrong name', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    await writeFile(
      join(source.dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'other-plugin', version: '0.1.0' }),
    );
    const result = await runInstallSkillCommand({
      sourceDir: source.dir,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('expected plugin name');
  });

  it('refuses source and target directories that overlap', async () => {
    const target = await makeTargetDir();
    const source = join(target, 'src-plugin');
    await mkdir(source, { recursive: true });
    await mkdir(join(source, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(source, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0' }),
    );
    const result = await runInstallSkillCommand({
      sourceDir: source,
      target,
      dryRun: false,
      force: false,
      printPath: false,
    });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('must not overlap');
  });
});

describe('ensurePluginEnabled', () => {
  it('adds the plugin id as an object-map entry when enabledPlugins is missing', () => {
    const out = ensurePluginEnabled({}, PLUGIN_ID);
    expect(out.enabledPlugins).toEqual({ [PLUGIN_ID]: true });
  });

  it('migrates legacy arrays to object-map entries', () => {
    const out = ensurePluginEnabled({ enabledPlugins: ['a@local', PLUGIN_NAME] }, PLUGIN_ID);
    expect(out.enabledPlugins).toEqual({
      'a@local': true,
      [PLUGIN_ID]: true,
    });
  });

  it('is a no-op when already enabled', () => {
    const before = { enabledPlugins: { 'a@local': true, [PLUGIN_ID]: true } };
    const after = ensurePluginEnabled(before, PLUGIN_ID);
    expect(after).toBe(before);
  });

  it('preserves unknown top-level keys', () => {
    const out = ensurePluginEnabled({ theme: 'dark', extras: { x: 1 } }, PLUGIN_ID);
    expect(out.theme).toBe('dark');
    expect(out.extras).toEqual({ x: 1 });
    expect(out.enabledPlugins).toEqual({ [PLUGIN_ID]: true });
  });
});

describe('resolveDefaultSourceDir / resolveDefaultTarget', () => {
  it('resolveDefaultTarget returns ~/.claude', () => {
    expect(resolveDefaultTarget()).toMatch(/\.claude$/);
  });

  it('resolveDefaultSourceDir finds the package plugin directory', () => {
    const dir = resolveDefaultSourceDir();
    expect(basename(dir)).toBe('plugin');
    expect(dir).toContain('packages/cli');
  });
});
