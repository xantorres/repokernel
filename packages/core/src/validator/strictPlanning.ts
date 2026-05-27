import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { ParsedProject } from '../parser/parseProject.js';
import { matchesGlob } from '../quality/evaluateRules.js';
import type { Finding } from '../schemas/finding.js';
import type { Sprint } from '../schemas/sprint.js';
import { FINDING_CODES } from './codes.js';

export interface StrictPlanningInput {
  readonly cwd: string;
  readonly parsed: ParsedProject;
  readonly includeTerminal: boolean;
}

interface Section {
  readonly title: string;
  readonly lines: readonly string[];
}

const REQUIRED_TEXT_SECTIONS = [
  { title: 'Objective', minChars: 80 },
  { title: 'Scope in', minChars: 80 },
] as const;

const TERMINAL_STATUSES = new Set(['shipped', 'cancelled']);
const SPRINT_REF_RE = /\bS-\d+\b/g;
const GLOB_META_RE = /[*?[\]{}]/;
const PLACEHOLDERS = new Set(['tbd', 'todo', 'tests pass', 'implement the thing', 'make it work']);

export async function runStrictPlanningValidation(
  input: StrictPlanningInput,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const sprints = input.parsed.sprints.filter(
    (sprint) => input.includeTerminal || !TERMINAL_STATUSES.has(sprint.status),
  );

  for (const sprint of sprints) {
    const sections = parseH2Sections(sprint.body);
    findings.push(...validateRequiredSections(sprint, sections));
    findings.push(...validateDependencySection(sprint, sections));
    findings.push(...(await validateAllowedPaths(input.cwd, sprint)));
  }

  return findings;
}

function validateRequiredSections(
  sprint: Sprint,
  sections: ReadonlyMap<string, Section>,
): Finding[] {
  const findings: Finding[] = [];
  for (const req of REQUIRED_TEXT_SECTIONS) {
    const section = sections.get(normalizeHeading(req.title));
    const text = section === undefined ? '' : substantiveText(section.lines.join('\n'));
    if (section === undefined) {
      findings.push(sectionFinding(sprint, req.title, 'missing', `missing ## ${req.title}`));
      continue;
    }
    if (text.length === 0) {
      const reason = hasPlaceholderContent(section.lines.join('\n')) ? 'placeholder' : 'empty';
      findings.push(sectionFinding(sprint, req.title, reason, `${reason} ## ${req.title}`));
      continue;
    }
    if (text.length < req.minChars) {
      findings.push(
        sectionFinding(
          sprint,
          req.title,
          'shallow',
          `## ${req.title} has ${text.length} substantive chars; expected at least ${req.minChars}`,
        ),
      );
    }
  }

  const ac = sections.get(normalizeHeading('Acceptance criteria'));
  if (ac === undefined) {
    findings.push(
      sectionFinding(sprint, 'Acceptance criteria', 'missing', 'missing ## Acceptance criteria'),
    );
    return findings;
  }
  const rawBullets = bulletTexts(ac.lines);
  const bullets = rawBullets.filter((text) => !isPlaceholder(text));
  const acText = bullets.join(' ');
  if (bullets.length === 0) {
    const reason =
      rawBullets.length > 0 && rawBullets.every((text) => isPlaceholder(text))
        ? 'placeholder'
        : 'empty';
    findings.push(
      sectionFinding(sprint, 'Acceptance criteria', reason, `${reason} ## Acceptance criteria`),
    );
  } else if (bullets.length < 2) {
    findings.push(
      sectionFinding(
        sprint,
        'Acceptance criteria',
        'shallow',
        '## Acceptance criteria needs at least 2 substantive bullets',
      ),
    );
  } else if (acText.length < 60) {
    findings.push(
      sectionFinding(
        sprint,
        'Acceptance criteria',
        'shallow',
        `## Acceptance criteria has ${acText.length} substantive chars; expected at least 60`,
      ),
    );
  }

  return findings;
}

function validateDependencySection(
  sprint: Sprint,
  sections: ReadonlyMap<string, Section>,
): Finding[] {
  const dependencies = sections.get(normalizeHeading('Dependencies'));
  const sectionRefs = uniqueSorted(
    dependencies === undefined
      ? []
      : extractSprintRefs(stripHtmlComments(dependencies.lines.join('\n'))),
  );
  const frontmatterRefs = uniqueSorted(sprint.depends_on);
  if (sameList(sectionRefs, frontmatterRefs)) return [];

  return [
    {
      severity: 'P1',
      code: FINDING_CODES.SPRINT_DEPENDENCIES_SECTION_MISMATCH,
      message: `sprint ${sprint.id} Dependencies section does not match depends_on frontmatter`,
      file: sprint.file,
      entityType: 'sprint',
      entityId: sprint.id,
      suggestion: 'update ## Dependencies so its S-NNN refs exactly match depends_on',
      data: {
        frontmatter: frontmatterRefs,
        dependencies_section: sectionRefs,
      },
    },
  ];
}

