import type { ParsedProject } from '../parser/parseProject.js';
import type { LaneState } from '../schemas/lane.js';
import type { QueueSlot } from '../schemas/queue.js';
import type { Graph } from './types.js';

export function buildGraph(parsed: ParsedProject): Graph {
  const sprints = new Map(parsed.sprints.map((s) => [s.id, s]));
  const epics = new Map(parsed.epics.map((e) => [e.id, e]));
  const reviews = new Map(parsed.reviews.map((r) => [r.id, r]));

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

  const dependsOn = new Map<string, readonly string[]>();
  for (const s of parsed.sprints) {
    dependsOn.set(s.id, [...s.depends_on]);
  }

  const queuesByLane = new Map<string, QueueSlot[]>();
  for (const q of parsed.queues) {
    const slots = [...q.slots].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.id.localeCompare(b.id);
    });
    queuesByLane.set(q.lane, slots);
  }

  const lanes = new Map<string, LaneState>();
  for (const lane of parsed.lanes) {
    lanes.set(lane.name, {
      name: lane.name,
      ...(lane.claimed_by !== undefined ? { claimed_by: lane.claimed_by } : {}),
      ...(lane.claimed_at !== undefined ? { claimed_at: lane.claimed_at } : {}),
      inferred: false,
    });
  }
  for (const s of parsed.sprints) {
    if (!lanes.has(s.lane)) lanes.set(s.lane, { name: s.lane, inferred: true });
  }
  for (const q of parsed.queues) {
    if (!lanes.has(q.lane)) lanes.set(q.lane, { name: q.lane, inferred: true });
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
    dependsOn,
    queuesByLane,
    lanes,
  };
}

function freezeMap<V>(m: Map<string, V[]>): Map<string, readonly V[]> {
  const out = new Map<string, readonly V[]>();
  for (const [k, v] of m) out.set(k, [...v]);
  return out;
}
