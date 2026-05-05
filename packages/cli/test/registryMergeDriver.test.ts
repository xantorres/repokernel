import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildGraph, ConfigSchema, canonicalJson, generateRegistry } from '@repokernel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { installRegistryMergeDriver } from '../src/lifecycle/registry/install.js';
import { runRegistryMergeDriver } from '../src/lifecycle/registry/mergeDriver.js';

const execFileAsync = promisify(execFile);

const CONFIG = ConfigSchema.parse({
  schemaVersion: 1,
  projectId: 'demo',
  projectName: 'Demo',
  paths: {
    epics: 'epics',
    sprints: 'sprints',
    reviews: 'reviews',
    queues: 'queues',
    lanes: 'lanes',
    generated: '.repokernel',
    registry: '.repokernel/registry.json',
  },
});

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-merge-'));
  tracked.push(dir);
  return dir;
}

function emptyRegistry() {
  return generateRegistry({
    graph: buildGraph({
      sprints: [],
      epics: [],
      reviews: [],
      queues: [],
      lanes: [],
      nextMd: null,
      findings: [],
    }),
    config: CONFIG,
    findings: [],
    now: () => '2026-04-25T10:00:00.000Z',
  });
}

describe('runRegistryMergeDriver', () => {
  it('writes merged JSON to current path on clean merge', async () => {
    const dir = await tmp();
    const current = join(dir, 'current.json');
    const other = join(dir, 'other.json');
    const reg = emptyRegistry();
    await writeFile(current, canonicalJson(reg), 'utf8');
    await writeFile(other, canonicalJson(reg), 'utf8');

    const result = await runRegistryMergeDriver({ currentPath: current, otherPath: other });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
    const written = JSON.parse(await readFile(current, 'utf8'));
    expect(written.schemaVersion).toBe(2);
  });

  it('reports a parse error when current file is invalid JSON', async () => {
    const dir = await tmp();
    const current = join(dir, 'current.json');
    const other = join(dir, 'other.json');
    await writeFile(current, '{not-json', 'utf8');
    await writeFile(other, canonicalJson(emptyRegistry()), 'utf8');

    const result = await runRegistryMergeDriver({ currentPath: current, otherPath: other });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/parse/);
  });

  it('returns conflicts but does not mutate the file when sprint titles diverge', async () => {
    const dir = await tmp();
    const current = join(dir, 'current.json');
    const other = join(dir, 'other.json');

    const base = emptyRegistry();
    const localReg = {
      ...base,
      epics: [
        {
          id: 'E-001',
          title: 'Epic 1',
          status: 'active',
          gate: null,
          adr_links: [],
          sprints: ['S-1'],
          file: 'E-001.md',
        },
      ],
      sprints: [
        {
          id: 'S-1',
          title: 'Local title',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'core',
          gate: null,
          depends_on: [],
          blocked_by: [],
          allowed_paths: [],
          denied_paths: [],
          generated_paths: [],
          review_required: true,
          review_id: null,
          started_at: null,
          closed_at: null,
          base_sha: null,
          end_sha: null,
          file: 'S-1.md',
        },
      ],
    };
    const remoteReg = {
      ...localReg,
      sprints: localReg.sprints.map((s) => ({ ...s, title: 'Remote title' })),
    };
    await writeFile(current, canonicalJson(localReg), 'utf8');
    await writeFile(other, canonicalJson(remoteReg), 'utf8');

    const result = await runRegistryMergeDriver({ currentPath: current, otherPath: other });
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    // File still contains the original local content (not the merged one).
    const onDisk = JSON.parse(await readFile(current, 'utf8'));
    expect(onDisk.sprints[0].title).toBe('Local title');
  });
});

describe('installRegistryMergeDriver', () => {
  it('creates a .gitattributes entry and sets git config', async () => {
    const dir = await tmp();
    await execFileAsync('git', ['init', '-q', dir]);

    const result = await installRegistryMergeDriver({ cwd: dir });

    expect(result.attributesAdded).toBe(true);
    const attributes = await readFile(result.attributesPath, 'utf8');
    expect(attributes).toContain('.repokernel/registry.json merge=repokernel-registry');

    const { stdout } = await execFileAsync('git', [
      '-C',
      dir,
      'config',
      'merge.repokernel-registry.driver',
    ]);
    expect(stdout.trim()).toContain('rk registry-merge-driver');
  });

  it('does not duplicate existing .gitattributes entries on rerun', async () => {
    const dir = await tmp();
    await execFileAsync('git', ['init', '-q', dir]);

    await installRegistryMergeDriver({ cwd: dir });
    const second = await installRegistryMergeDriver({ cwd: dir });

    expect(second.attributesAdded).toBe(false);
    const attributes = await readFile(second.attributesPath, 'utf8');
    const matches = attributes.match(/\.repokernel\/registry\.json/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
