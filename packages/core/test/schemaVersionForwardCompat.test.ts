import { describe, expect, it } from 'vitest';
import type { ZodIssue } from 'zod';
import {
  buildGraph,
  type Config,
  ConfigSchema,
  generateRegistry,
  type ParsedProject,
  REGISTRY_SCHEMA_VERSION,
  RegistrySchema,
} from '../src/index.js';
import { TeamStatusSchema } from '../src/schemas/run.js';

/**
 * Forward-compat contract: a state file written by a NEWER rk (a schemaVersion
 * the running binary does not support) must be rejected at the schema boundary,
 * surfacing a structured issue that names `schemaVersion` — never silently
 * accepted, and never an unguarded throw the caller can't classify.
 */

const CONFIG: Config = ConfigSchema.parse({
  schemaVersion: 1,
  projectId: 'demo',
  projectName: 'Demo',
  paths: {
    epics: 'epics',
    sprints: 'sprints',
    reviews: 'reviews',
    queues: 'queues',
    lanes: 'lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  },
});

const EMPTY_PROJECT: ParsedProject = {
  sprints: [],
  epics: [],
  reviews: [],
  queues: [],
  lanes: [],
  nextMd: null,
  findings: [],
};

/** True if any issue (including nested union branches) targets `schemaVersion`. */
function flagsSchemaVersion(issues: readonly ZodIssue[]): boolean {
  return issues.some((issue) => {
    if (issue.path.includes('schemaVersion')) return true;
    if (issue.code === 'invalid_union') {
      return issue.unionErrors.some((err) => flagsSchemaVersion(err.issues));
    }
    return false;
  });
}

describe('schema-version forward compatibility', () => {
  it('rejects a registry written by a newer rk, isolating schemaVersion as the cause', () => {
    const reg = generateRegistry({
      graph: buildGraph(EMPTY_PROJECT),
      config: CONFIG,
      findings: [],
      now: () => '2026-04-25T10:00:00.000Z',
    });

    // The fixture is otherwise valid at the supported version.
    expect(RegistrySchema.safeParse(reg).success).toBe(true);

    const fromFuture = { ...reg, schemaVersion: REGISTRY_SCHEMA_VERSION + 1 };
    const result = RegistrySchema.safeParse(fromFuture);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(flagsSchemaVersion(result.error.issues)).toBe(true);
  });

  it('rejects a team-status capture written by a newer rk', () => {
    const v2 = {
      schemaVersion: 2,
      timestamp: '2026-04-30T12:00:00.000Z',
      runs: [],
      sprints: [],
      registry: { files_changed: 0, conflicts: 0, ready_to_merge: true, health: 'OK' },
      operational: {
        live_claims: [],
        corrupt_run_files: [],
        leaked_worktrees: [],
        active_worktree_count: 0,
        collection_errors: [],
      },
      bottlenecks: [],
    };

    expect(TeamStatusSchema.safeParse(v2).success).toBe(true);

    const result = TeamStatusSchema.safeParse({ ...v2, schemaVersion: 3 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(flagsSchemaVersion(result.error.issues)).toBe(true);
  });
});
