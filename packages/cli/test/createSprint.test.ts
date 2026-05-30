import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runCreateSprintCommand } from '../src/commands/create.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function projectWithEpic(extraSprints: Array<{ id: string }> = []): Promise<string> {
  const files = [
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'demo',
        status: 'active',
        sprints: extraSprints.map((s) => s.id),
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ];
  for (const s of extraSprints) {
    files.push({
      path: `sprints/${s.id}.md`,
      content: fm({
        id: s.id,
        title: s.id,
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
      }),
    });
  }
  return makeFixture(files);
}

async function readSprintFm(cwd: string, id: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(cwd, `sprints/${id}.md`), 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

async function readSprintBody(cwd: string, id: string): Promise<string> {
  const raw = await readFile(join(cwd, `sprints/${id}.md`), 'utf8');
  return matter(raw).content;
}

describe('runCreateSprintCommand — ergonomic flags', () => {
  it('creates a sprint with default scaffolded body when no flags are passed', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('My sprint', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
    });
    expect(r.exitCode).toBe(0);
    const data = await readSprintFm(cwd, 'S-001');
    expect(data.depends_on).toEqual([]);
    expect(data.allowed_paths).toEqual([]);
    expect(data.denied_paths).toEqual([]);
    expect(data.adr_links).toEqual([]);
    expect(data.target_date).toBeNull();
    const body = await readSprintBody(cwd, 'S-001');
    expect(body).toContain('## Acceptance criteria');
    expect(body).toContain('Describe the concrete outcome');
    expect(body).not.toContain('- [ ] Tests pass');
  });

  it('writes a sprint body supplied via the body option (no placeholders)', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('Authored sprint', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      body: '# Authored\n\nHand-written objective that proves the body lands.\n',
    });
    expect(r.exitCode).toBe(0);
    const body = await readSprintBody(cwd, 'S-001');
    expect(body).toContain('Hand-written objective that proves the body lands.');
    expect(body).not.toContain('Describe the concrete outcome');
  });

  it('--after accepts multiple values (repeatable)', async () => {
    const cwd = await projectWithEpic([{ id: 'S-001' }, { id: 'S-002' }]);
    const r = await runCreateSprintCommand('Multi-edge', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      after: ['S-001', 'S-002'],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('chaining.enabled: false');
    const data = await readSprintFm(cwd, 'S-003');
    expect(data.depends_on).toEqual(['S-001', 'S-002']);
    const body = await readSprintBody(cwd, 'S-003');
    expect(body).toContain('## Dependencies');
    expect(body).toContain('- S-001');
    expect(body).toContain('- S-002');
  });

  it('--after rejects duplicate values', async () => {
    const cwd = await projectWithEpic([{ id: 'S-001' }]);
    const r = await runCreateSprintCommand('Dup', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      after: ['S-001', 'S-001'],
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('duplicate --after');
  });

  it('--after fails when any dependency sprint does not exist', async () => {
    const cwd = await projectWithEpic([{ id: 'S-001' }]);
    const r = await runCreateSprintCommand('Missing dep', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      after: ['S-001', 'S-999'],
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('S-999 not found');
  });

  it('--allowed-path / --denied-path / --adr / --target-date populate frontmatter', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('With policy', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      allowedPaths: ['src/foo/**', 'test/foo/**'],
      deniedPaths: ['src/legacy/**'],
      adrLinks: ['ADR-049', 'ADR-050'],
      targetDate: '2026-05-15',
    });
    expect(r.exitCode).toBe(0);
    const data = await readSprintFm(cwd, 'S-001');
    expect(data.allowed_paths).toEqual(['src/foo/**', 'test/foo/**']);
    expect(data.denied_paths).toEqual(['src/legacy/**']);
    expect(data.adr_links).toEqual(['ADR-049', 'ADR-050']);
    expect(data.target_date).toBe('2026-05-15');
  });

  it('--target-date rejects non-yyyy-mm-dd input', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('Bad date', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      targetDate: 'next-friday',
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--target-date must be yyyy-mm-dd');
  });

  it('--body-file replaces the scaffolded body', async () => {
    const cwd = await projectWithEpic();
    await writeFile(join(cwd, 'body.md'), '# Custom body\n\n## Goal\nShip it.\n', 'utf8');
    const r = await runCreateSprintCommand('Body file', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      bodyFile: 'body.md',
    });
    expect(r.exitCode).toBe(0);
    const body = await readSprintBody(cwd, 'S-001');
    expect(body).toContain('Ship it.');
    expect(body).not.toContain('## Acceptance criteria');
  });

  it('--body-file with --after synchronizes the Dependencies section', async () => {
    const cwd = await projectWithEpic([{ id: 'S-001' }]);
    await writeFile(
      join(cwd, 'body.md'),
      '# Custom body\n\n## Objective\n\nCustom objective.\n',
      'utf8',
    );

    const r = await runCreateSprintCommand('Body file deps', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      after: ['S-001'],
      bodyFile: 'body.md',
    });

    expect(r.exitCode).toBe(0);
    const body = await readSprintBody(cwd, 'S-002');
    expect(body).toContain('## Dependencies');
    expect(body).toContain('- S-001');
  });

  it('--body-file rejects a file containing frontmatter', async () => {
    const cwd = await projectWithEpic();
    await writeFile(join(cwd, 'bad.md'), '---\nid: oops\n---\n# nope\n', 'utf8');
    const r = await runCreateSprintCommand('Bad body', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      bodyFile: 'bad.md',
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('rk owns frontmatter');
  });

  it('--body-file rejects a body with a mid-document --- delimiter line', async () => {
    const cwd = await projectWithEpic();
    await writeFile(join(cwd, 'mid.md'), '# Title\n\n## Section\n\n---\n\nMore text\n', 'utf8');
    const r = await runCreateSprintCommand('Mid delim', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      bodyFile: 'mid.md',
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('rk owns frontmatter');
  });

  it('--body-file gives a clear error when the file is missing', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('Missing body', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      bodyFile: 'no-such.md',
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--body-file not found');
  });

  it('next-step recommendation matches the operator skill (rk validate --fail-on P0,P1)', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('Recommend', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('rk validate --fail-on P0,P1');
  });

  it('--skip-ids passes over the reserved IDs (CLI override)', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('Skip CLI', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      skipIds: ['S-001', 'S-002'],
    });
    expect(r.exitCode).toBe(0);
    const data = await readSprintFm(cwd, 'S-003');
    expect(data.id).toBe('S-003');
  });

  it('policies.skippedSprintIds is consulted by the allocator', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}policies:\n  skippedSprintIds:\n    - S-001\n    - S-002\n`,
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'demo', status: 'active', sprints: [] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const r = await runCreateSprintCommand('Skip via config', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
    });
    expect(r.exitCode).toBe(0);
    const data = await readSprintFm(cwd, 'S-003');
    expect(data.id).toBe('S-003');
  });

  it('--skip-ids rejects malformed values', async () => {
    const cwd = await projectWithEpic();
    const r = await runCreateSprintCommand('Bad skip', {
      cwd,
      epic: 'E-001',
      lane: 'main',
      status: 'planned',
      skipIds: ['not-a-sprint-id'],
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--skip-ids');
  });
});
