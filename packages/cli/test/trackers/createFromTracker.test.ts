import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCreateEpicCommand } from '../../src/commands/create.js';
import { cleanupAllFixtures, defaultConfigYaml, makeFixture } from '../helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(): Promise<string> {
  return makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }]);
}

async function readEpicFrontmatter(
  cwd: string,
  id: string,
): Promise<{ data: Record<string, unknown>; body: string }> {
  const raw = await readFile(join(cwd, 'epics', `${id}.md`), 'utf8');
  const parsed = matter(raw);
  return { data: parsed.data as Record<string, unknown>, body: parsed.content };
}

describe('rk create epic --from-tracker', () => {
  const stderrLines: string[] = [];

  beforeEach(() => {
    stderrLines.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation(((data: unknown) => {
      stderrLines.push(typeof data === 'string' ? data : String(data));
      return true;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LINEAR_API_KEY;
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  });

  it('writes extras.tracker_* and uses ticket title when bridge succeeds (linear)', async () => {
    process.env.LINEAR_API_KEY = 'lin_xxx';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: 'ABC-1',
              title: 'Refactor checkout from tracker',
              description: 'Body from tracker',
              url: 'https://linear.app/acme/issue/ABC-1',
              labels: { nodes: [{ name: 'p1' }] },
              assignee: { name: 'Alex' },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const cwd = await project();
    const result = await runCreateEpicCommand('user provided fallback title', {
      cwd,
      fromTracker: 'linear:ABC-1',
    });

    expect(result.exitCode).toBe(0);

    const { data, body } = await readEpicFrontmatter(cwd, 'E-001');
    expect(data.title).toBe('Refactor checkout from tracker');
    const extras = data.extras as Record<string, unknown>;
    expect(extras).toBeDefined();
    expect(extras.external_id).toBe('ABC-1');
    expect(extras.tracker_source).toBe('linear');
    expect(extras.tracker_url).toBe('https://linear.app/acme/issue/ABC-1');
    expect(extras.tracker_labels).toEqual(['p1']);
    expect(extras.tracker_assignee).toBe('Alex');
    expect(body).toContain('Body from tracker');
  });

  it('falls through to plain create when tracker returns null (offline)', async () => {
    delete process.env.LINEAR_API_KEY;

    const cwd = await project();
    const result = await runCreateEpicCommand('plain title', {
      cwd,
      fromTracker: 'linear:ABC-1',
    });

    expect(result.exitCode).toBe(0);
    const { data, body } = await readEpicFrontmatter(cwd, 'E-001');
    expect(data.title).toBe('plain title');
    expect(data.extras).toBeUndefined();
    expect(body).not.toContain('Body from tracker');
    expect(stderrLines.join('')).toMatch(/credentials not set/);
  });

  it('falls through to plain create on 404', async () => {
    process.env.LINEAR_API_KEY = 'lin_xxx';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'Issue not found' }] }), { status: 200 }),
    );

    const cwd = await project();
    const result = await runCreateEpicCommand('fallback title', {
      cwd,
      fromTracker: 'linear:ABC-999',
    });

    expect(result.exitCode).toBe(0);
    const { data } = await readEpicFrontmatter(cwd, 'E-001');
    expect(data.title).toBe('fallback title');
    expect(data.extras).toBeUndefined();
  });

  it('exits with EXIT_USAGE on malformed --from-tracker value', async () => {
    const cwd = await project();
    const result = await runCreateEpicCommand('any', {
      cwd,
      fromTracker: 'asana:TASK-1',
    });

    expect(result.exitCode).toBe(64);
    expect(result.stderr).toMatch(/jira, linear, gh/);
  });

  it('does not advance counter when bridge fails', async () => {
    delete process.env.LINEAR_API_KEY;

    const cwd = await project();

    // First create — bridge fails, plain create gets E-001
    const r1 = await runCreateEpicCommand('first', { cwd, fromTracker: 'linear:ABC-1' });
    expect(r1.exitCode).toBe(0);

    // Second create — counter advances normally (bridge fail does not skip an ID)
    const r2 = await runCreateEpicCommand('second', { cwd });
    expect(r2.exitCode).toBe(0);
    const { data } = await readEpicFrontmatter(cwd, 'E-002');
    expect(data.title).toBe('second');
  });

  it('preserves existing behavior when --from-tracker is omitted', async () => {
    const cwd = await project();
    const result = await runCreateEpicCommand('plain', { cwd });
    expect(result.exitCode).toBe(0);
    const { data } = await readEpicFrontmatter(cwd, 'E-001');
    expect(data.title).toBe('plain');
    expect(data.extras).toBeUndefined();
  });
});
