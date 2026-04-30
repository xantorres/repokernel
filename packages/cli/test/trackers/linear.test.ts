import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linearAdapter } from '../../src/trackers/linear.js';

describe('linearAdapter.fetch', () => {
  let originalKey: string | undefined;
  const stderrLines: string[] = [];

  beforeEach(() => {
    originalKey = process.env.LINEAR_API_KEY;
    stderrLines.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation(((data: unknown) => {
      stderrLines.push(typeof data === 'string' ? data : String(data));
      return true;
    }) as never);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('returns null when LINEAR_API_KEY is unset', async () => {
    delete process.env.LINEAR_API_KEY;
    const result = await linearAdapter.fetch('ABC-1');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/credentials not set/);
  });

  it('parses a 200 GraphQL response', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_xxx';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: 'ABC-1',
              title: 'Refactor checkout',
              description: 'Long body here.',
              url: 'https://linear.app/acme/issue/ABC-1',
              labels: { nodes: [{ name: 'Bug' }, { name: 'P1' }] },
              assignee: { name: 'Alex' },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await linearAdapter.fetch('ABC-1');
    expect(result?.id).toBe('ABC-1');
    expect(result?.title).toBe('Refactor checkout');
    expect(result?.description).toBe('Long body here.');
    expect(result?.labels).toEqual(['Bug', 'P1']);
    expect(result?.assignee).toBe('Alex');
    expect(result?.url).toBe('https://linear.app/acme/issue/ABC-1');
  });

  it('returns null on graphql errors block', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_xxx';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'Issue not found' }] }), { status: 200 }),
    );

    const result = await linearAdapter.fetch('ABC-999');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/graphql error/);
  });

  it('returns null on 401', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_bad';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const result = await linearAdapter.fetch('ABC-1');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_xxx';

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    const result = await linearAdapter.fetch('ABC-1');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/network error/);
  });

  it('handles missing assignee + empty labels', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_xxx';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: 'ABC-2',
              title: 'Untriaged',
              description: null,
              url: 'https://linear.app/acme/issue/ABC-2',
              labels: { nodes: [] },
              assignee: null,
            },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await linearAdapter.fetch('ABC-2');
    expect(result?.assignee).toBeNull();
    expect(result?.labels).toEqual([]);
    expect(result?.description).toBe('');
  });
});
