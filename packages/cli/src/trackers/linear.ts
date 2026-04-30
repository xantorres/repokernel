import type { TrackerAdapter, TrackerTicket } from './types.js';

const FETCH_TIMEOUT_MS = 5000;
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    labels {
      nodes { name }
    }
    assignee { name email }
  }
}`;

interface LinearGraphQLResponse {
  readonly data?: {
    readonly issue?: {
      readonly identifier?: string;
      readonly title?: string;
      readonly description?: string | null;
      readonly url?: string;
      readonly labels?: { readonly nodes?: ReadonlyArray<{ readonly name?: string }> };
      readonly assignee?: { readonly name?: string; readonly email?: string } | null;
    };
  };
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}

/**
 * Linear adapter. Reads `LINEAR_API_KEY` from env. Uses Node 20 native
 * `fetch` against the Linear GraphQL endpoint. Returns `null` on any error.
 *
 * Schema-change resilience: GraphQL responses are typed loosely; missing
 * fields fall back to safe defaults rather than throwing. If Linear renames
 * a field the adapter reports `null` and falls through to plain create.
 */
export const linearAdapter: TrackerAdapter = {
  name: 'linear',
  async fetch(ref: string): Promise<TrackerTicket | null> {
    const apiKey = process.env.LINEAR_API_KEY?.trim();

    if (!apiKey) {
      process.stderr.write(
        'tracker: linear credentials not set — set LINEAR_API_KEY (falling through to plain create)\n',
      );
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: ISSUE_QUERY, variables: { id: ref } }),
        signal: controller.signal,
      });

      if (!res.ok) {
        process.stderr.write(
          `tracker: linear fetch returned ${res.status} for ${ref} (falling through to plain create)\n`,
        );
        return null;
      }

      const data = (await res.json()) as LinearGraphQLResponse;

      if (data.errors !== undefined && data.errors.length > 0) {
        const first = data.errors[0]?.message ?? 'unknown error';
        process.stderr.write(
          `tracker: linear graphql error for ${ref}: ${first} (falling through to plain create)\n`,
        );
        return null;
      }

      const issue = data.data?.issue;
      if (!issue || typeof issue.title !== 'string') {
        process.stderr.write(
          `tracker: linear response missing issue ${ref} (falling through to plain create)\n`,
        );
        return null;
      }

      const labels: string[] = (issue.labels?.nodes ?? [])
        .map((n) => n?.name)
        .filter((name): name is string => typeof name === 'string');

      return {
        id: issue.identifier ?? ref,
        title: issue.title,
        description: (issue.description ?? '').trim(),
        labels,
        assignee: issue.assignee?.name ?? issue.assignee?.email ?? null,
        url: issue.url ?? '',
      };
    } catch (cause) {
      const reason = (cause as Error).name === 'AbortError' ? 'timeout' : 'network error';
      process.stderr.write(
        `tracker: linear ${reason} fetching ${ref} (falling through to plain create)\n`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  },
};
