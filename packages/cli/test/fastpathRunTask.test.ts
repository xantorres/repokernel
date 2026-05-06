import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@repokernel/core';
import matter from 'gray-matter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTaskFileInput, runFastpathTask } from '../src/commands/fastpath/runTask.js';
import { synthesizeTaskState } from '../src/commands/fastpath/synthesize.js';
import { defaultConfigYaml } from './helpers/fixture.js';

const tracked: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LINEAR_API_KEY;
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

  it('seeds a dry-run fastpath task from tracker without writing files', async () => {
    process.env.LINEAR_API_KEY = 'lin_xxx';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: 'ABC-1',
              title: 'Ship health endpoint',
              description: 'Return build version.',
              url: 'https://linear.app/acme/issue/ABC-1',
              labels: { nodes: [{ name: 'backend' }] },
              assignee: { name: 'Alex' },
            },
          },
        }),
        { status: 200 },
      ),
    );
    const cwd = await project();

    const r = await runFastpathTask({
      cwd,
      fromTracker: 'linear:ABC-1',
      dryRun: true,
      agent: 'fake',
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Ship health endpoint');
    expect(r.stdout).toContain('Source:  tracker');
    await expect(readFile(join(cwd, 'epics/E-001.md'), 'utf8')).rejects.toThrow();
  });

  it('does not allocate ids when tracker fetch fails closed', async () => {
    delete process.env.LINEAR_API_KEY;
    const cwd = await project();

    const failed = await runFastpathTask({ cwd, fromTracker: 'linear:ABC-1' });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain('--allow-tracker-fallback');

    const cfg = await loadConfig({ cwd });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    const plain = await synthesizeTaskState(cwd, cfg.config, {
      body: 'plain task',
      acceptanceCriteria: [],
      constraints: [],
      source: 'inline',
    });
    expect(plain.epicId).toBe('E-001');
    expect(plain.sprintId).toBe('S-001');
    expect(plain.taskId).toBe('T-001');
  });

  it('stores tracker metadata on synthesized epic and alias', async () => {
    const cwd = await project();
    const cfg = await loadConfig({ cwd });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;

    const result = await synthesizeTaskState(cwd, cfg.config, {
      body: 'Ship health endpoint',
      acceptanceCriteria: [],
      constraints: [],
      source: 'tracker',
      tracker: {
        source: 'gh',
        ref: 'owner/repo#42',
        id: 'owner/repo#42',
        url: 'https://github.com/owner/repo/issues/42',
        labels: ['backend'],
        assignee: 'Alex',
      },
    });

    const epic = matter(await readFile(result.epicFile, 'utf8')).data as {
      extras: Record<string, unknown>;
    };
    expect(epic.extras.tracker_source).toBe('gh');
    expect(epic.extras.tracker_url).toBe('https://github.com/owner/repo/issues/42');

    const alias = JSON.parse(await readFile(result.aliasFile, 'utf8')) as {
      tracker?: Record<string, unknown>;
    };
    expect(alias.tracker?.source).toBe('gh');
    expect(alias.tracker?.ref).toBe('owner/repo#42');
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
