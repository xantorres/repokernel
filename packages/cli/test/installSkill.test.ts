import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePluginEnabled,
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
    expect(result.stdout.trim()).toBe(join(target, 'plugins', PLUGIN_NAME));
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
    const installed = join(target, 'plugins', PLUGIN_NAME);
    const files = await listFiles(installed);
    expect(files).toContain(join('.claude-plugin', 'plugin.json'));
    expect(files).toContain(join('commands', 'rk-status.md'));
    expect(files).toContain(join('skills', 'repokernel', 'SKILL.md'));
  });

  it('creates settings.json with enabledPlugins when missing', async () => {
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
    expect(settings.enabledPlugins).toContain(PLUGIN_NAME);
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
          enabledPlugins: ['some-other-plugin'],
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
    expect(updated.enabledPlugins).toEqual(['some-other-plugin', PLUGIN_NAME]);
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
    const repokernelEntries = (settings.enabledPlugins as string[]).filter(
      (n) => n === PLUGIN_NAME,
    );
    expect(repokernelEntries).toHaveLength(1);
  });

  it('refuses to overwrite a divergent existing install without --force', async () => {
    const source = await makeFakeSource();
    const target = await makeTargetDir();
    const installedRoot = join(target, 'plugins', PLUGIN_NAME, '.claude-plugin');
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
    const installedRoot = join(target, 'plugins', PLUGIN_NAME, '.claude-plugin');
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
      await readFile(join(target, 'plugins', PLUGIN_NAME, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(newManifest.version).toBe('0.1.0');
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
});

describe('ensurePluginEnabled', () => {
  it('appends the plugin name when enabledPlugins is missing', () => {
    const out = ensurePluginEnabled({}, PLUGIN_NAME);
    expect(out.enabledPlugins).toEqual([PLUGIN_NAME]);
  });

  it('preserves order when adding to an existing list', () => {
    const out = ensurePluginEnabled({ enabledPlugins: ['a', 'b'] }, PLUGIN_NAME);
    expect(out.enabledPlugins).toEqual(['a', 'b', PLUGIN_NAME]);
  });

  it('is a no-op when already enabled', () => {
    const before = { enabledPlugins: ['a', PLUGIN_NAME, 'b'] };
    const after = ensurePluginEnabled(before, PLUGIN_NAME);
    expect(after).toBe(before);
  });

  it('preserves unknown top-level keys', () => {
    const out = ensurePluginEnabled({ theme: 'dark', extras: { x: 1 } }, PLUGIN_NAME);
    expect(out.theme).toBe('dark');
    expect(out.extras).toEqual({ x: 1 });
    expect(out.enabledPlugins).toEqual([PLUGIN_NAME]);
  });
});

describe('resolveDefaultSourceDir / resolveDefaultTarget', () => {
  it('resolveDefaultTarget returns ~/.claude', () => {
    expect(resolveDefaultTarget()).toMatch(/\.claude$/);
  });

  it('resolveDefaultSourceDir finds the package plugin directory', () => {
    const dir = resolveDefaultSourceDir();
    expect(dir).toMatch(/\/plugin$/);
    expect(dir).toContain('packages/cli');
  });
});
