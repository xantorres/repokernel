import type { ParsedProject } from '../parser/parseProject.js';
import type { LaneState } from '../schemas/lane.js';
import type { QueueSlot } from '../schemas/queue.js';
import type { Graph } from './types.js';

export function buildGraph(parsed: ParsedProject): Graph {
  const sprints = firstById(parsed.sprints);
  const epics = firstById(parsed.epics);
  const reviews = firstById(parsed.reviews);

  const sprintsByEpic = new Map<string, string[]>();
  const epicsBySprint = new Map<string, string[]>();

  // Phase 1: derive membership from sprint.epic_id (canonical source of truth)
  const backPtrsByEpic = new Map<string, string[]>();
  for (const sprint of parsed.sprints) {
    const backList = backPtrsByEpic.get(sprint.epic_id) ?? [];
    if (!backList.includes(sprint.id)) backList.push(sprint.id);
    backPtrsByEpic.set(sprint.epic_id, backList);

    const epList = epicsBySprint.get(sprint.id) ?? [];
    if (!epList.includes(sprint.epic_id)) epList.push(sprint.epic_id);
    epicsBySprint.set(sprint.id, epList);
  }

  // Phase 2: apply epic.sprints[] as ordering hint; track extra claimants
  for (const epic of parsed.epics) {
    const members = new Set(backPtrsByEpic.get(epic.id) ?? []);
    const ordered: string[] = [];

    for (const sid of epic.sprints) {
      // Track this epic claiming the sprint (enables SPRINT_IN_MULTIPLE_EPICS detection)
      const epList = epicsBySprint.get(sid) ?? [];
      if (!epList.includes(epic.id)) epList.push(epic.id);
      epicsBySprint.set(sid, epList);

      // Place in ordered list only if it's an actual back-pointer member
      if (members.has(sid)) {
        ordered.push(sid);
        members.delete(sid);
      }
    }

    // Append any unlisted back-pointer members at the end
    for (const sid of members) ordered.push(sid);

    sprintsByEpic.set(epic.id, ordered);
  }

  // Ensure all epics have an entry even if they have no back-pointer sprints
  for (const epic of parsed.epics) {
    if (!sprintsByEpic.has(epic.id)) sprintsByEpic.set(epic.id, []);
  }

  const reviewsBySprint = new Map<string, string[]>();
  for (const r of parsed.reviews) {
    const list = reviewsBySprint.get(r.sprint_id) ?? [];
    list.push(r.id);
    reviewsBySprint.set(r.sprint_id, list);
  }

  const dependsOnMut = new Map<string, string[]>();
  for (const s of parsed.sprints) {
    if (!dependsOnMut.has(s.id)) dependsOnMut.set(s.id, [...s.depends_on]);
  }

  const queuesByLaneMut = new Map<string, QueueSlot[]>();
  for (const q of parsed.queues) {
    const slots = [...q.slots].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.id.localeCompare(b.id);
    });
    queuesByLaneMut.set(q.lane, [...(queuesByLaneMut.get(q.lane) ?? []), ...slots]);
  }
  for (const [lane, slots] of queuesByLaneMut) {
    queuesByLaneMut.set(
      lane,
      [...slots].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.id.localeCompare(b.id);
      }),
    );
  }

  const lanesMut = new Map<string, LaneState>();
  for (const lane of parsed.lanes) {
    lanesMut.set(lane.name, {
      name: lane.name,
      ...(lane.claimed_by !== undefined ? { claimed_by: lane.claimed_by } : {}),
      ...(lane.claimed_at !== undefined ? { claimed_at: lane.claimed_at } : {}),
      inferred: false,
    });
  }
  for (const s of parsed.sprints) {
    if (!lanesMut.has(s.lane)) lanesMut.set(s.lane, { name: s.lane, inferred: true });
  }
  for (const q of parsed.queues) {
    if (!lanesMut.has(q.lane)) lanesMut.set(q.lane, { name: q.lane, inferred: true });
  }

  return {
    sprints,
    epics,
    reviews,
    queues: parsed.queues,
    laneFiles: parsed.lanes,
    sprintsByEpic: freezeMap(sprintsByEpic),
    epicsBySprint: freezeMap(epicsBySprint),
    reviewsBySprint: freezeMap(reviewsBySprint),
    dependsOn: freezeMap(dependsOnMut),
    queuesByLane: freezeMap(queuesByLaneMut),
    lanes: freezeObjectMap(lanesMut),
  };
}

function firstById<T extends { readonly id: string }>(items: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    if (!out.has(item.id)) out.set(item.id, item);
  }
  return out;
}

function freezeMap<V>(m: Map<string, V[]>): ReadonlyMap<string, readonly V[]> {
  const out = new Map<string, readonly V[]>();
  for (const [k, v] of m) out.set(k, Object.freeze([...v]));
  return out;
}

function freezeObjectMap<V extends object>(m: Map<string, V>): ReadonlyMap<string, Readonly<V>> {
  const out = new Map<string, Readonly<V>>();
  for (const [k, v] of m) out.set(k, Object.freeze({ ...v }));
  return out;
}
