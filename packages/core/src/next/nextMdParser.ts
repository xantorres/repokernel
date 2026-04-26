import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import type { Finding } from '../schemas/finding.js';
import { SPRINT_ID_RE } from '../schemas/ids.js';
import { FINDING_CODES } from '../validator/codes.js';

export interface NextSlot {
  readonly slot: number;
  readonly sprintId: string | null;
}

export interface ParsedNextMd {
  readonly slots: readonly NextSlot[];
  readonly lane: string;
  readonly schemaVersion: number;
  readonly declaredSlots: number;
}

export function parseNextMdText(
  text: string,
  fileRel: string = 'NEXT.md',
): { parsed: ParsedNextMd | null; findings: Finding[] } {
  const findings: Finding[] = [];

  let fm: matter.GrayMatterFile<string>;
  try {
    fm = matter(text);
  } catch (e) {
    findings.push({
      severity: 'P0',
      code: FINDING_CODES.NEXT_MD_PARSE_ERROR,
      message: `failed to parse frontmatter in ${fileRel}: ${String(e)}`,
      file: fileRel,
    });
    return { parsed: null, findings };
  }

  const lane = typeof fm.data.lane === 'string' ? fm.data.lane : 'main';
  const schemaVersion = typeof fm.data.schema_version === 'number' ? fm.data.schema_version : 1;
  const declaredSlots = typeof fm.data.slots === 'number' ? fm.data.slots : 4;

  // Parse sections: only grab bullets inside "## Slot N" sections
  const body = fm.content ?? '';
  const lines = body.split('\n');

  interface RawSlot {
    slotNum: number;
    sprintIds: string[];
  }

  const rawSlots: RawSlot[] = [];
  let currentSlot: RawSlot | null = null;
  const SLOT_HEADER_RE = /^##\s+Slot\s+(\d+)/i;
  const BULLET_RE = /^-\s+(S-\d+)/;

  for (const line of lines) {
    const headerMatch = SLOT_HEADER_RE.exec(line);
    if (headerMatch?.[1] !== undefined) {
      currentSlot = { slotNum: parseInt(headerMatch[1], 10), sprintIds: [] };
      rawSlots.push(currentSlot);
      continue;
    }
    if (currentSlot !== null) {
      const bulletMatch = BULLET_RE.exec(line);
      if (bulletMatch?.[1] !== undefined) {
        currentSlot.sprintIds.push(bulletMatch[1]);
      }
    }
  }

  // Validate slot count
  if (rawSlots.length !== declaredSlots) {
    findings.push({
      severity: 'P1',
      code: FINDING_CODES.NEXT_MD_WRONG_SLOT_COUNT,
      message: `${fileRel} declares ${declaredSlots} slots but has ${rawSlots.length} ## Slot sections`,
      file: fileRel,
      data: { declared: declaredSlots, found: rawSlots.length },
    });
  }

  const seenIds = new Set<string>();
  const slots: NextSlot[] = [];

  for (const raw of rawSlots) {
    if (raw.slotNum < 1 || raw.slotNum > declaredSlots) {
      findings.push({
        severity: 'P1',
        code: FINDING_CODES.NEXT_MD_WRONG_SLOT_COUNT,
        message: `${fileRel} slot number ${raw.slotNum} is out of range 1–${declaredSlots}`,
        file: fileRel,
        data: { slotNum: raw.slotNum, declaredSlots },
      });
    }

    if (raw.sprintIds.length > 1) {
      findings.push({
        severity: 'P1',
        code: FINDING_CODES.NEXT_MD_SLOT_MULTIPLE_SPRINTS,
        message: `slot ${raw.slotNum} in ${fileRel} has ${raw.sprintIds.length} sprints (max 1)`,
        file: fileRel,
        data: { slot: raw.slotNum, ids: raw.sprintIds },
      });
    }

    const id = raw.sprintIds[0] ?? null;

    if (id !== null) {
      if (!SPRINT_ID_RE.test(id)) {
        findings.push({
          severity: 'P0',
          code: FINDING_CODES.NEXT_MD_INVALID_ID,
          message: `invalid sprint ID "${id}" in slot ${raw.slotNum} of ${fileRel}`,
          file: fileRel,
          data: { slot: raw.slotNum, id },
        });
      } else if (seenIds.has(id)) {
        findings.push({
          severity: 'P1',
          code: FINDING_CODES.NEXT_MD_DUPLICATE_SPRINT,
          message: `sprint ${id} appears in multiple slots of ${fileRel}`,
          file: fileRel,
          data: { id },
        });
      } else {
        seenIds.add(id);
      }
    }

    slots.push({ slot: raw.slotNum, sprintId: id });
  }

  const parsed: ParsedNextMd = { slots, lane, schemaVersion, declaredSlots };
  return { parsed, findings };
}

export async function readNextMd(
  filePath: string,
  fileRel: string = 'NEXT.md',
): Promise<{ parsed: ParsedNextMd | null; findings: Finding[] }> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return { parsed: null, findings: [] };
  }
  return parseNextMdText(text, fileRel);
}
