import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIdeFile,
  resolveIdePath,
  runInstallSkillIdeCommand,
} from '../src/commands/installSkillIde.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join((await import('node:os')).tmpdir(), 'rk-install-ide-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function makeSkillSource(content = '# RepoKernel\nsome body\n'): Promise<string> {
  const dir = join(workspace, 'plugin');
  await mkdir(join(dir, 'skills', 'repokernel'), { recursive: true });
  await writeFile(join(dir, 'skills', 'repokernel', 'SKILL.md'), content);
  return dir;
}

describe('resolveIdePath', () => {
  it('cursor user-global resolves to ~/.cursor/rules/repokernel.mdc', () => {
    const path = resolveIdePath('cursor', false, '/project');
    expect(path).toBe(join(homedir(), '.cursor', 'rules', 'repokernel.mdc'));
  });

  it('cursor project resolves to <cwd>/.cursor/rules/repokernel.mdc', () => {
    const path = resolveIdePath('cursor', true, '/project');
    expect(path).toBe('/project/.cursor/rules/repokernel.mdc');
  });

  it('windsurf user-global resolves to ~/.windsurf/rules/repokernel.md', () => {
    const path = resolveIdePath('windsurf', false, '/project');
    expect(path).toBe(join(homedir(), '.windsurf', 'rules', 'repokernel.md'));
  });

  it('windsurf project resolves to <cwd>/.windsurf/rules/repokernel.md', () => {
    const path = resolveIdePath('windsurf', true, '/project');
    expect(path).toBe('/project/.windsurf/rules/repokernel.md');
  });

  it('copilot resolves to <cwd>/.github/copilot-instructions.md', () => {
    const path = resolveIdePath('copilot', false, '/project');
    expect(path).toBe('/project/.github/copilot-instructions.md');
    const pathProject = resolveIdePath('copilot', true, '/project');
    expect(pathProject).toBe('/project/.github/copilot-instructions.md');
  });

  it('gemini user-global resolves to ~/.gemini/GEMINI.md', () => {
    const path = resolveIdePath('gemini', false, '/project');
    expect(path).toBe(join(homedir(), '.gemini', 'GEMINI.md'));
  });

  it('gemini project resolves to <cwd>/GEMINI.md', () => {
    const path = resolveIdePath('gemini', true, '/project');
    expect(path).toBe('/project/GEMINI.md');
  });

  it('opencode user-global resolves to ~/.config/opencode/instructions.md', () => {
    const path = resolveIdePath('opencode', false, '/project');
    expect(path).toBe(join(homedir(), '.config', 'opencode', 'instructions.md'));
  });

  it('opencode project resolves to <cwd>/.opencode/instructions.md', () => {
    const path = resolveIdePath('opencode', true, '/project');
    expect(path).toBe('/project/.opencode/instructions.md');
  });
});

describe('buildIdeFile', () => {
  const body = 'Some skill content\n';

  it('cursor output has YAML frontmatter', () => {
    const out = buildIdeFile('cursor', body);
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('alwaysApply: false');
    expect(out).toContain(body.trimEnd());
  });

  it('windsurf output is plain markdown', () => {
    const out = buildIdeFile('windsurf', body);
    expect(out).not.toContain('---');
    expect(out).toContain(body.trimEnd());
  });

  it('copilot output has repokernel markers', () => {
    const out = buildIdeFile('copilot', body);
    expect(out).toContain('<!-- repokernel:start -->');
    expect(out).toContain('<!-- repokernel:end -->');
    expect(out).toContain(body.trimEnd());
  });

  it('gemini output has repokernel markers', () => {
    const out = buildIdeFile('gemini', body);
    expect(out).toContain('<!-- repokernel:start -->');
    expect(out).toContain('<!-- repokernel:end -->');
  });

  it('opencode output has repokernel markers', () => {
    const out = buildIdeFile('opencode', body);
    expect(out).toContain('<!-- repokernel:start -->');
    expect(out).toContain('<!-- repokernel:end -->');
  });
});

