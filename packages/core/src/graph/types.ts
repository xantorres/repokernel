import type { Epic } from '../schemas/epic.js';
import type { EpicId, ReviewId, SprintId } from '../schemas/ids.js';
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

  readonly sprintsByEpic: ReadonlyMap<string, readonly SprintId[]>;
  readonly epicsBySprint: ReadonlyMap<string, readonly EpicId[]>;
  readonly reviewsBySprint: ReadonlyMap<string, readonly ReviewId[]>;
  readonly dependsOn: ReadonlyMap<string, readonly SprintId[]>;
  readonly queuesByLane: ReadonlyMap<string, readonly QueueSlot[]>;
  readonly lanes: ReadonlyMap<string, LaneState>;
}

// --- Wave types for parallel execution ---

export interface Wave {
  /** 0-based wave index within the epic's execution plan. */
  readonly index: number;
  /** Sprints in this wave, sorted by queue order then sprint ID. */
  readonly sprints: readonly Sprint[];
  /** False when wave has exactly 1 sprint (no parallelism needed). */
  readonly canParallelize: boolean;
}

export interface WavePreviewBlocked {
  readonly sprint: Sprint;
  readonly reason: string;
}

/** Extended wave view including non-runnable sprints, for display commands. */
export interface WavePreview extends Wave {
  /** Sprints eligible by deps but blocked for other reasons (gate, wrong status, etc.). */
  readonly blocked: readonly WavePreviewBlocked[];
  /** Sprints with a gate field blocking the wave. */
  readonly gated: readonly Sprint[];
  /** Sprints in planned/pending status — not yet queued. */
  readonly planned: readonly Sprint[];
}
