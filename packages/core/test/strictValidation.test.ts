import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Finding, validateProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function validEpic(id: string, sprints: readonly string[], status = 'active'): string {
  return fm({ id, title: id, status, sprints });
}

function sprint(
  id: string,
  body: string,
  extra: Record<string, unknown> = {},
): { readonly path: string; readonly content: string } {
  return {
    path: `sprints/${id}.md`,
    content: fm(
      {
        id,
        title: id,
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
        ...extra,
      },
      body,
    ),
  };
}

function strictBody(deps: readonly string[] = []): string {
  const dependencyLines = deps.length === 0 ? '' : deps.map((id) => `- ${id}`).join('\n');
  return `# Sprint

## Objective

Deliver a precise planning contract for this sprint so operators can understand the outcome, constraints, and verification target before implementation begins.

## Scope in

The sprint updates the validation surface, command behavior, and focused tests that prove the planning contract without changing deferred planning import work.

## Acceptance criteria

- [ ] Strict validation reports actionable findings when required planning sections are absent, shallow, or placeholder-only.
- [ ] Dependency references in the Dependencies section stay synchronized with frontmatter without scanning unrelated body text.

## Dependencies

${dependencyLines}
`;
}

async function setup(files: readonly { readonly path: string; readonly content: string }[]) {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002']) },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ...files,
  ]);
}

describe('strict sprint planning validation', () => {
  it('is opt-in; default validation keeps shallow sprint bodies unchanged', async () => {
    const fixture = await setup([sprint('S-001', '')]);

    const loose = await validateProject({ cwd: fixture.cwd });
    const strict = await validateProject({ cwd: fixture.cwd, strict: true });

    expect(loose.findings.some((f) => f.code === 'SPRINT_PLANNING_SECTION_INVALID')).toBe(false);
    expect(strict.findings.some((f) => f.code === 'SPRINT_PLANNING_SECTION_INVALID')).toBe(true);
  });

  it('requires substantive Objective, Scope in, and Acceptance criteria sections', async () => {
    const body = `# Sprint

## Objective

TBD: choose the actual objective later

## Scope in

TODO - define the exact files and commands this sprint will change

## Acceptance criteria

- [ ] Tests pass
`;
    const fixture = await setup([sprint('S-001', body)]);

    const report = await validateProject({ cwd: fixture.cwd, strict: true });
    const findings = report.findings.filter((f) => f.code === 'SPRINT_PLANNING_SECTION_INVALID');

    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.severity === 'P1')).toBe(true);
    expect(findings.map((f) => f.data?.section).sort()).toEqual([
      'Acceptance criteria',
      'Objective',
      'Scope in',
    ]);
    expect(findings.map((f) => f.data?.reason).sort()).toEqual([
      'placeholder',
      'placeholder',
      'placeholder',
    ]);
  });

  it('checks dependency references only in the Dependencies section', async () => {
    const fixture = await setup([
      sprint('S-001', strictBody()),
      sprint(
        'S-002',
        `${strictBody()}

## Notes

Mention S-001 here without making it a dependency.
`,
      ),
    ]);

    const report = await validateProject({ cwd: fixture.cwd, strict: true });

    expect(report.findings.some((f) => f.code === 'SPRINT_DEPENDENCIES_SECTION_MISMATCH')).toBe(
      false,
    );
  });

  it('ignores sprint refs inside Dependencies section comments', async () => {
    const fixture = await setup([
      sprint(
        'S-001',
        strictBody().replace(
          '## Dependencies\n\n',
          '## Dependencies\n\n<!-- Mention S-002 here only as guidance for authors, not as a real dependency. -->\n',
        ),
      ),
      sprint('S-002', strictBody()),
    ]);

    const report = await validateProject({ cwd: fixture.cwd, strict: true });

    expect(report.findings.some((f) => f.code === 'SPRINT_DEPENDENCIES_SECTION_MISMATCH')).toBe(
      false,
    );
  });

  it('requires Dependencies section refs to exactly match depends_on frontmatter', async () => {
    const fixture = await setup([
      sprint('S-001', strictBody()),
      sprint('S-002', strictBody(['S-001']), { depends_on: [] }),
    ]);

    const report = await validateProject({ cwd: fixture.cwd, strict: true });
    const finding = report.findings.find((f) => f.code === 'SPRINT_DEPENDENCIES_SECTION_MISMATCH');

    expect(finding?.severity).toBe('P1');
    expect(finding?.data).toMatchObject({
      frontmatter: [],
      dependencies_section: ['S-001'],
    });
  });

  it('checks terminal sprints only when strict validation is combined with audit scope', async () => {
    const fixture = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001'], 'done') },
      {
        path: 'sprints/S-001.md',
        content: fm(
          {
            id: 'S-001',
            title: 'S-001',
            epic_id: 'E-001',
            status: 'shipped',
            lane: 'main',
            started_at: '2026-04-25T10:00:00Z',
            closed_at: '2026-04-25T11:00:00Z',
            base_sha: 'a1b2c3d',
            end_sha: 'b2c3d4e',
            review_id: 'R-001',
          },
          '',
        ),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'someone',
          created_at: '2026-04-25T11:30:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const live = await validateProject({ cwd: fixture.cwd, strict: true });
    const audit = await validateProject({ cwd: fixture.cwd, strict: true, scope: 'all' });

    expect(live.findings.some((f) => f.code === 'SPRINT_PLANNING_SECTION_INVALID')).toBe(false);
    expect(audit.findings.some((f) => f.code === 'SPRINT_PLANNING_SECTION_INVALID')).toBe(true);
  });

  it('reports allowed_paths entries that match no files or directories', async () => {
    const fixture = await setup([
      sprint('S-001', strictBody(), {
        allowed_paths: ['src/exists.ts', 'src/missing/**'],
      }),
    ]);
    await mkdir(join(fixture.cwd, 'src'), { recursive: true });
    await writeFile(join(fixture.cwd, 'src/exists.ts'), 'export const ok = true;\n', 'utf8');

    const report = await validateProject({ cwd: fixture.cwd, strict: true });
    const finding = report.findings.find((f) => f.code === 'SPRINT_ALLOWED_PATHS_MATCH_NOTHING');

    expect(finding?.severity).toBe('P2');
    expect(finding?.data).toMatchObject({ allowed_path: 'src/missing/**' });
  });
});

