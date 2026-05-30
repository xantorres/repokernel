import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runCreateEpicCommand, runCreateSprintCommand } from '../src/commands/create.js';
import { runExportCommand } from '../src/commands/exportPlan.js';
import { runImportCommand } from '../src/commands/importPlan.js';
import { runRegistryCommand } from '../src/commands/registry.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(extra: Array<{ path: string; content: string }> = []): Promise<string> {
  return makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }, ...extra]);
}

async function writePlan(cwd: string, yaml: string): Promise<string> {
  await writeFile(join(cwd, 'plan.yaml'), yaml, 'utf8');
  return 'plan.yaml';
}

async function readFm(cwd: string, rel: string): Promise<Record<string, unknown>> {
  return matter(await readFile(join(cwd, rel), 'utf8')).data as Record<string, unknown>;
}

async function readBody(cwd: string, rel: string): Promise<string> {
  return matter(await readFile(join(cwd, rel), 'utf8')).content;
}

const TWO_EPIC_PLAN = `schemaVersion: 1
epics:
  - alias: auth
    title: Authentication
    sprints:
      - alias: login
        title: Login flow
        allowed_paths:
          - "apps/web/{routes,shell}/**"
      - alias: logout
        title: Logout flow
        depends_on:
          - login
  - alias: billing
    title: Billing
    sprints:
      - alias: invoices
        title: Invoices
        depends_on:
          - login
`;

