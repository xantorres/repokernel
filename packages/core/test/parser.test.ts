import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, parseProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function setup(files: { path: string; content: string }[]) {
  const fixture = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ...files,
  ]);
  const r = await loadConfig({ cwd: fixture.cwd });
  if (!r.ok) throw new Error('config invalid in test fixture');
  const project = await parseProject({ cwd: fixture.cwd, config: r.config });
  return project;
}

describe('parseProject', () => {
  it('parses a valid sprint', async () => {
    const p = await setup([
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'first',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    expect(p.findings).toEqual([]);
    expect(p.sprints).toHaveLength(1);
    expect(p.sprints[0]?.id).toBe('S-001');
    expect(p.sprints[0]?.file).toBe('sprints/S-001.md');
  });

  it('emits UNKNOWN_FRONTMATTER_FIELD as P1 and still parses', async () => {
    const p = await setup([
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'first',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          mystery: 'value',
        }),
      },
    ]);
    expect(p.sprints).toHaveLength(1);
    const unknown = p.findings.filter((f) => f.code === 'UNKNOWN_FRONTMATTER_FIELD');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe('P1');
  });

  it('emits PARSER_FAILURE P0 for schema mismatch', async () => {
    const p = await setup([
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'first',
          epic_id: 'E-001',
          status: 'NOT_A_STATUS',
          lane: 'main',
        }),
      },
    ]);
    expect(p.sprints).toHaveLength(0);
    const failures = p.findings.filter((f) => f.code === 'PARSER_FAILURE');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('P0');
  });

  it('emits FILENAME_ID_MISMATCH P3', async () => {
    const p = await setup([
      {
        path: 'sprints/wrong-name.md',
        content: fm({
          id: 'S-001',
          title: 'first',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    expect(p.sprints).toHaveLength(1);
    const mismatches = p.findings.filter((f) => f.code === 'FILENAME_ID_MISMATCH');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.severity).toBe('P3');
  });

  it('accepts <id>-<slug>.md filenames', async () => {
    const p = await setup([
      {
        path: 'sprints/S-001-some-slug.md',
        content: fm({
          id: 'S-001',
          title: 'first',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    expect(p.findings).toEqual([]);
  });

  it('parses queues, epics, reviews, and lanes alongside sprints', async () => {
    const p = await setup([
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'epic', status: 'active' }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'someone',
          created_at: '2026-04-25T10:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [] }),
      },
      {
        path: 'lanes/main.md',
        content: fm({ name: 'main' }),
      },
    ]);
    expect(p.findings).toEqual([]);
    expect(p.epics).toHaveLength(1);
    expect(p.sprints).toHaveLength(1);
    expect(p.reviews).toHaveLength(1);
    expect(p.queues).toHaveLength(1);
    expect(p.lanes).toHaveLength(1);
  });

  it('queue files are exempt from filename-id mismatch (no top-level id)', async () => {
    const p = await setup([
      {
        path: 'queues/anything.md',
        content: fm({ lane: 'main', slots: [] }),
      },
    ]);
    expect(p.findings).toEqual([]);
  });

  it('returns empty arrays when configured paths do not exist', async () => {
    const p = await setup([]);
    expect(p.sprints).toEqual([]);
    expect(p.epics).toEqual([]);
    expect(p.findings).toEqual([]);
  });

  it('continues parsing when a single file fails', async () => {
    const p = await setup([
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'first',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({ id: 'S-002', title: 'broken' }),
      },
    ]);
    expect(p.sprints).toHaveLength(1);
    expect(p.sprints[0]?.id).toBe('S-001');
    expect(p.findings.some((f) => f.code === 'PARSER_FAILURE')).toBe(true);
  });
});
