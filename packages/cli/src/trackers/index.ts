import { ghAdapter } from './gh.js';
import { jiraAdapter } from './jira.js';
import { linearAdapter } from './linear.js';
import type { TrackerAdapter, TrackerSource } from './types.js';

export { parseTrackerRef } from './parseRef.js';
export type { TrackerAdapter, TrackerRef, TrackerSource, TrackerTicket } from './types.js';

const ADAPTERS: Readonly<Record<TrackerSource, TrackerAdapter>> = {
  jira: jiraAdapter,
  linear: linearAdapter,
  gh: ghAdapter,
};

/**
 * Resolve a tracker adapter by source name. Mirrors the agent registry
 * shape at `agents/index.ts` — single point of dispatch for the bridge.
 *
 * Adapter registration is static here in v1.13. Future versions may add
 * config-driven custom adapters (mirror `agents.<name>` config block).
 */
export function getTrackerAdapter(source: TrackerSource): TrackerAdapter {
  return ADAPTERS[source];
}
