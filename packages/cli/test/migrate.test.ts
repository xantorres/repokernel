import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrateCommand } from '../src/commands/migrate.js';
import { defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

vi.mock('../src/lifecycle/controlPaths.js', () => ({
  operationalRoot: vi.fn(),
  runStateRoot: (opRoot: string) => join(opRoot, 'runs'),
}));

import { operationalRoot } from '../src/lifecycle/controlPaths.js';

let opRootDir: string;

afterAll(async () => {
  if (opRootDir) await rm(opRootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // each test gets a fresh opRoot
  opRootDir = await makeFixture([]);
  await mkdir(join(opRootDir, 'runs'), { recursive: true });
  vi.mocked(operationalRoot).mockResolvedValue(opRootDir);
});

afterEach(() => {
  vi.mocked(operationalRoot).mockReset();
});

function sprintFile(id: string, extra: Record<string, unknown> = {}) {
  return fm({ id, title: 'Sprint', epic_id: 'E-001', status: 'planned', lane: 'main', ...extra });
}

function queueFile(extra: Record<string, unknown> = {}) {
  return fm({ lane: 'main', slots: [], ...extra });
}

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

async function rawHasSchemaVersion(file: string): Promise<boolean> {
  const raw = await readFile(file, 'utf8');
  return raw.includes('schema_version');
}

describe('runMigrateCommand', () => {
  describe('sprint files', () => {
    it('adds schema_version to sprint file that lacks it', async () => {
      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
        { path: 'sprints/S-001.md', content: sprintFile('S-001') },
        { path: 'queues/main.md', content: queueFile() },
      ]);

      const result = await runMigrateCommand({ cwd, dryRun: false });
      expect(result.exitCode).toBe(0);

      const data = await readFm(join(cwd, 'sprints/S-001.md'));
      expect(data.schema_version).toBe(1);
    });

    it('does not overwrite schema_version that is already current', async () => {
      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
        { path: 'sprints/S-001.md', content: sprintFile('S-001', { schema_version: 1 }) },
        { path: 'queues/main.md', content: queueFile() },
      ]);

      const result = await runMigrateCommand({ cwd, dryRun: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('already current');
    });

    it('dry-run does not write to sprint file on disk', async () => {
      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
        { path: 'sprints/S-001.md', content: sprintFile('S-001') },
        { path: 'queues/main.md', content: queueFile() },
      ]);

      const result = await runMigrateCommand({ cwd, dryRun: true });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('dry-run');
      expect(result.stdout).toContain('Would upgrade');

      // raw file content must NOT contain schema_version
      expect(await rawHasSchemaVersion(join(cwd, 'sprints/S-001.md'))).toBe(false);
    });
  });

  describe('queue files', () => {
    it('adds schema_version to queue file that lacks it', async () => {
      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
        { path: 'queues/main.md', content: queueFile() },
      ]);

      const result = await runMigrateCommand({ cwd, dryRun: false });
      expect(result.exitCode).toBe(0);

      const data = await readFm(join(cwd, 'queues/main.md'));
      expect(data.schema_version).toBe(1);
    });
  });

  describe('run JSON files', () => {
    it('adds schema_version to run JSON file that lacks it', async () => {
      const runData = {
        id: 'RUN-001',
        epic_id: 'E-001',
        lane: 'main',
        status: 'completed',
        mode: 'assisted',
        agent: 'fake',
        worktree: '/tmp/wt',
        branch: 'rk/run/RUN-001',
        started_at: '2026-04-26T10:00:00Z',
        ended_at: null,
        current_sprint: null,
        completed_sprints: [],
        halt_reason: null,
        limit: null,
        sprint_count: 0,
      };

      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      ]);
      await writeFile(
        join(opRootDir, 'runs', 'RUN-001.json'),
        JSON.stringify(runData, null, 2),
        'utf8',
      );

      const result = await runMigrateCommand({ cwd, dryRun: false });
      expect(result.exitCode).toBe(0);

      const written = JSON.parse(
        await readFile(join(opRootDir, 'runs', 'RUN-001.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(written.schema_version).toBe(1);
    });

    it('dry-run does not write run JSON to disk', async () => {
      const runData = { id: 'RUN-001', lane: 'main' };
      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      ]);
      await writeFile(
        join(opRootDir, 'runs', 'RUN-001.json'),
        JSON.stringify(runData, null, 2),
        'utf8',
      );

      await runMigrateCommand({ cwd, dryRun: true });

      const after = JSON.parse(
        await readFile(join(opRootDir, 'runs', 'RUN-001.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(after.schema_version).toBeUndefined();
    });
  });

  describe('output messages', () => {
    it('reports files upgraded and already current', async () => {
      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
        { path: 'sprints/S-001.md', content: sprintFile('S-001') },
        { path: 'sprints/S-002.md', content: sprintFile('S-002', { schema_version: 1 }) },
        { path: 'queues/main.md', content: queueFile() },
      ]);

      const result = await runMigrateCommand({ cwd, dryRun: false });
      expect(result.exitCode).toBe(0);
      // S-001 and queue upgraded, S-002 (with schema_version:1) already current
      expect(result.stdout).toMatch(/Upgraded \d+ file/);
      expect(result.stdout).toContain('already current');

      // After migration, all 3 files should have schema_version 1
      expect(await rawHasSchemaVersion(join(cwd, 'sprints/S-001.md'))).toBe(true);
      expect(await rawHasSchemaVersion(join(cwd, 'sprints/S-002.md'))).toBe(true);
      expect(await rawHasSchemaVersion(join(cwd, 'queues/main.md'))).toBe(true);
    });
  });
});
