import type { Graph } from '../graph/types.js';
import type { Review } from '../schemas/review.js';

export function getSprintReviews(sprintId: string, graph: Graph): Review[] {
  return (graph.reviewsBySprint.get(sprintId) ?? [])
    .map((rid) => graph.reviews.get(rid))
    .filter((r): r is Review => r !== undefined);
}

export function hasAcceptedReview(sprintId: string, graph: Graph): boolean {
  return getSprintReviews(sprintId, graph).some((r) => r.verdict === 'accepted');
}
