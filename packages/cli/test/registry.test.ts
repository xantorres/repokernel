import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runRegistryCommand } from '../src/commands/registry.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function basicProject() {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'e', status: 'active', sprints: ['S-001'] }),
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
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [] }),
    },
  ]);
}

describe('runRegistryCommand', () => {
  it('--write writes a canonical registry file and exits 0', async () => {
    const cwd = await basicProject();
    const r = await runRegistryCommand({ cwd, write: true, check: false, json: false });
    expect(r.exitCode).toBe(0);
    const text = await readFile(join(cwd, '.repokernel/registry.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const obj = JSON.parse(text) as Record<string, unknown>;
    expect(obj.schemaVersion).toBe(1);
  });

  it('--check exits 0 when registry matches', async () => {
    const cwd = await basicProject();
    await runRegistryCommand({ cwd, write: true, check: false, json: false });
    const r = await runRegistryCommand({ cwd, write: false, check: true, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no drift');
  });

  it('--check exits 1 with REGISTRY_DRIFT when content differs', async () => {
    const cwd = await basicProject();
    await runRegistryCommand({ cwd, write: true, check: false, json: false });
    const path = join(cwd, '.repokernel/registry.json');
    const text = await readFile(path, 'utf8');
    const obj = JSON.parse(text) as Record<string, unknown>;
    obj.project = { id: 'tampered', name: 'tampered' };
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify(obj), 'utf8');
    const r = await runRegistryCommand({ cwd, write: false, check: true, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('REGISTRY_DRIFT');
  });

  it('--check exits 1 when registry does not exist', async () => {
    const cwd = await basicProject();
    const r = await runRegistryCommand({ cwd, write: false, check: true, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('no previous registry');
  });

  it('--write rejects registry paths outside the project root at config-load time', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml().replace(
          'registry: .repokernel/registry.json',
          'registry: ../outside-registry.json',
        )}`,
      },
    ]);
    const r = await runRegistryCommand({ cwd, write: true, check: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('config invalid');
  });

  it('emits canonical JSON when --json without --write/--check', async () => {
    const cwd = await basicProject();
    const r = await runRegistryCommand({ cwd, write: false, check: false, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj.schemaVersion).toBe(1);
  });
});
