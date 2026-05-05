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

/**
 * Outcome of a write-side bridge call (comment / transition / link). The
 * envelope is shared across providers so the dispatch layer never has to
 * know which adapter was invoked. Implementations that don't support an
 * operation either omit the optional method entirely (and the dispatch
 * surfaces `not_implemented`) or return `{ ok: false, reason }` with a
 * descriptive code.
 */
export type TrackerWriteOutcome =
  | { readonly ok: true; readonly detail?: string }
  | { readonly ok: false; readonly reason: string };

export interface TrackerAdapter {
  readonly name: TrackerSource;
  fetch(ref: string): Promise<TrackerTicket | null>;
  /**
   * Optional write methods. Adapters declare capability by defining the
   * method; callers test capability via `typeof adapter.comment ===
   * 'function'` rather than maintaining a separate registry.
   */
  comment?(ref: string, body: string): Promise<TrackerWriteOutcome>;
  transition?(ref: string, state: string): Promise<TrackerWriteOutcome>;
  linkPr?(ref: string, prUrl: string): Promise<TrackerWriteOutcome>;
}

export interface TrackerRef {
  readonly source: TrackerSource;
  readonly ref: string;
}