describe('runInstallSkillIdeCommand — cursor', () => {
  it('creates the file when it does not exist', async () => {
    const skillSourceDir = await makeSkillSource('# RepoKernel\nbody content\n');
    const result = await runInstallSkillIdeCommand({
      ide: 'cursor',
      project: true,
      cwd: join(workspace, 'cursor', '..'),
      skillSourceDir,
      dryRun: false,
      force: false,
    });

    expect(result.exitCode).toBe(0);
    const correctPath = resolveIdePath('cursor', true, workspace);
    const content = await readFile(correctPath, 'utf8').catch(() => null);
    expect(content).not.toBeNull();
    expect(content).toContain('alwaysApply: false');
    expect(content).toContain('body content');
  });

  it('dry-run prints path and writes nothing', async () => {
    const skillSourceDir = await makeSkillSource();
    const result = await runInstallSkillIdeCommand({
      ide: 'cursor',
      project: true,
      cwd: workspace,
      skillSourceDir,
      dryRun: true,
      force: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Would write:');
  });

  it('returns error for unknown ide', async () => {
    const skillSourceDir = await makeSkillSource();
    const result = await runInstallSkillIdeCommand({
      ide: 'unknown' as never,
      project: false,
      cwd: workspace,
      skillSourceDir,
      dryRun: false,
      force: false,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('unknown --ide value');
  });

  it('returns error without --force when file already exists and differs', async () => {
    const skillSourceDir = await makeSkillSource();
    const outputPath = resolveIdePath('cursor', true, workspace);
    await mkdir(join(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, 'different content', 'utf8');

    const result = await runInstallSkillIdeCommand({
      ide: 'cursor',
      project: true,
      cwd: workspace,
      skillSourceDir,
      dryRun: false,
      force: false,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--force');
  });

  it('overwrites with --force', async () => {
    const skillSourceDir = await makeSkillSource('# new body\n');
    const outputPath = resolveIdePath('cursor', true, workspace);
    await mkdir(join(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, 'old content', 'utf8');

    const result = await runInstallSkillIdeCommand({
      ide: 'cursor',
      project: true,
      cwd: workspace,
      skillSourceDir,
      dryRun: false,
      force: true,
    });
    expect(result.exitCode).toBe(0);
    const content = await readFile(outputPath, 'utf8');
    expect(content).toContain('new body');
  });
});

describe('runInstallSkillIdeCommand — copilot marker idempotency', () => {
  it('appends markers to existing file', async () => {
    const skillSourceDir = await makeSkillSource('# RK\nbody\n');
    const outputPath = resolveIdePath('copilot', true, workspace);
    await mkdir(join(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, '# My existing copilot instructions\n\nsome content\n', 'utf8');

    const result = await runInstallSkillIdeCommand({
      ide: 'copilot',
      project: true,
      cwd: workspace,
      skillSourceDir,
      dryRun: false,
      force: false,
    });
    expect(result.exitCode).toBe(0);
    const content = await readFile(outputPath, 'utf8');
    expect(content).toContain('My existing copilot instructions');
    expect(content).toContain('<!-- repokernel:start -->');
    expect(content).toContain('<!-- repokernel:end -->');
  });

  it('replaces markers on second run (idempotent)', async () => {
    const skillSourceDir = await makeSkillSource('# RK\nbody v1\n');
    const outputPath = resolveIdePath('copilot', true, workspace);
    await mkdir(join(outputPath, '..'), { recursive: true });

    await runInstallSkillIdeCommand({
      ide: 'copilot',
      project: true,
      cwd: workspace,
      skillSourceDir,
      dryRun: false,
      force: false,
    });

    const skillSourceDir2 = await makeSkillSource('# RK\nbody v2\n');
    await runInstallSkillIdeCommand({
      ide: 'copilot',
      project: true,
      cwd: workspace,
      skillSourceDir: skillSourceDir2,
      dryRun: false,
      force: false,
    });

    const content = await readFile(outputPath, 'utf8');
    expect(content).not.toContain('body v1');
    expect(content).toContain('body v2');
    expect((content.match(/<!-- repokernel:start -->/g) ?? []).length).toBe(1);
  });
});

describe('runInstallSkillIdeCommand — frontmatter stripping', () => {
  it('strips YAML frontmatter from SKILL.md before embedding', async () => {
    const skillSourceDir = await makeSkillSource(
      '---\nname: test\nversion: 1.0.0\n---\n\n# Heading\nbody\n',
    );
    const result = await runInstallSkillIdeCommand({
      ide: 'windsurf',
      project: true,
      cwd: workspace,
      skillSourceDir,
      dryRun: false,
      force: false,
    });
    expect(result.exitCode).toBe(0);
    const outputPath = resolveIdePath('windsurf', true, workspace);
    const content = await readFile(outputPath, 'utf8');
    expect(content).not.toContain('name: test');
    expect(content).toContain('# Heading');
    expect(content).toContain('body');
  });
});
