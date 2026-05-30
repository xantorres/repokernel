import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runCreateEpicCommand,
  runCreateQueueCommand,
  runCreateReviewCommand,
  runCreateSprintCommand,
} from '../src/commands/create.js';
import { runRegistryCommand } from '../src/commands/registry.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-create-json-'));
  tracked.push(cwd);
  await writeFile(
    join(cwd, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: pr8
projectName: PR8 Create JSON Fixture
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
    'utf8',
  );
  for (const p of ['epics', 'sprints', 'reviews', 'queues', 'lanes']) {
    await mkdir(join(cwd, p), { recursive: true });
  }
  return cwd;
}

describe('rk create --json envelopes (PR8 finding 17)', () => {
  it('rk create epic --json emits { kind, id, file, updated, next_actions }', async () => {
    const cwd = await makeProject();
    const r = await runCreateEpicCommand('Test epic', { cwd, json: true });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(env.kind).toBe('epic');
    expect(env.id).toMatch(/^E-\d{3}$/);
    expect(env.file).toMatch(/epics\/E-\d{3}\.md$/);
    expect(Array.isArray(env.updated)).toBe(true);
    expect(Array.isArray(env.next_actions)).toBe(true);
    expect((env.next_actions as string[]).some((a) => a.includes('rk create sprint'))).toBe(true);
  });

  it('rk create sprint --enqueue --json sets status=queued and adds queue slot', async () => {
    const cwd = await makeProject();
    const epic = await runCreateEpicCommand('e', { cwd, json: true });
    const epicId = (JSON.parse(epic.stdout) as { id: string }).id;
    const queue = await runCreateQueueCommand({ cwd, lane: 'main', json: true });
    expect(queue.exitCode).toBe(0);

    const sprint = await runCreateSprintCommand('Parse OAuth callback', {
      cwd,
      epic: epicId,
      lane: 'main',
      status: 'planned',
      enqueue: true,
      json: true,
    });
    expect(sprint.exitCode).toBe(0);
    const env = JSON.parse(sprint.stdout) as Record<string, unknown>;
    expect(env.kind).toBe('sprint');
    expect(env.id).toMatch(/^S-\d{3}$/);
    expect((env.updated as string[]).some((u) => u.includes('queues/main.md'))).toBe(true);
    expect((env.next_actions as string[])[0]).toMatch(/^rk start /);

    // Sprint frontmatter has status=queued and the queue file holds a slot.
    const sprintRaw = await readFile(join(cwd, env.file as string), 'utf8');
    const sprintFm = matter(sprintRaw).data as { status?: string };
    expect(sprintFm.status).toBe('queued');

    const queueRaw = await readFile(join(cwd, 'queues/main.md'), 'utf8');
    const queueFm = matter(queueRaw).data as {
      slots: Array<{ id: string; sprint_id: string }>;
    };
    expect(queueFm.slots.some((s) => s.sprint_id === env.id)).toBe(true);
  });

  it('rk create sprint --enqueue without a queue file errors with EXIT_BLOCKED', async () => {
    const cwd = await makeProject();
    const epic = await runCreateEpicCommand('e', { cwd, json: true });
    const epicId = (JSON.parse(epic.stdout) as { id: string }).id;

    const sprint = await runCreateSprintCommand('Will fail', {
      cwd,
      epic: epicId,
      lane: 'main',
      status: 'planned',
      enqueue: true,
      json: true,
    });
    expect(sprint.exitCode).toBe(1);
    expect(sprint.stderr).toMatch(/--enqueue requires a queue file/);
  });

  it('rk create queue --json emits { kind: queue, id: <lane>, ... }', async () => {
    const cwd = await makeProject();
    const r = await runCreateQueueCommand({ cwd, lane: 'main', json: true });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(env.kind).toBe('queue');
    expect(env.id).toBe('main');
    expect(env.file).toMatch(/queues\/main\.md$/);
  });

  it('rk create review --json emits review envelope with verdict next_action', async () => {
    const cwd = await makeProject();
    const epic = await runCreateEpicCommand('e', { cwd, json: true });
    const epicId = (JSON.parse(epic.stdout) as { id: string }).id;
    const sprint = await runCreateSprintCommand('S', {
      cwd,
      epic: epicId,
      lane: 'main',
      status: 'planned',
      json: true,
    });
    const sprintId = (JSON.parse(sprint.stdout) as { id: string }).id;
    const r = await runCreateReviewCommand({
      cwd,
      sprint: sprintId,
      reviewer: 'agent',
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(env.kind).toBe('review');
    expect(env.id).toMatch(/^R-\d{3}$/);
    const actions = env.next_actions as string[];
    expect(actions.some((a) => a.includes('accepted'))).toBe(true);
    // Skill body uses 'accepted' (PR8 finding 16) — never 'approved'.
    expect(actions.every((a) => !a.includes('approved'))).toBe(true);
  });
});

describe('rk create keeps the registry in sync', () => {
  it('leaves no registry drift after creating an epic', async () => {
    const cwd = await makeProject();
    const epic = await runCreateEpicCommand('Reg epic', { cwd, json: true });
    expect(epic.exitCode).toBe(0);
    const check = await runRegistryCommand({ cwd, write: false, check: true, json: true });
    expect(check.exitCode).toBe(0);
  });

  it('leaves no registry drift after creating a sprint', async () => {
    const cwd = await makeProject();
    const epicId = (
      JSON.parse((await runCreateEpicCommand('e', { cwd, json: true })).stdout) as {
        id: string;
      }
    ).id;
    const sprint = await runCreateSprintCommand('Reg sprint', {
      cwd,
      epic: epicId,
      lane: 'main',
      status: 'planned',
      json: true,
    });
    expect(sprint.exitCode).toBe(0);
    const check = await runRegistryCommand({ cwd, write: false, check: true, json: true });
    expect(check.exitCode).toBe(0);
  });

  it('leaves no registry drift after a burst of sprint creates', async () => {
    const cwd = await makeProject();
    const epicId = (
      JSON.parse((await runCreateEpicCommand('e', { cwd, json: true })).stdout) as {
        id: string;
      }
    ).id;
    for (const title of ['One', 'Two', 'Three']) {
      const r = await runCreateSprintCommand(title, {
        cwd,
        epic: epicId,
        lane: 'main',
        status: 'planned',
        json: true,
      });
      expect(r.exitCode).toBe(0);
    }
    const check = await runRegistryCommand({ cwd, write: false, check: true, json: true });
    expect(check.exitCode).toBe(0);
  });
});
