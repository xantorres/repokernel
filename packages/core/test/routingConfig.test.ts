import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, loadConfig } from '../src/index.js';

const tracked: string[] = [];
afterAll(async () => {
  await Promise.all(tracked.map((d) => rm(d, { recursive: true, force: true })));
  tracked.length = 0;
});

const BASE = `schemaVersion: 1
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

async function makeRepo(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repokernel-routing-cfg-'));
  tracked.push(dir);
  await writeFile(join(dir, CONFIG_FILENAME), yaml, 'utf8');
  return dir;
}

interface ConfigInvalidIssue {
  readonly path?: readonly (string | number)[];
  readonly message?: string;
}

function issuesText(data: unknown): string {
  if (data && typeof data === 'object' && 'issues' in data) {
    return JSON.stringify((data as { issues: ConfigInvalidIssue[] }).issues);
  }
  return '';
}

describe('config — routing policy validation', () => {
  it('absent routing block defaults to [light, standard, heavy] with no rules', async () => {
    const cwd = await makeRepo(BASE);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.routing.tiers).toEqual(['light', 'standard', 'heavy']);
      expect(r.config.routing.rules).toEqual([]);
    }
  });

  it('rejects tiers with length 1', async () => {
    const cwd = await makeRepo(`${BASE}routing:\n  tiers: [solo]\n`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate tier names', async () => {
    const cwd = await makeRepo(`${BASE}routing:\n  tiers: [a, a, b]\n`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(issuesText(r.finding.data)).toMatch(/unique/i);
    }
  });

  it('rejects tier list larger than 8', async () => {
    const cwd = await makeRepo(`${BASE}routing:\n  tiers: [t1, t2, t3, t4, t5, t6, t7, t8, t9]\n`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
  });

  it('rejects tier name with invalid characters', async () => {
    const cwd = await makeRepo(`${BASE}routing:\n  tiers: ["1bad", standard]\n`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
  });

  it('rejects custom tier configurations that are valid (sanity)', async () => {
    const cwd = await makeRepo(`${BASE}routing:\n  tiers: [cheap, mid, expensive]\n`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.routing.tiers).toEqual(['cheap', 'mid', 'expensive']);
    }
  });

  it('rejects rule then.tier not in tier set', async () => {
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: bad
      when: { profile: implement }
      then: { tier: phantom }
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(issuesText(r.finding.data)).toContain('phantom');
    }
  });

  it('rejects rule fanout entry with unknown tier', async () => {
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: badfan
      when: { profile: review }
      then:
        tier: standard
        fanout:
          - { id: bad, tier: missing }
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(issuesText(r.finding.data)).toContain('missing');
    }
  });

  it('rejects unknown when signal', async () => {
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: bad
      when: { mystery_signal: 1 }
      then: { tier: light }
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(issuesText(r.finding.data)).toMatch(/unknown when signal/);
    }
  });

  it('rejects unknown operator suffix', async () => {
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: bad
      when: { est_tokens_eq: 1000 }
      then: { tier: light }
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(issuesText(r.finding.data)).toContain('drop \\"_eq\\"');
    }
  });

  it('rejects more than 16 rules', async () => {
    const rules = Array.from(
      { length: 17 },
      (_, i) => `    - id: r${i}
      when: { profile: implement }
      then: { tier: light }`,
    ).join('\n');
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
${rules}
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
  });

  it('rejects more than 8 fanout entries in a single rule', async () => {
    const fanout = Array.from(
      { length: 9 },
      (_, i) => `          - { id: f${i}, tier: light }`,
    ).join('\n');
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: panel
      when: { profile: review }
      then:
        tier: standard
        fanout:
${fanout}
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate rule ids', async () => {
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: dup
      when: { profile: implement }
      then: { tier: light }
    - id: dup
      when: { profile: review }
      then: { tier: standard }
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(issuesText(r.finding.data)).toContain('duplicate routing rule');
    }
  });

  it('accepts a valid policy with rules + fanout', async () => {
    const cwd = await makeRepo(`${BASE}routing:
  tiers: [light, standard, heavy]
  rules:
    - id: small
      when:
        est_tokens_lt: 3000
        ac_count_lte: 3
        review_required: false
      then: { tier: light }
    - id: panel
      when: { profile: review, ac_count_gte: 5 }
      then:
        tier: standard
        fanout:
          - { id: fast, tier: light }
          - { id: deep, tier: standard }
`);
    const r = await loadConfig({ cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.routing.rules).toHaveLength(2);
      expect(r.config.routing.rules[0]?.id).toBe('small');
      expect(r.config.routing.rules[1]?.then.fanout).toEqual([
        { id: 'fast', tier: 'light' },
        { id: 'deep', tier: 'standard' },
      ]);
    }
  });
});
