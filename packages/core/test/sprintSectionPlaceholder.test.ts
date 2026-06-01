import { afterAll, describe, expect, it } from 'vitest';
import { validateProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const PLACEHOLDER_BODY = `# S-001

## Objective

<!-- Describe the concrete outcome and the constraint that matters. -->

## Acceptance criteria

- [ ] <!-- observable behavior that proves the sprint succeeded -->
`;

const FILLED_BODY = `# S-001

## Objective

Ship a concrete, observable change that closes the gap and is proven by a focused test.

## Acceptance criteria

- [ ] The new behavior is demonstrated by a focused test that fails before and passes after.
`;

function sprint(id: string, body: string, status = 'planned'): { path: string; content: string } {
  return {
    path: `sprints/${id}.md`,
    content: fm({ id, title: id, epic_id: 'E-001', status, lane: 'main' }, body),
  };
}

async function setup(files: { path: string; content: string }[]) {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ...files,
  ]);
}

describe('sprint placeholder-section rule (live, P2)', () => {
  it('flags required sections that contain only the template placeholder', async () => {
    const fixture = await setup([sprint('S-001', PLACEHOLDER_BODY)]);
    const report = await validateProject({ cwd: fixture.cwd });
    const findings = report.findings.filter((f) => f.code === 'SPRINT_SECTION_PLACEHOLDER_ONLY');
    expect(findings.map((f) => f.data?.section).sort()).toEqual([
      'Acceptance criteria',
      'Objective',
    ]);
    expect(findings.every((f) => f.severity === 'P2')).toBe(true);
  });

  it('stays silent when the required sections are filled in', async () => {
    const fixture = await setup([sprint('S-001', FILLED_BODY)]);
    const report = await validateProject({ cwd: fixture.cwd });
    expect(report.findings.some((f) => f.code === 'SPRINT_SECTION_PLACEHOLDER_ONLY')).toBe(false);
  });

  it('ignores terminal (shipped) sprints', async () => {
    const fixture = await setup([sprint('S-001', PLACEHOLDER_BODY, 'shipped')]);
    const report = await validateProject({ cwd: fixture.cwd });
    expect(report.findings.some((f) => f.code === 'SPRINT_SECTION_PLACEHOLDER_ONLY')).toBe(false);
  });
});
