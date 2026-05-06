import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runSprintRoutingClearCommand,
  runSprintRoutingSetCommand,
} from '../src/commands/sprintRouting.js';
import { EXIT_OK, EXIT_USAGE } from '../src/exitCodes.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function fixture(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Epic', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm(
        {
          id: 'S-001',
          title: 'Route me',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          extras: { keep: true },
        },
        'body\n',
      ),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    { path: 'lanes/main.md', content: fm({ name: 'main' }) },
  ]);
}

async function sprintExtras(cwd: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(cwd, 'sprints/S-001.md'), 'utf8');
  const parsed = matter(raw).data as { extras?: Record<string, unknown> };
  return parsed.extras ?? {};
}

describe('rk sprint routing', () => {
  it('sets routing metadata without dropping sibling extras', async () => {
    const cwd = await fixture();
    const result = await runSprintRoutingSetCommand('S-001', {
      cwd,
      complexity: 'deep',
      pinTier: 'heavy',
      fanout: 'fast:light,deep:standard',
      json: true,
    });

    expect(result.exitCode).toBe(EXIT_OK);
    const extras = await sprintExtras(cwd);
    expect(extras.keep).toBe(true);
    expect(extras.routing).toEqual({
      complexity: 'deep',
      pin_tier: 'heavy',
      fanout: [
        { id: 'fast', tier: 'light' },
        { id: 'deep', tier: 'standard' },
      ],
    });
  });

  it('clears only routing metadata', async () => {
    const cwd = await fixture();
    await runSprintRoutingSetCommand('S-001', { cwd, preferTier: 'standard' });

    const result = await runSprintRoutingClearCommand('S-001', { cwd });

    expect(result.exitCode).toBe(EXIT_OK);
    const extras = await sprintExtras(cwd);
    expect(extras.keep).toBe(true);
    expect(extras.routing).toBeUndefined();
  });

  it('rejects malformed fanout entries', async () => {
    const cwd = await fixture();
    const result = await runSprintRoutingSetCommand('S-001', {
      cwd,
      fanout: 'missing-tier',
    });

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('expected id:tier');
  });
});
