import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { runContextCommand } from '../src/commands/context.js';
import { EXIT_OK } from '../src/exitCodes.js';
import { cleanupAllFixtures, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);

afterAll(cleanupAllFixtures);

async function gitInit(cwd: string): Promise<void> {
  await execFileAsync('git', ['-C', cwd, 'init', '-q']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@test.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'test']);
  await execFileAsync('git', ['-C', cwd, 'add', '.']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-q', '-m', 'init']);
}

const DEFAULT_CONFIG = `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`;

const CONFIG_WITH_RULES = `${DEFAULT_CONFIG}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: small-and-uncritical
      when:
        est_tokens_lt: 3000
        ac_count_lte: 3
        review_required: false
      then:
        tier: light
    - id: review-panel
      when:
        profile: review
        ac_count_gte: 5
      then:
        tier: standard
        fanout:
          - { id: fast, tier: light }
          - { id: deep, tier: standard }
`;

const CONFIG_CUSTOM_TIERS = `${DEFAULT_CONFIG}routing:
  tiers: [cheap, mid, expensive]
`;

const CONFIG_TWO_TIERS = `${DEFAULT_CONFIG}routing:
  tiers: [a, b]
`;

interface SprintFixture {
  readonly title?: string;
  readonly review_required?: boolean;
  readonly extras?: Record<string, unknown>;
  readonly allowed_paths?: string[];
  readonly depends_on?: string[];
  readonly body?: string;
}

async function fixtureWithSprint(configYaml: string, sprint: SprintFixture = {}): Promise<string> {
  const sprintFm: Record<string, unknown> = {
    id: 'S-001',
    title: sprint.title ?? 'Trivial change',
    epic_id: 'E-001',
    status: 'planned',
    lane: 'main',
    allowed_paths: sprint.allowed_paths ?? ['src/foo/index.ts'],
    depends_on: sprint.depends_on ?? [],
    review_required: sprint.review_required ?? false,
  };
  if (sprint.extras) {
    sprintFm.extras = sprint.extras;
  }
  const cwd = await makeFixture([
    { path: 'repokernel.config.yaml', content: configYaml },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Foo', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm(sprintFm, sprint.body ?? '## Acceptance\n\n- one\n'),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    { path: 'src/foo/index.ts', content: 'export const x = 1;\n' },
  ]);
  await gitInit(cwd);
  return cwd;
}

interface RoutingHintShape {
  tier: string;
  tier_set: string[];
  reason: string;
  rule_id?: string;
  fanout?: { id: string; tier: string }[];
  signals: Record<string, unknown>;
  score: number;
}

interface RoutingPayload {
  profile: string;
  target: string;
  routing_hint?: RoutingHintShape;
}

async function runRoute(
  cwd: string,
  target: string,
  profile?: 'implement' | 'review' | 'wave',
): Promise<RoutingPayload> {
  const result = await runContextCommand({
    cwd,
    target,
    format: 'json',
    check: false,
    validate: false,
    withRouting: true,
    routingOnly: true,
    ...(profile !== undefined ? { profile } : {}),
  });
  expect(result.exitCode).toBe(EXIT_OK);
  return JSON.parse(result.stdout) as RoutingPayload;
}