const corpusIt = process.env.REPOKERNEL_STRICT_CORPUS ? it : it.skip;
const defaultCorpusPath = '/Users/xtorres/projects/personal/opsdeck';

function corpusCandidates(configured: string): string[] {
  return Array.from(
    new Set(
      [configured === '1' ? defaultCorpusPath : configured, defaultCorpusPath].map((candidate) =>
        resolve(candidate),
      ),
    ),
  );
}

function findingKey(finding: Finding): string {
  return [
    finding.severity,
    finding.code,
    finding.entityId ?? '',
    finding.file ?? '',
    finding.line ?? '',
    finding.message,
  ].join('\0');
}

function formatFinding(finding: Finding): string {
  const location = [finding.entityId, finding.file, finding.line ? `:${finding.line}` : '']
    .filter(Boolean)
    .join(' ');
  return `${finding.severity} ${finding.code}${location ? ` ${location}` : ''}: ${finding.message}`;
}

function strictOnlyBlockingFindings(
  baselineFindings: readonly Finding[],
  strictFindings: readonly Finding[],
): Finding[] {
  const baselineKeys = new Set(baselineFindings.map(findingKey));
  return strictFindings.filter(
    (finding) =>
      (finding.severity === 'P0' || finding.severity === 'P1') &&
      !baselineKeys.has(findingKey(finding)),
  );
}

describe('strict validation corpus regression', () => {
  corpusIt('fails on strict-only blocking findings in the configured corpus', async () => {
    const configured = process.env.REPOKERNEL_STRICT_CORPUS;
    expect(configured).toBeTruthy();
    const candidates = corpusCandidates(configured ?? '');
    const cwd = candidates.find((candidate) =>
      existsSync(join(resolve(candidate), 'repokernel.config.yaml')),
    );

    if (!cwd) {
      throw new Error(
        `REPOKERNEL_STRICT_CORPUS is set, but no corpus config was found in:\n${candidates.join(
          '\n',
        )}`,
      );
    }

    const baseline = await validateProject({ cwd, scope: 'all' });
    const report = await validateProject({ cwd, strict: true, scope: 'all' });
    const blockingFindings = strictOnlyBlockingFindings(baseline.findings, report.findings);

    expect(report.configPath.endsWith('repokernel.config.yaml')).toBe(true);
    expect(
      blockingFindings.length,
      `strict corpus produced ${blockingFindings.length} strict-only P0/P1 findings:\n${blockingFindings
        .slice(0, 20)
        .map(formatFinding)
        .join('\n')}`,
    ).toBe(0);
  });
});
