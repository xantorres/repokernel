import { basename } from 'node:path';
import type { LoadProjectResult } from '@repokernel/core';

export interface EntityLookup {
  readonly type: 'sprint' | 'epic' | 'review' | 'queue' | 'lane';
  readonly id: string;
  readonly file: string | null;
}

export function findEntity(project: LoadProjectResult, id: string): EntityLookup | null {
  const sprint = project.graph.sprints.get(id);
  if (sprint) return { type: 'sprint', id: sprint.id, file: sprint.file };

  const epic = project.graph.epics.get(id);
  if (epic) return { type: 'epic', id: epic.id, file: epic.file };

  const review = project.graph.reviews.get(id);
  if (review) return { type: 'review', id: review.id, file: review.file };

  const queue = project.parsed.queues.find((q) => q.lane === id || basename(q.file, '.md') === id);
  if (queue) return { type: 'queue', id: queue.lane, file: queue.file };

  const laneFile = project.parsed.lanes.find((lane) => lane.name === id);
  if (laneFile) return { type: 'lane', id: laneFile.name, file: laneFile.file };

  const lane = project.graph.lanes.get(id);
  if (lane) return { type: 'lane', id: lane.name, file: null };

  return null;
}
