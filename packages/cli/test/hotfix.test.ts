import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { runHotfixCommand } from '../src/commands/hotfix.js';
import { cleanupAllFixtures, defaultConfigYaml, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(): Promise<string> {
  return makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }]);
}

describe('runHotfixCommand', () => {
  it('rejects empty description', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: '   ',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('<description> is required');
  });

  it('creates a T-NNN fastpath task with [hotfix] prefix in body', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'Patch broken auth middleware',
      acceptanceCriteria: ['Middleware allows valid tokens'],
      denyPaths: ['src/legacy/**'],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      taskId: string;
      sprintFile: string;
      epicFile: string;
      kind: string;
    };
    expect(obj.kind).toBe('hotfix');
    expect(obj.taskId).toMatch(/^T-\d+$/);
    const sprintBody = await readFile(obj.sprintFile, 'utf8');
    expect(sprintBody).toContain('[hotfix]');
    expect(sprintBody).toContain('Patch broken auth middleware');
  });

  it('emits commit hint with the T-NNN id in non-JSON output', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'CI timing fix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/T-\d+/);
    expect(r.stdout).toContain('git commit');
    expect(r.stdout).toContain('rk close');
  });

  it('synthesized sprint has review_required: false so rk close T-NNN works without review', async () => {
    const cwd = await project();
    const matter = (await import('gray-matter')).default;
    const r = await runHotfixCommand({
      cwd,
      description: 'No-review hotfix',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { sprintFile: string };
    const data = matter(await readFile(obj.sprintFile, 'utf8')).data;
    expect(data.review_required).toBe(false);
  });

  it('shell hint escapes double-quote characters in description', async () => {
    const cwd = await project();
    const r = await runHotfixCommand({
      cwd,
      description: 'Fix "broken" auth',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('\\"broken\\"');
  });

  it('returns runtime error when no config found', async () => {
    const cwd = await makeFixture([]); // no repokernel.config.yaml
    const r = await runHotfixCommand({
      cwd,
      description: 'fix something',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not found');
  });

  it('returns runtime error when config YAML is malformed', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: 'invalid: yaml: ][' },
    ]);
    const r = await runHotfixCommand({
      cwd,
      description: 'fix something',
      acceptanceCriteria: [],
      denyPaths: [],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid');
  });

  it('two consecutive hotfixes yield distinct T-NNN ids', async () => {
    const cwd = await project();
    const r1 = await runHotfixCommand({
      cwd,
      description: 'first',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    const r2 = await runHotfixCommand({
      cwd,
      description: 'second',
      acceptanceCriteria: [],
      denyPaths: [],
      json: true,
    });
    const o1 = JSON.parse(r1.stdout) as { taskId: string };
    const o2 = JSON.parse(r2.stdout) as { taskId: string };
    expect(o1.taskId).not.toBe(o2.taskId);
  });
});
