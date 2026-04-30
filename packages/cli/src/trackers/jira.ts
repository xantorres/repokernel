import type { TrackerAdapter, TrackerTicket } from './types.js';

const FETCH_TIMEOUT_MS = 5000;

/**
 * Convert ADF (Atlassian Document Format) into plain text. JIRA Cloud REST v3
 * returns description as ADF, not raw markdown. We don't need fidelity here —
 * the description goes into a markdown body where the user can edit. Good
 * enough: walk text leaves and join paragraphs with blank lines.
 */
function adfToPlainText(adf: unknown): string {
  if (adf === null || adf === undefined) return '';
  if (typeof adf === 'string') return adf;
  if (typeof adf !== 'object') return '';
  const node = adf as { type?: string; text?: string; content?: unknown[] };

  if (typeof node.text === 'string') return node.text;

  if (Array.isArray(node.content)) {
    const parts = node.content.map((c) => adfToPlainText(c));
    if (node.type === 'paragraph' || node.type === 'heading') {
      return `${parts.join('')}\n\n`;
    }
    return parts.join('');
  }
  return '';
}

interface JiraIssueResponse {
  readonly key?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly description?: unknown;
    readonly labels?: readonly string[];
    readonly assignee?: { readonly displayName?: string; readonly emailAddress?: string } | null;
  };
}

function isLocalJiraHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]' ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

function parseJiraBaseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    if (url.hostname.length === 0 || isLocalJiraHost(url.hostname)) return null;
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

function jiraUrl(base: URL, suffix: string): string {
  const url = new URL(base.toString());
  const prefix = url.pathname === '/' ? '' : url.pathname;
  url.pathname = `${prefix}${suffix}`;
  return url.toString();
}

/**
 * JIRA Cloud REST v3 adapter. Reads `JIRA_BASE_URL`, `JIRA_EMAIL`, and
 * `JIRA_API_TOKEN` from the parent CLI process env. Uses Node 20 native
 * `fetch`. Returns `null` on any error so callers degrade gracefully.
 *
 * Security: tokens are read once into a Basic auth header and never echoed
 * to stdout/stderr/JSON output. The adapter does not pass env to spawned
 * subprocesses.
 */
export const jiraAdapter: TrackerAdapter = {
  name: 'jira',
  async fetch(ref: string): Promise<TrackerTicket | null> {
    const baseUrl = process.env.JIRA_BASE_URL?.trim();
    const email = process.env.JIRA_EMAIL?.trim();
    const token = process.env.JIRA_API_TOKEN?.trim();

    if (!baseUrl || !email || !token) {
      process.stderr.write(
        'tracker: jira credentials not set — set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (falling through to plain create)\n',
      );
      return null;
    }

    const parsedBaseUrl = parseJiraBaseUrl(baseUrl);
    if (parsedBaseUrl === null) {
      process.stderr.write(
        'tracker: jira invalid JIRA_BASE_URL — use an https URL without credentials or localhost/private hosts (falling through to plain create)\n',
      );
      return null;
    }

    const auth = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
    const url = jiraUrl(parsedBaseUrl, `/rest/api/3/issue/${encodeURIComponent(ref)}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        process.stderr.write(
          `tracker: jira fetch returned ${res.status} for ${ref} (falling through to plain create)\n`,
        );
        return null;
      }

      const data = (await res.json()) as JiraIssueResponse;
      const fields = data.fields;
      if (!fields || typeof fields.summary !== 'string') {
        process.stderr.write(
          `tracker: jira response missing fields for ${ref} (falling through to plain create)\n`,
        );
        return null;
      }

      return {
        id: data.key ?? ref,
        title: fields.summary,
        description: adfToPlainText(fields.description).trim(),
        labels: fields.labels ?? [],
        assignee: fields.assignee?.displayName ?? fields.assignee?.emailAddress ?? null,
        url: jiraUrl(parsedBaseUrl, `/browse/${data.key ?? ref}`),
      };
    } catch (cause) {
      const reason = (cause as Error).name === 'AbortError' ? 'timeout' : 'network error';
      process.stderr.write(
        `tracker: jira ${reason} fetching ${ref} (falling through to plain create)\n`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  },
};
