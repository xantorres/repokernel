import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, loadConfig, RepoKernelError } from '../src/index.js';

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
      expect(r.finding.data?.['issues']).toBeDefined();
    }
  });

  it('rejects unknown top-level keys', async () => {
    const cwd = await makeRepoTracked(VALID_YAML + 'extra: 1\n');
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
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
});
