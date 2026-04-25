import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ZodIssue, ZodTypeAny } from 'zod';
import type { Config } from '../config/schema.js';
import type { Finding } from '../schemas/finding.js';
import type { EntityType } from '../schemas/finding.js';
import {
  EpicFrontmatterSchema,
  type Epic,
} from '../schemas/epic.js';
import {
  LaneFrontmatterSchema,
  type Lane,
} from '../schemas/lane.js';
import {
  QueueFrontmatterSchema,
  type Queue,
} from '../schemas/queue.js';
import {
  ReviewFrontmatterSchema,
  type Review,
} from '../schemas/review.js';
import {
  SprintFrontmatterSchema,
  type Sprint,
} from '../schemas/sprint.js';
import { parseMarkdown } from './markdown.js';
import { listMarkdownFiles } from './walk.js';

export interface ParsedProject {
  readonly sprints: readonly Sprint[];
  readonly epics: readonly Epic[];
  readonly reviews: readonly Review[];
  readonly queues: readonly Queue[];
  readonly lanes: readonly Lane[];
  readonly findings: readonly Finding[];
}

export interface ParseProjectOptions {
  readonly cwd: string;
  readonly config: Config;
}

interface EntityKind<TSchema extends ZodTypeAny> {
  readonly entityType: EntityType;
  readonly schema: TSchema;
  readonly knownKeys: ReadonlySet<string>;
  readonly hasTopLevelId: boolean;
}

function knownKeysOf<T extends ZodTypeAny>(schema: T): ReadonlySet<string> {
  const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
  return new Set(Object.keys(shape));
}

const SPRINT_KIND: EntityKind<typeof SprintFrontmatterSchema> = {
  entityType: 'sprint',
  schema: SprintFrontmatterSchema,
  knownKeys: knownKeysOf(SprintFrontmatterSchema),
  hasTopLevelId: true,
};

const EPIC_KIND: EntityKind<typeof EpicFrontmatterSchema> = {
  entityType: 'epic',
  schema: EpicFrontmatterSchema,
  knownKeys: knownKeysOf(EpicFrontmatterSchema),
  hasTopLevelId: true,
};

const REVIEW_KIND: EntityKind<typeof ReviewFrontmatterSchema> = {
  entityType: 'review',
  schema: ReviewFrontmatterSchema,
  knownKeys: knownKeysOf(ReviewFrontmatterSchema),
  hasTopLevelId: true,
};

const QUEUE_KIND: EntityKind<typeof QueueFrontmatterSchema> = {
  entityType: 'queue',
  schema: QueueFrontmatterSchema,
  knownKeys: knownKeysOf(QueueFrontmatterSchema),
  hasTopLevelId: false,
};

const LANE_KIND: EntityKind<typeof LaneFrontmatterSchema> = {
  entityType: 'lane',
  schema: LaneFrontmatterSchema,
  knownKeys: knownKeysOf(LaneFrontmatterSchema),
  hasTopLevelId: false,
};

interface ParseFileOutcome<TValue> {
  readonly value: TValue | null;
  readonly findings: Finding[];
}

async function parseEntityFile<TSchema extends ZodTypeAny>(
  cwd: string,
  fileRel: string,
  kind: EntityKind<TSchema>,
): Promise<ParseFileOutcome<TSchema['_output'] & { file: string; body: string }>> {
  const findings: Finding[] = [];
  const fileAbs = join(cwd, fileRel);
  let text: string;
  try {
    text = await readFile(fileAbs, 'utf8');
  } catch (cause) {
    findings.push({
      severity: 'P0',
      code: 'PARSER_FAILURE',
      message: `failed to read ${fileRel}: ${(cause as Error).message}`,
      file: fileRel,
      entityType: kind.entityType,
    });
    return { value: null, findings };
  }

  const md = parseMarkdown(text);
  if (!md.ok) {
    findings.push({
      severity: 'P0',
      code: 'PARSER_FAILURE',
      message: `failed to parse frontmatter in ${fileRel}: ${md.error}`,
      file: fileRel,
      entityType: kind.entityType,
    });
    return { value: null, findings };
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(md.parsed.data)) {
    if (kind.knownKeys.has(key)) {
      stripped[key] = val;
    } else {
      findings.push({
        severity: 'P3',
        code: 'UNKNOWN_FRONTMATTER_FIELD',
        message: `unknown frontmatter field "${key}" in ${fileRel}`,
        file: fileRel,
        entityType: kind.entityType,
        suggestion: `remove "${key}" or add it to the schema`,
        data: { field: key },
      });
    }
  }

  const parsed = kind.schema.safeParse(stripped);
  if (!parsed.success) {
    findings.push({
      severity: 'P0',
      code: 'PARSER_FAILURE',
      message: `schema validation failed for ${fileRel}`,
      file: fileRel,
      entityType: kind.entityType,
      data: {
        issues: parsed.error.issues.map((i: ZodIssue) => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      },
    });
    return { value: null, findings };
  }

  const value = { ...parsed.data, file: fileRel, body: md.parsed.body };

  if (kind.hasTopLevelId) {
    const id = (parsed.data as { id?: unknown }).id;
    if (typeof id === 'string') {
      const base = basename(fileRel, '.md');
      const ok = base === id || base.startsWith(`${id}-`);
      if (!ok) {
        findings.push({
          severity: 'P3',
          code: 'FILENAME_ID_MISMATCH',
          message: `filename "${base}" does not match id "${id}"`,
          file: fileRel,
          entityType: kind.entityType,
          entityId: id,
          suggestion: `rename file to ${id}.md or ${id}-<slug>.md`,
        });
      }
    }
  }

  return { value, findings };
}

export async function parseProject(options: ParseProjectOptions): Promise<ParsedProject> {
  const cwd = resolve(options.cwd);
  const { config } = options;
  const findings: Finding[] = [];

  const sprintFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.sprints));
  const epicFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.epics));
  const reviewFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.reviews));
  const queueFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.queues));
  const laneFiles = await listMarkdownFiles(cwd, join(cwd, config.paths.lanes));

  const sprints: Sprint[] = [];
  for (const f of sprintFiles) {
    const r = await parseEntityFile(cwd, f, SPRINT_KIND);
    findings.push(...r.findings);
    if (r.value) sprints.push(r.value as Sprint);
  }

  const epics: Epic[] = [];
  for (const f of epicFiles) {
    const r = await parseEntityFile(cwd, f, EPIC_KIND);
    findings.push(...r.findings);
    if (r.value) epics.push(r.value as Epic);
  }

  const reviews: Review[] = [];
  for (const f of reviewFiles) {
    const r = await parseEntityFile(cwd, f, REVIEW_KIND);
    findings.push(...r.findings);
    if (r.value) reviews.push(r.value as Review);
  }

  const queues: Queue[] = [];
  for (const f of queueFiles) {
    const r = await parseEntityFile(cwd, f, QUEUE_KIND);
    findings.push(...r.findings);
    if (r.value) queues.push(r.value as Queue);
  }

  const lanes: Lane[] = [];
  for (const f of laneFiles) {
    const r = await parseEntityFile(cwd, f, LANE_KIND);
    findings.push(...r.findings);
    if (r.value) lanes.push(r.value as Lane);
  }

  return { sprints, epics, reviews, queues, lanes, findings };
}