describe('runImportCommand', () => {
  it('creates epics and sprints with resolved ids and dependencies', async () => {
    const cwd = await project();
    const r = await runImportCommand({
      cwd,
      file: await writePlan(cwd, TWO_EPIC_PLAN),
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as { created_epics: string[]; created_sprints: string[] };
    expect(env.created_epics).toEqual(['E-001', 'E-002']);
    expect(env.created_sprints).toEqual(['S-001', 'S-002', 'S-003']);

    // Epic sprints[] hold their children.
    expect(await readFm(cwd, 'epics/E-001.md')).toMatchObject({ sprints: ['S-001', 'S-002'] });
    expect(await readFm(cwd, 'epics/E-002.md')).toMatchObject({ sprints: ['S-003'] });

    // depends_on aliases resolved to real ids, including the cross-epic edge.
    expect(await readFm(cwd, 'sprints/S-002.md')).toMatchObject({ depends_on: ['S-001'] });
    expect(await readFm(cwd, 'sprints/S-003.md')).toMatchObject({ depends_on: ['S-001'] });

    // Brace glob survived verbatim (no comma split through the import path).
    expect(await readFm(cwd, 'sprints/S-001.md')).toMatchObject({
      allowed_paths: ['apps/web/{routes,shell}/**'],
    });
  });

  it('leaves no registry drift after an import', async () => {
    const cwd = await project();
    await runImportCommand({ cwd, file: await writePlan(cwd, TWO_EPIC_PLAN), json: true });
    const check = await runRegistryCommand({ cwd, write: false, check: true, json: true });
    expect(check.exitCode).toBe(0);
  });

  it('resolves depends_on against an already-existing sprint id', async () => {
    const cwd = await project();
    const epicId = (
      JSON.parse((await runCreateEpicCommand('Seed', { cwd, json: true })).stdout) as {
        id: string;
      }
    ).id;
    await runCreateSprintCommand('Seed sprint', {
      cwd,
      epic: epicId,
      lane: 'main',
      status: 'planned',
      json: true,
    });
    const plan = `schemaVersion: 1
epics:
  - alias: e
    title: New epic
    sprints:
      - alias: s
        title: New sprint
        depends_on:
          - S-001
`;
    const r = await runImportCommand({ cwd, file: await writePlan(cwd, plan), json: true });
    expect(r.exitCode).toBe(0);
    // S-001 already existed, so the imported sprint is S-002 and keeps the dep.
    expect(await readFm(cwd, 'sprints/S-002.md')).toMatchObject({ depends_on: ['S-001'] });
  });

  it('rejects an unknown depends_on and writes nothing', async () => {
    const cwd = await project();
    const plan = `schemaVersion: 1
epics:
  - alias: e
    title: Epic
    sprints:
      - alias: s
        title: Sprint
        depends_on:
          - nope
`;
    const r = await runImportCommand({ cwd, file: await writePlan(cwd, plan) });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('nope');
    // Nothing was allocated.
    const check = await runRegistryCommand({ cwd, write: false, check: true, json: true });
    expect(check.stdout).toContain('NO_PREVIOUS_REGISTRY');
  });

  it('--dry-run creates no files', async () => {
    const cwd = await project();
    const r = await runImportCommand({
      cwd,
      file: await writePlan(cwd, TWO_EPIC_PLAN),
      dryRun: true,
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as {
      created_epics: string[];
      dry_run: boolean;
      ids_advisory: boolean;
    };
    expect(env.dry_run).toBe(true);
    expect(env.ids_advisory).toBe(true);
    expect(env.created_epics).toEqual(['E-001', 'E-002']);
    await expect(readFile(join(cwd, 'epics/E-001.md'), 'utf8')).rejects.toThrow();

    // The dry run reserved nothing — a real import still starts from E-001/S-001.
    const real = await runImportCommand({
      cwd,
      file: await writePlan(cwd, TWO_EPIC_PLAN),
      json: true,
    });
    const realEnv = JSON.parse(real.stdout) as {
      created_epics: string[];
      created_sprints: string[];
    };
    expect(realEnv.created_epics).toEqual(['E-001', 'E-002']);
    expect(realEnv.created_sprints).toEqual(['S-001', 'S-002', 'S-003']);
  });

  it('rejects a sprint body containing a --- delimiter line', async () => {
    const plan = `schemaVersion: 1
epics:
  - alias: e
    title: E
    sprints:
      - alias: s
        title: S
        body: |
          # heading

          ---

          trailing
`;
    const cwd = await project();
    const r = await runImportCommand({ cwd, file: await writePlan(cwd, plan) });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('---');
  });

  it('--skip-existing skips an epic whose title already exists', async () => {
    const cwd = await project();
    await runImportCommand({ cwd, file: await writePlan(cwd, TWO_EPIC_PLAN), json: true });
    // Re-run with --skip-existing: both epics already exist by title → 0 new.
    const r = await runImportCommand({
      cwd,
      file: await writePlan(cwd, TWO_EPIC_PLAN),
      skipExisting: true,
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as { created_epics: string[]; skipped_epics: string[] };
    expect(env.created_epics).toEqual([]);
    expect(env.skipped_epics).toEqual(['auth', 'billing']);
  });

  it('rejects malformed YAML with a usage error', async () => {
    const cwd = await project();
    const r = await runImportCommand({ cwd, file: await writePlan(cwd, 'epics: [unterminated') });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/YAML|invalid import plan/);
  });

  it('rejects an unknown top-level key (strict schema)', async () => {
    const cwd = await project();
    const plan = `schemaVersion: 1
bogus: true
epics:
  - alias: e
    title: E
    sprints: []
`;
    const r = await runImportCommand({ cwd, file: await writePlan(cwd, plan) });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid import plan');
  });
});

describe('runExportCommand round-trip', () => {
  it('exports a plan that re-imports to zero new entities and preserves extras', async () => {
    const cwd = await project([
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Tracked epic',
          status: 'active',
          sprints: ['S-001'],
          adr_links: ['ADR-12'],
          extras: { external_id: 'GH-42', tracker_source: 'gh' },
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'First sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          depends_on: [],
          allowed_paths: ['packages/core/**'],
          extras: { ticket: 'GH-43' },
        }),
      },
    ]);

    const exported = await runExportCommand({ cwd });
    expect(exported.exitCode).toBe(0);
    const plan = parseYaml(exported.stdout) as {
      schemaVersion: number;
      epics: Array<{
        alias: string;
        adr_links?: string[];
        extras?: Record<string, unknown>;
        sprints: Array<{ extras?: Record<string, unknown> }>;
      }>;
    };
    expect(plan.schemaVersion).toBe(1);
    expect(plan.epics[0]?.alias).toBe('E-001');
    expect(plan.epics[0]?.adr_links).toEqual(['ADR-12']);
    expect(plan.epics[0]?.extras).toMatchObject({ external_id: 'GH-42' });
    expect(plan.epics[0]?.sprints[0]?.extras).toMatchObject({ ticket: 'GH-43' });

    // Re-importing the exported plan with --skip-existing creates nothing.
    await writeFile(join(cwd, 'roundtrip.yaml'), exported.stdout, 'utf8');
    const reimport = await runImportCommand({
      cwd,
      file: 'roundtrip.yaml',
      skipExisting: true,
      json: true,
    });
    expect(reimport.exitCode).toBe(0);
    const env = JSON.parse(reimport.stdout) as {
      created_epics: string[];
      created_sprints: string[];
    };
    expect(env.created_epics).toEqual([]);
    expect(env.created_sprints).toEqual([]);
  });

  it('round-trips to a fresh project with no body drift (no --skip-existing)', async () => {
    const src = await project();
    await runImportCommand({ cwd: src, file: await writePlan(src, TWO_EPIC_PLAN), json: true });
    const exported1 = await runExportCommand({ cwd: src });
    expect(exported1.exitCode).toBe(0);

    // Re-import into a fresh project WITHOUT --skip-existing — the path that
    // actually re-creates files (the round-trip claim the README makes).
    const dst = await project();
    await writeFile(join(dst, 'rt.yaml'), exported1.stdout, 'utf8');
    const r = await runImportCommand({ cwd: dst, file: 'rt.yaml', json: true });
    expect(r.exitCode).toBe(0);

    // Body, allowed_paths, and depends_on are byte-faithful to the source.
    expect(await readBody(dst, 'sprints/S-001.md')).toBe(await readBody(src, 'sprints/S-001.md'));
    expect(await readFm(dst, 'sprints/S-001.md')).toMatchObject({
      allowed_paths: ['apps/web/{routes,shell}/**'],
    });
    expect(await readFm(dst, 'sprints/S-002.md')).toMatchObject({ depends_on: ['S-001'] });

    // Export is idempotent: exporting the re-imported project equals the first
    // export byte-for-byte (no leading-newline growth per cycle).
    const exported2 = await runExportCommand({ cwd: dst });
    expect(exported2.stdout).toBe(exported1.stdout);
  });

  it('exports a freshly initialized project (no epics) as a valid empty plan', async () => {
    const cwd = await project();
    const r = await runExportCommand({ cwd });
    expect(r.exitCode).toBe(0);
    const plan = parseYaml(r.stdout) as { schemaVersion: number; epics: unknown[] };
    expect(plan.schemaVersion).toBe(1);
    expect(plan.epics).toEqual([]);
  });
});
