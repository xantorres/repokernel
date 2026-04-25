import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';
import { getSprintReviews } from '../helpers.js';

export const reviewIntegrityRule: ValidatorRule = ({ graph, parsed, config }) => {
  const out: Finding[] = [];

  for (const sprint of parsed.sprints) {
    if (!sprint.review_id) continue;
    const review = graph.reviews.get(sprint.review_id);
    if (!review) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_REVIEW_ID_MISSING_REVIEW,
        message: `sprint ${sprint.id} declares review_id ${sprint.review_id} but no such review exists`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { review_id: sprint.review_id },
      });
      continue;
    }
    if (review.sprint_id !== sprint.id) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_REVIEW_ID_WRONG_SPRINT,
        message: `sprint ${sprint.id} references review ${review.id} but that review targets sprint ${review.sprint_id}`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { review_id: review.id, review_sprint_id: review.sprint_id },
      });
    }
  }

  for (const sprint of parsed.sprints) {
    if (sprint.status !== 'shipped') continue;
    if (!config.policies.requireReviewForShipped) continue;
    if (!sprint.review_required) continue;

    const reviews = getSprintReviews(sprint.id, graph);

    if (reviews.length === 0) continue;

    const accepted = reviews.find((r) => r.verdict === 'accepted');
    if (!accepted) {
      const verdicts = reviews.map((r) => `${r.id}=${r.verdict}`).join(', ');
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED,
        message: `shipped sprint ${sprint.id} has reviews but none are accepted (${verdicts})`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { reviews: reviews.map((r) => ({ id: r.id, verdict: r.verdict })) },
      });
    }
  }

  for (const sprint of parsed.sprints) {
    const candidateReviews = new Map(
      getSprintReviews(sprint.id, graph)
        .filter((review) => review.verdict === 'accepted' || review.id === sprint.review_id)
        .map((review) => [review.id, review]),
    );

    for (const review of candidateReviews.values()) {
      if (sprint.base_sha && review.base_sha && sprint.base_sha !== review.base_sha) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.REVIEW_BASE_SHA_MISMATCH,
          message: `sprint ${sprint.id} base_sha ${sprint.base_sha} does not match review ${review.id} base_sha ${review.base_sha}`,
          file: review.file,
          entityType: 'review',
          entityId: review.id,
          data: { sprint_base_sha: sprint.base_sha, review_base_sha: review.base_sha },
        });
      }
      if (sprint.end_sha && review.end_sha && sprint.end_sha !== review.end_sha) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.REVIEW_END_SHA_MISMATCH,
          message: `sprint ${sprint.id} end_sha ${sprint.end_sha} does not match review ${review.id} end_sha ${review.end_sha}`,
          file: review.file,
          entityType: 'review',
          entityId: review.id,
          data: { sprint_end_sha: sprint.end_sha, review_end_sha: review.end_sha },
        });
      }
    }
  }

  return out;
};
