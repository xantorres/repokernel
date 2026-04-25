import type { Epic } from '../schemas/epic.js';
import type { Lane, LaneState } from '../schemas/lane.js';
import type { Queue, QueueSlot } from '../schemas/queue.js';
import type { Review } from '../schemas/review.js';
import type { Sprint } from '../schemas/sprint.js';

export interface Graph {
  readonly sprints: ReadonlyMap<string, Sprint>;
  readonly epics: ReadonlyMap<string, Epic>;
  readonly reviews: ReadonlyMap<string, Review>;
  readonly queues: readonly Queue[];
  readonly laneFiles: readonly Lane[];

  readonly sprintsByEpic: ReadonlyMap<string, readonly string[]>;
  readonly epicsBySprint: ReadonlyMap<string, readonly string[]>;
  readonly reviewsBySprint: ReadonlyMap<string, readonly string[]>;
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
  readonly queuesByLane: ReadonlyMap<string, readonly QueueSlot[]>;
  readonly lanes: ReadonlyMap<string, LaneState>;
}
