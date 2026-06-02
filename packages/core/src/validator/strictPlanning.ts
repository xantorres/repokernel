import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { ParsedProject } from '../parser/parseProject.js';
import { matchesGlob } from '../quality/evaluateRules.js';
import type { Finding } from '../schemas/finding.js';
import type { Sprint } from '../schemas/sprint.js';
import { FINDING_CODES } from './codes.js';
import {
  hasPlaceholderContent,
  isPlaceholder,
  normalizeHeading,
  parseH2Sections,
  type Section,
  substantiveText,
  visibleText,
} from './sectionText.js';

export interface StrictPlanningInput {
  readonly cwd: string;
  readonly parsed: ParsedProject;
  readonly includeTerminal: boolean;
}

const REQUIRED_TEXT_SECTIONS = [
  { title: 'Objective', minChars: 80 },
  { title: 'Scope in', minChars: 80 },
] as const;

const TERMINAL_STATUSES = new Set(['shipped', 'cancelled']);
const GLOB_META_RE = /[*?[\]{}]/;

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
    findings.push(...(await validateAllowedPaths(input.cwd, sprint)));
  }

  findings.push(...(await validatePackageManifestOwnership(input.cwd, sprints)));

  return findings;
}

const WORKSPACE_PREFIX = 'packages';

/**
 * Flags a deadlocked plan: a sprint scoped into `packages/<name>/...` while no
 * sprint may create `packages/<name>/package.json`. Without an owner the
 * workspace never exists and any `pnpm --filter <name>` acceptance criterion is
 * unsatisfiable, so the executor either stalls or goes out of scope. FS-aware —
 * a manifest already on disk needs no owner.
 */
async function validatePackageManifestOwnership(
  cwd: string,
  sprints: readonly Sprint[],
): Promise<Finding[]> {
  // A sprint with empty allowed_paths has unrestricted scope and can create any
  // manifest, so no package can deadlock — skip the whole check.
  if (sprints.some((sprint) => sprint.allowed_paths.length === 0)) return [];

  // Lowest-id sprint touching each referenced package root.
  const owners = new Map<string, Sprint>();
  for (const sprint of sprints) {
    for (const allowedPath of sprint.allowed_paths) {
      const pkg = packageRootOf(allowedPath);
      if (pkg === null) continue;
      const current = owners.get(pkg);
      if (current === undefined || sprint.id < current.id) owners.set(pkg, sprint);
    }
  }

  const findings: Finding[] = [];
  for (const [pkg, sprint] of owners) {
    const manifest = `${pkg}/package.json`;
    if (await fileExists(join(cwd, manifest))) continue;
    if (sprints.some((s) => s.allowed_paths.some((p) => pathAuthorizes(p, manifest)))) continue;
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.SPRINT_PACKAGE_MANIFEST_UNOWNED,
      message: `sprint ${sprint.id} builds ${pkg} but no sprint may create ${manifest}`,
      file: sprint.file,
      entityType: 'sprint',
      entityId: sprint.id,
      suggestion: `add ${manifest} (and ${pkg}/tsconfig.json) to allowed_paths of the first sprint that builds this package`,
      data: { package: pkg, manifest },
    });
  }
  return findings;
}

/** `packages/<name>` for a path under the workspace dir with a literal name, else null. */
function packageRootOf(allowedPath: string): string | null {
  const segments = allowedPath
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '')
    .split('/');
  const name = segments[1];
  if (segments[0] !== WORKSPACE_PREFIX || name === undefined || name.length === 0) return null;
  // A glob in the package-name segment (e.g. `packages/*`) names no concrete package.
  if (GLOB_META_RE.test(name)) return null;
  return `${WORKSPACE_PREFIX}/${name}`;
}

/** True when `pattern` (prefix or glob) would authorize writing `file`. */
function pathAuthorizes(pattern: string, file: string): boolean {
  const p = pattern.replaceAll('\\', '/');
  if (!GLOB_META_RE.test(p)) {
    const prefix = p.replace(/\/$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return matchesGlob(file, p);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