describe('rk context --with-routing', () => {
  it('default config: hint absent without flag', async () => {
    const cwd = await fixtureWithSprint(DEFAULT_CONFIG);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const payload = JSON.parse(result.stdout) as { routing_hint?: unknown };
    expect(payload.routing_hint).toBeUndefined();
  });

  it('default config: includes routing_hint with default tiers when flag passed', async () => {
    const cwd = await fixtureWithSprint(DEFAULT_CONFIG);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
      withRouting: true,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const payload = JSON.parse(result.stdout) as { routing_hint?: RoutingHintShape };
    expect(payload.routing_hint).toBeDefined();
    expect(payload.routing_hint?.tier_set).toEqual(['light', 'standard', 'heavy']);
    expect(['light', 'standard', 'heavy']).toContain(payload.routing_hint?.tier);
  });

  it('markdown format renders routing fenced block', async () => {
    const cwd = await fixtureWithSprint(DEFAULT_CONFIG);
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'md',
      check: false,
      validate: false,
      withRouting: true,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain('## Routing');
    expect(result.stdout).toMatch(/```json[\s\S]+"tier":/);
  });
});

describe('rk route — routing-only output', () => {
  it('matches small-and-uncritical rule', async () => {
    const cwd = await fixtureWithSprint(CONFIG_WITH_RULES, {
      review_required: false,
      body: '## Acceptance\n\n- only AC\n',
    });
    const payload = await runRoute(cwd, 'S-001');
    expect(payload.routing_hint?.tier).toBe('light');
    expect(payload.routing_hint?.reason).toBe('rule');
    expect(payload.routing_hint?.rule_id).toBe('small-and-uncritical');
  });

  it('emits fanout when review-panel rule fires', async () => {
    const cwd = await fixtureWithSprint(CONFIG_WITH_RULES, {
      review_required: true,
      body: '## Acceptance\n\n- one\n- two\n- three\n- four\n- five\n- six\n',
    });
    const payload = await runRoute(cwd, 'S-001', 'review');
    expect(payload.routing_hint?.tier).toBe('standard');
    expect(payload.routing_hint?.rule_id).toBe('review-panel');
    expect(payload.routing_hint?.fanout).toEqual([
      { id: 'fast', tier: 'light' },
      { id: 'deep', tier: 'standard' },
    ]);
  });

  it('honors extras.routing.pin_tier as hard override', async () => {
    const cwd = await fixtureWithSprint(CONFIG_WITH_RULES, {
      extras: { routing: { pin_tier: 'heavy' } },
    });
    const payload = await runRoute(cwd, 'S-001');
    expect(payload.routing_hint?.tier).toBe('heavy');
    expect(payload.routing_hint?.reason).toBe('pinned');
  });

  it('falls back to scoring when pin_tier is unknown (with routing P2 finding)', async () => {
    const cwd = await fixtureWithSprint(CONFIG_WITH_RULES, {
      extras: { routing: { pin_tier: 'phantom' } },
    });
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
      withRouting: true,
      routingOnly: true,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    const payload = JSON.parse(result.stdout) as RoutingPayload;
    expect(payload.routing_hint?.reason).not.toBe('pinned');
    expect(result.stderr).toContain('routing');
  });

  it('maps complexity hint vendor-agnostically (custom tier names)', async () => {
    const cwd = await fixtureWithSprint(CONFIG_CUSTOM_TIERS, {
      extras: { routing: { complexity: 'deep' } },
    });
    const payload = await runRoute(cwd, 'S-001');
    expect(payload.routing_hint?.tier).toBe('expensive');
    expect(payload.routing_hint?.tier_set).toEqual(['cheap', 'mid', 'expensive']);
  });

  it('respects two-tier config in scoring', async () => {
    const cwd = await fixtureWithSprint(CONFIG_TWO_TIERS, {
      review_required: false,
      body: '## Acceptance\n\n- one\n',
    });
    const payload = await runRoute(cwd, 'S-001', 'review');
    expect(payload.routing_hint?.tier_set).toEqual(['a', 'b']);
    expect(payload.routing_hint?.tier).toBe('a');
  });

  it('default config emits no fanout', async () => {
    const cwd = await fixtureWithSprint(DEFAULT_CONFIG, {
      review_required: true,
      body: '## Acceptance\n\n- one\n- two\n- three\n- four\n- five\n- six\n',
    });
    const payload = await runRoute(cwd, 'S-001', 'review');
    expect(payload.routing_hint?.fanout).toBeUndefined();
  });

  it('attaches fanout from extras.routing.fanout', async () => {
    const cwd = await fixtureWithSprint(DEFAULT_CONFIG, {
      extras: {
        routing: {
          fanout: [
            { id: 'a', tier: 'light' },
            { id: 'b', tier: 'standard' },
          ],
        },
      },
    });
    const payload = await runRoute(cwd, 'S-001');
    expect(payload.routing_hint?.fanout).toEqual([
      { id: 'a', tier: 'light' },
      { id: 'b', tier: 'standard' },
    ]);
  });

  it('emits stderr finding on unknown extras.routing key', async () => {
    const cwd = await fixtureWithSprint(DEFAULT_CONFIG, {
      extras: { routing: { unknown_key: 'oops' } },
    });
    const result = await runContextCommand({
      cwd,
      target: 'S-001',
      format: 'json',
      check: false,
      validate: false,
      withRouting: true,
      routingOnly: true,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stderr).toContain('routing');
    expect(result.stderr).toContain('unknown_key');
  });
});