async function validateAllowedPaths(cwd: string, sprint: Sprint): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const allowedPath of sprint.allowed_paths) {
    if (await allowedPathMatches(cwd, allowedPath)) continue;
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.SPRINT_ALLOWED_PATHS_MATCH_NOTHING,
      message: `sprint ${sprint.id} allowed_path matches no files or directories: ${allowedPath}`,
      file: sprint.file,
      entityType: 'sprint',
      entityId: sprint.id,
      suggestion: 'update allowed_paths to an existing repo path or intended glob',
      data: { allowed_path: allowedPath },
    });
  }
  return findings;
}

function sectionFinding(sprint: Sprint, section: string, reason: string, message: string): Finding {
  return {
    severity: 'P1',
    code: FINDING_CODES.SPRINT_PLANNING_SECTION_INVALID,
    message: `sprint ${sprint.id}: ${message}`,
    file: sprint.file,
    entityType: 'sprint',
    entityId: sprint.id,
    suggestion:
      section === 'Acceptance criteria'
        ? 'write at least 2 concrete acceptance bullets with observable outcomes'
        : `write a concrete ## ${section} section with at least 80 substantive characters`,
    data: { section, reason },
  };
}

function parseH2Sections(body: string): ReadonlyMap<string, Section> {
  const sections = new Map<string, { title: string; lines: string[] }>();
  let current: { title: string; lines: string[] } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const title = cleanHeading(match[1] ?? '');
      const key = normalizeHeading(title);
      current = { title, lines: [] };
      if (!sections.has(key)) sections.set(key, current);
      continue;
    }
    current?.lines.push(line);
  }
  return sections;
}

function cleanHeading(value: string): string {
  return value.replace(/\s+#+\s*$/, '').trim();
}

function normalizeHeading(value: string): string {
  return cleanHeading(value).toLowerCase().replace(/\s+/g, ' ');
}

function bulletTexts(lines: readonly string[]): readonly string[] {
  const bullets: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      pushBullet(bullets, current);
      current = [bullet[1] ?? ''];
      continue;
    }
    if (current.length > 0 && line.trim().length > 0) current.push(line.trim());
  }
  pushBullet(bullets, current);
  return bullets;
}

function pushBullet(out: string[], rawLines: readonly string[]): void {
  if (rawLines.length === 0) return;
  const text = visibleText(rawLines.join(' '));
  if (text.length > 0) out.push(text);
}

function substantiveText(value: string): string {
  return visibleLines(value)
    .filter((line) => !isPlaceholder(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleText(value: string): string {
  return visibleLines(value).join(' ').replace(/\s+/g, ' ').trim();
}

function visibleLines(value: string): readonly string[] {
  return stripHtmlComments(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    .map((line) => line.replace(/^\[[ xX]\]\s*/, ''))
    .map((line) => markdownToText(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasPlaceholderContent(value: string): boolean {
  const lines = visibleLines(value);
  return lines.length > 0 && lines.every((line) => isPlaceholder(line));
}

function stripHtmlComments(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

function markdownToText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~>#]/g, '')
    .replace(/\s+/g, ' ');
}

function isPlaceholder(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[.!?:;,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return PLACEHOLDERS.has(normalized) || /^(?:todo|tbd)(?:\s|:|-|$)/.test(normalized);
}

function extractSprintRefs(value: string): readonly string[] {
  return [...value.matchAll(SPRINT_REF_RE)].map((match) => match[0]);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function allowedPathMatches(cwd: string, pattern: string): Promise<boolean> {
  if (!GLOB_META_RE.test(pattern)) {
    try {
      await stat(join(cwd, pattern));
      return true;
    } catch {
      return false;
    }
  }

  const base = globStaticBase(pattern);
  const root = resolve(cwd, base);
  try {
    await stat(root);
  } catch {
    return false;
  }

  for await (const relPath of walkRelative(cwd, root)) {
    if (matchesGlob(relPath, pattern)) return true;
  }
  return false;
}

function globStaticBase(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/');
  const meta = normalized.search(GLOB_META_RE);
  if (meta === -1) return normalized;
  const slash = normalized.slice(0, meta).lastIndexOf('/');
  if (slash === -1) return '.';
  const base = normalized.slice(0, slash);
  return base.length > 0 ? base : '.';
}

async function* walkRelative(cwd: string, root: string): AsyncGenerator<string> {
  const rootRel = relative(cwd, root).replaceAll('\\', '/');
  if (rootRel.length > 0) yield rootRel;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const abs = join(root, entry.name);
    const rel = relative(cwd, abs).replaceAll('\\', '/');
    yield rel;
    if (entry.isDirectory()) yield* walkRelative(cwd, abs);
  }
}
