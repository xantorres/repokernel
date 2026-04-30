import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jiraAdapter } from '../../src/trackers/jira.js';

const ENV_KEYS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] as const;

describe('jiraAdapter.fetch', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const stderrLines: string[] = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    stderrLines.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation(((data: unknown) => {
      stderrLines.push(typeof data === 'string' ? data : String(data));
      return true;
    }) as never);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    vi.restoreAllMocks();
  });

  it('returns null and warns when credentials are unset', async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;

    const result = await jiraAdapter.fetch('KEY-1');
    expect(result).toBeNull();
    expect(stderrLines.length).toBeGreaterThan(0);
    expect(stderrLines.join('')).toMatch(/credentials not set/);
  });

  it('parses a 200 response into a TrackerTicket', async () => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_API_TOKEN = 'token';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          key: 'KEY-1',
          fields: {
            summary: 'Add login button',
            description: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Users need to log in.' }],
                },
              ],
            },
            labels: ['frontend', 'auth'],
            assignee: { displayName: 'Jane Doe' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await jiraAdapter.fetch('KEY-1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('KEY-1');
    expect(result?.title).toBe('Add login button');
    expect(result?.description).toContain('Users need to log in');
    expect(result?.labels).toEqual(['frontend', 'auth']);
    expect(result?.assignee).toBe('Jane Doe');
    expect(result?.url).toBe('https://acme.atlassian.net/browse/KEY-1');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns null and warns on 401', async () => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_API_TOKEN = 'token';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const result = await jiraAdapter.fetch('KEY-1');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/401/);
  });

  it('returns null and warns on 404', async () => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_API_TOKEN = 'token';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

    const result = await jiraAdapter.fetch('KEY-999');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/404/);
  });

  it('returns null and warns on network error', async () => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_API_TOKEN = 'token';

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await jiraAdapter.fetch('KEY-1');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/network error/);
  });

  it('returns null on malformed response missing fields', async () => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_API_TOKEN = 'token';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const result = await jiraAdapter.fetch('KEY-1');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/missing fields/);
  });

  it('handles missing assignee gracefully', async () => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_API_TOKEN = 'token';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          key: 'KEY-2',
          fields: {
            summary: 'Untriaged',
            assignee: null,
            labels: [],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await jiraAdapter.fetch('KEY-2');
    expect(result?.assignee).toBeNull();
    expect(result?.labels).toEqual([]);
  });
});
