import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  findProjectRoot,
  findProjectRootSync,
  loadConfig,
  RepoKernelError,
} from '../src/index.js';

const VALID_YAML = `schemaVersion: 1
projectId: demo
projectName: Demo Project
paths:
  epics: .repokernel/plan/epics
  sprints: .repokernel/plan/sprints
  reviews: .repokernel/plan/reviews
  queues: .repokernel/plan/queues
  lanes: .repokernel/plan/lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`;

async function makeRepo(content: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repokernel-cfg-'));
  if (content !== null) {
    await writeFile(join(dir, CONFIG_FILENAME), content, 'utf8');
  }
  return dir;
}

const created: string[] = [];
async function makeRepoTracked(content: string | null): Promise<string> {
  const dir = await makeRepo(content);
  created.push(dir);
  return dir;
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

describe('loadConfig', () => {
  it('loads a valid config and applies defaults', async () => {
    const cwd = await makeRepoTracked(VALID_YAML);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.projectId).toBe('demo');
      expect(r.config.policies.defaultLane).toBe('main');
      expect(r.config.policies.severityFailThreshold).toBe('P1');
      expect(r.config.git.requireCleanWorkingTreeForClose).toBe(true);
    }
  });

  it('throws CONFIG_FILE_NOT_FOUND when file is missing', async () => {
    const cwd = await makeRepoTracked(null);
    await expect(loadConfig({ cwd })).rejects.toMatchObject({
      kind: 'CONFIG_FILE_NOT_FOUND',
    });
  });

  it('returns CONFIG_INVALID finding for malformed YAML', async () => {
    const cwd = await makeRepoTracked(': : :\nbroken\n');
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.finding.severity).toBe('P0');
      expect(r.finding.code).toBe('CONFIG_INVALID');
    }
  });

  it('returns CONFIG_INVALID finding for schema mismatch', async () => {
    const cwd = await makeRepoTracked(`schemaVersion: 1\nprojectId: demo\n`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.finding.code).toBe('CONFIG_INVALID');
      expect(r.finding.data?.issues).toBeDefined();
    }
  });

  it('rejects unknown top-level keys', async () => {
    const cwd = await makeRepoTracked(`${VALID_YAML}extra: 1\n`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
  });

  it('rejects configured paths outside the project root', async () => {
    const cwd = await makeRepoTracked(VALID_YAML.replace('.repokernel/plan/sprints', '../sprints'));
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.finding.code).toBe('CONFIG_INVALID');
      expect(JSON.stringify(r.finding.data?.issues)).toContain('.. segments');
    }
  });

  it('throws RepoKernelError instance for missing file', async () => {
    const cwd = await makeRepoTracked(null);
    try {
      await loadConfig({ cwd });
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RepoKernelError);
    }
  });

  it('error message points to walk-up failure when running from a non-initialized tree', async () => {
    const cwd = await makeRepoTracked(null);
    await expect(loadConfig({ cwd })).rejects.toMatchObject({
      message: expect.stringContaining('not found in'),
    });
  });
});

describe('findProjectRoot / findProjectRootSync', () => {
  it('finds the config in the start directory', async () => {
    const cwd = await makeRepoTracked(VALID_YAML);
    const asyncRes = await findProjectRoot(cwd);
    const syncRes = findProjectRootSync(cwd);
    expect(asyncRes?.cwd).toBe(cwd);
    expect(syncRes?.cwd).toBe(cwd);
    expect(syncRes?.configPath).toBe(join(cwd, CONFIG_FILENAME));
  });

  it('walks up from a subdirectory to find the project root', async () => {
    const cwd = await makeRepoTracked(VALID_YAML);
    const sub = join(cwd, 'apps', 'web');
    await mkdir(sub, { recursive: true });
    const asyncRes = await findProjectRoot(sub);
    const syncRes = findProjectRootSync(sub);
    expect(asyncRes?.cwd).toBe(cwd);
    expect(syncRes?.cwd).toBe(cwd);
  });

  it('returns null when no config exists between start and filesystem root', async () => {
    const cwd = await makeRepoTracked(null);
    const asyncRes = await findProjectRoot(cwd);
    const syncRes = findProjectRootSync(cwd);
    expect(asyncRes).toBeNull();
    expect(syncRes).toBeNull();
  });
});
