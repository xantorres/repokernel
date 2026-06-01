import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';
import { normalizeHeading, parseH2Sections, substantiveText } from '../sectionText.js';

const REQUIRED_SECTIONS = ['Objective', 'Acceptance criteria'] as const;
const TERMINAL_STATUSES = new Set(['shipped', 'cancelled']);

/**
 * Always-on companion to the strict planning contract: flag a sprint whose
 * required section is present but holds only the template placeholder (HTML
 * comments / whitespace). Catches sprints created from the scaffold and shipped
 * without ever being filled in. P2 — surfaced, never blocking. Missing sections
 * and depth thresholds remain `rk validate --strict`'s concern.
 */
export const sprintSectionPlaceholderRule: ValidatorRule = ({ parsed }) => {
  const out: Finding[] = [];
  for (const sprint of parsed.sprints) {
    if (TERMINAL_STATUSES.has(sprint.status)) continue;
    const sections = parseH2Sections(sprint.body);
    for (const title of REQUIRED_SECTIONS) {
      const section = sections.get(normalizeHeading(title));
      if (section === undefined) continue;
      if (substantiveText(section.lines.join('\n')).length > 0) continue;
      out.push({
        severity: 'P2',
        code: FINDING_CODES.SPRINT_SECTION_PLACEHOLDER_ONLY,
        message: `sprint ${sprint.id}: ## ${title} contains only the template placeholder`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        suggestion: `fill in ## ${title} with concrete content before review`,
        data: { section: title },
      });
    }
  }
  return out;
};
