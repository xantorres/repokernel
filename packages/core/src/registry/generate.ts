import type { Config } from '../config/schema.js';
import type { Graph } from '../graph/types.js';
import { resolveNextRunnableSprint } from '../resolver/nextRunnable.js';
import { type Finding, meetsThreshold, SEVERITY_RANK, type Severity } from '../schemas/finding.js';
import {
  REGISTRY_SCHEMA_VERSION,
  type Registry,
  type RegistryEpic,
  type RegistryLane,
  type RegistryNext,
  type RegistryReview,
  type RegistrySprint,
} from '../schemas/registry.js';

export const REGISTRY_GENERATED_BY = 'repokernel@1.0.0';

export interface GenerateRegistryInput {
  readonly graph: Graph;
  readonly config: Config;
  readonly findings: readonly Finding[];
  readonly now?: () => string;
}

export function generateRegistry(input: GenerateRegistryInput): Registry {
  const { graph, config, findings } = input;
  const generatedAt = (input.now ?? defaultNow)();

  const sprints: RegistrySprint[] = [...graph.sprints.values()]
    .map<RegistrySprint>((s) => ({
      id: s.id,
      title: s.title,
      epic_id: s.epic_id,
      status: s.status,
      lane: s.lane,
      gate: s.gate ?? null,
      depends_on: [...s.depends_on],
      review_id: s.review_id ?? null,
      started_at: s.started_at ?? null,
      closed_at: s.closed_at ?? null,
      base_sha: s.base_sha ?? null,
      end_sha: s.end_sha ?? null,
      file: s.file,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const epics: RegistryEpic[] = [...graph.epics.values()]
    .map<RegistryEpic>((e) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      gate: e.gate ?? null,
      adr_links: [...e.adr_links],
      sprints: [...(graph.sprintsByEpic.get(e.id) ?? [])],
      ...(e.execution_strategy !== undefined ? { execution_strategy: e.execution_strategy } : {}),
      ...(e.parallel_limit !== undefined ? { parallel_limit: e.parallel_limit } : {}),
      file: e.file,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const reviews: RegistryReview[] = [...graph.reviews.values()]
    .map<RegistryReview>((r) => ({
      id: r.id,
      sprint_id: r.sprint_id,
      verdict: r.verdict,
      reviewer: r.reviewer,
      base_sha: r.base_sha ?? null,
      end_sha: r.end_sha ?? null,
      file: r.file,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const queue: Record<string, Registry['queue'][string]> = {};
  for (const [lane, slots] of [...graph.queuesByLane.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    queue[lane] = [...slots];
  }

  const lanes: RegistryLane[] = [...graph.lanes.values()]
    .map<RegistryLane>((l) => ({
      name: l.name,
      claimed_by: l.claimed_by ?? null,
      claimed_at: l.claimed_at ?? null,
      inferred: l.inferred,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const laneNames = [...graph.lanes.keys()].sort();
  const next: RegistryNext[] = laneNames.map((lane) => {
    const r = resolveNextRunnableSprint(graph, config, findings, { lane });
    return {
      lane: r.lane,
      result: r.result,
      sprint_id: r.sprintId,
      blockers: [...r.blockers],
    };
  });

  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity]++;
  let maxSeverity: Severity | null = null;
  for (const f of findings) {
    if (maxSeverity === null || SEVERITY_RANK[f.severity] < SEVERITY_RANK[maxSeverity]) {
      maxSeverity = f.severity;
    }
  }
  const blocked = findings.some((f) =>
    meetsThreshold(f.severity, config.policies.severityFailThreshold),
  );

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedBy: REGISTRY_GENERATED_BY,
    generatedAt,
    project: { id: config.projectId, name: config.projectName },
    health: { maxSeverity, findingCounts: counts, blocked },
    epics,
    sprints,
    reviews,
    queue,
    lanes,
    next,
    findings: [...findings],
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}
