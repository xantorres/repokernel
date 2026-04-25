import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const duplicateIdsRule: ValidatorRule = ({ parsed }) => {
  return [
    ...detect(parsed.sprints, FINDING_CODES.DUPLICATE_SPRINT_ID, 'sprint'),
    ...detect(parsed.epics, FINDING_CODES.DUPLICATE_EPIC_ID, 'epic'),
    ...detect(parsed.reviews, FINDING_CODES.DUPLICATE_REVIEW_ID, 'review'),
  ];
};

function detect(
  list: readonly { id: string; file: string }[],
  code: string,
  entityType: 'sprint' | 'epic' | 'review',
): Finding[] {
  const byId = new Map<string, string[]>();
  for (const e of list) {
    const files = byId.get(e.id) ?? [];
    files.push(e.file);
    byId.set(e.id, files);
  }
  const out: Finding[] = [];
  for (const [id, files] of byId) {
    if (files.length > 1) {
      out.push({
        severity: 'P0',
        code,
        message: `${entityType} id "${id}" appears in ${files.length} files`,
        entityType,
        entityId: id,
        data: { files },
      });
    }
  }
  return out;
}
