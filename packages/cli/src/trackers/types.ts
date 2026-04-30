/**
 * Tracker bridge — read-only ingest of external tracker tickets into
 * RepoKernel epic frontmatter.
 *
 * v1.13 surface: `rk create epic --from-tracker <source>:<ref>`.
 *
 * Adapter contract: never throws on network / auth / 404 failure. Returns
 * `null` so the caller can degrade gracefully and fall through to plain
 * epic creation with a stderr warning. This keeps offline workflows and
 * CI systems with no tracker creds usable without environment-specific
 * branching.
 */

export type TrackerSource = 'jira' | 'linear' | 'gh';

export interface TrackerTicket {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  readonly url: string;
}

export interface TrackerAdapter {
  readonly name: TrackerSource;
  fetch(ref: string): Promise<TrackerTicket | null>;
}

export interface TrackerRef {
  readonly source: TrackerSource;
  readonly ref: string;
}
