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

  for (const epic of parsed.epics) {
    const list = sprintsByEpic.get(epic.id) ?? [];
    for (const sid of epic.sprints) {
      if (!list.includes(sid)) list.push(sid);
      const ep = epicsBySprint.get(sid) ?? [];
      if (!ep.includes(epic.id)) ep.push(epic.id);
      epicsBySprint.set(sid, ep);
    }
    sprintsByEpic.set(epic.id, list);
  }

  for (const sprint of parsed.sprints) {
    const ep = epicsBySprint.get(sprint.id) ?? [];
    if (!ep.includes(sprint.epic_id)) ep.push(sprint.epic_id);
    epicsBySprint.set(sprint.id, ep);
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
