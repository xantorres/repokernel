import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTaskFileInput, runFastpathTask } from '../src/commands/fastpath/runTask.js';
import { synthesizeTaskState } from '../src/commands/fastpath/synthesize.js';
import { defaultConfigYaml } from './helpers/fixture.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-rt-'));
  tracked.push(dir);
  await writeFile(join(dir, 'repokernel.config.yaml'), defaultConfigYaml(), 'utf8');
  return dir;
}

describe('runFastpathTask early branches', () => {
  it('returns a runtime error when the inline body is empty (whitespace only)', async () => {
    const cwd = await project();
    const r = await runFastpathTask({ cwd, inlineMessage: '   \n  \n' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('task message (-m) is empty');
  });

  it('rejects mutually exclusive sources (-m and a file path)', async () => {
    const cwd = await project();
    const taskFile = join(cwd, 'task.md');
    await writeFile(taskFile, 'body', 'utf8');
    const r = await runFastpathTask({
      cwd,
      inlineMessage: 'inline',
      filePath: taskFile,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('mutually exclusive');
  });

  it('throws (propagates RepoKernelError) when no config is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-rt-noconfig-'));
    tracked.push(dir);
    await expect(runFastpathTask({ cwd: dir, inlineMessage: 'do thing' })).rejects.toThrow(
      /repokernel\.config\.yaml not found/,
    );
  });

  it('emits a dry-run preview without writing anything when --dry-run is set', async () => {
    const cwd = await project();
    const r = await runFastpathTask({
      cwd,
      inlineMessage: 'Add /health endpoint',
      dryRun: true,
      mode: 'assisted',
      agent: 'fake',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dry-run');
    expect(r.stdout).toContain('Add /health endpoint');
    expect(r.stdout).toContain('Source:  inline');
    expect(r.stdout).toContain('Mode:    assisted');
    expect(r.stdout).toContain('Agent:   fake');
    expect(r.stdout).toContain('Worktree: yes');
  });

  it('renders Worktree: no when --no-worktree dry-runs', async () => {
    const cwd = await project();
    const r = await runFastpathTask({
      cwd,
      inlineMessage: 'thing',
      dryRun: true,
      noWorktree: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Worktree: no');
  });

  it('truncates the preview line to 80 chars', async () => {
    const cwd = await project();
    const longBody = 'X'.repeat(200);
    const r = await runFastpathTask({ cwd, inlineMessage: longBody, dryRun: true });
    expect(r.exitCode).toBe(0);
    const previewLine = r.stdout.split('\n').find((l) => l.includes('Preview:'));
    expect(previewLine).toBeDefined();
    if (previewLine) {
      const previewBody = previewLine.split('Preview:')[1] ?? '';
      expect(previewBody.trim().length).toBeLessThanOrEqual(80);
    }
  });

  it('reads body from a file when filePath is set and the file exists', async () => {
    const cwd = await project();
    const taskFile = join(cwd, 'task.md');
    await writeFile(taskFile, 'Implement /metrics endpoint\n', 'utf8');
    const r = await runFastpathTask({
      cwd,
      filePath: taskFile,
      dryRun: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Implement /metrics endpoint');
    expect(r.stdout).toContain('Source:  file');
  });

  it('parses task-file frontmatter into acceptance criteria and path policy', async () => {
    const parsed = parseTaskFileInput(
      `---
ac:
  - Returns 200 OK
allow:
  - src/api/**
deny:
  - src/legacy/**
constraints:
  - docs/private/**
---
Implement safe fastpath policy.
`,
      'file',
    );
    expect(parsed).toMatchObject({
      body: 'Implement safe fastpath policy.',
      acceptanceCriteria: ['Returns 200 OK'],
      constraints: ['docs/private/**'],
      allowedPaths: ['src/api/**'],
      deniedPaths: ['src/legacy/**'],
      source: 'file',
    });

    const cwd = await project();
    const cfg = await loadConfig({ cwd });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;

    const result = await synthesizeTaskState(cwd, cfg.config, parsed!);

    const sprint = await readFile(result.sprintFile, 'utf8');
    expect(sprint).toContain('allowed_paths:\n  - "src/api/**"');
    expect(sprint).toContain('denied_paths:\n  - "src/legacy/**"\n  - "docs/private/**"');
    expect(sprint).toContain('- [ ] Returns 200 OK');
  });

  it('returns runtime error when filePath does not exist', async () => {
    const cwd = await project();
    const r = await runFastpathTask({
      cwd,
      filePath: join(cwd, 'does-not-exist.md'),
      dryRun: true,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
