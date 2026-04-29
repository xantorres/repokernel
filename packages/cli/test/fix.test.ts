import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runFixCommand } from '../src/commands/fix.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface FixPreviewJson {
  readonly schemaVersion: number;
  readonly safeFixes: readonly { title: string; detail: string }[];
  readonly manualSuggestions: readonly { title: string; detail: string }[];
}

async function shippedSprintInQueueFixture(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001', 'S-002'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'shipped sprint still in queue',
        epic_id: 'E-001',
        status: 'shipped',
        lane: 'main',
        base_sha: 'a'.repeat(40),
        end_sha: 'b'.repeat(40),
        closed_at: '2026-04-29T12:00:00Z',
      }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({
        id: 'S-002',
        title: 'still planned',
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
      }),
    },
    {
      path: 'queues/main.md',
      content: fm({
        lane: 'main',
        slots: [
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          { id: 'Q-002', sprint_id: 'S-002', order: 1 },
        ],
      }),
    },
  ]);
}

describe('runFixCommand — SHIPPED_SPRINT_IN_QUEUE', () => {
  it('--preview surfaces a safe fix (not just a manual suggestion)', async () => {
    const cwd = await shippedSprintInQueueFixture();
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout) as FixPreviewJson;

    const removeFromQueue = preview.safeFixes.find((f) => /remove S-001 from queue/i.test(f.title));
    expect(removeFromQueue, 'safe fix for shipped-in-queue is missing').toBeDefined();

    const inManual = preview.manualSuggestions.find((f) =>
      /remove S-001 from queue/i.test(f.title),
    );
    expect(
      inManual,
      'shipped-in-queue should not be a manual suggestion when remediation is mechanical',
    ).toBeUndefined();
  });

  it('--apply removes the shipped sprint slot and renumbers remaining slots', async () => {
    const cwd = await shippedSprintInQueueFixture();
    const result = await runFixCommand({
      cwd,
      preview: false,
      apply: true,
      yes: true,
      json: true,
    });
    expect(result.exitCode).toBe(0);

    const queueRaw = await readFile(join(cwd, 'queues/main.md'), 'utf8');
    const fmEnd = queueRaw.indexOf('\n---', 4);
    const yamlBlock = queueRaw.slice(4, fmEnd);
    const data = parseYaml(yamlBlock) as {
      lane: string;
      slots: { sprint_id: string; order: number }[];
    };
    expect(data.slots.map((s) => s.sprint_id)).toEqual(['S-002']);
    expect(data.slots[0]?.order).toBe(0);
  });
});

describe('runFixCommand — CANCELLED_SPRINT_IN_QUEUE', () => {
  it('--preview surfaces a safe fix for a cancelled sprint sitting in queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'cancelled',
          epic_id: 'E-001',
          status: 'cancelled',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout) as FixPreviewJson;
    const removeFromQueue = preview.safeFixes.find((f) => /remove S-001 from queue/i.test(f.title));
    expect(removeFromQueue, 'cancelled-in-queue should be a safe fix').toBeDefined();
  });
});
