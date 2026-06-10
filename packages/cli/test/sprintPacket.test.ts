import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Epic, Run, Sprint } from '@repokernel/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateSprintPacket,
  loadPrevSummaries,
  writeSprintPacket,
  writeSummary,
} from '../src/lifecycle/sprintPacket.js';
import { eid, runId, sid } from './helpers/brand.js';

let opRoot: string;

beforeEach(async () => {
  opRoot = await mkdtemp(join(tmpdir(), 'rk-packet-'));
});

afterAll(async () => {
  // individual dirs cleaned by beforeEach creating new ones — last one left over is fine
});

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: runId('RUN-001'),
    epic_id: eid('E-001'),
    lane: 'main',
    status: 'running',
    mode: 'assisted',
    agent: 'manual',
    worktree: '/tmp/wt/E-001',
    branch: 'rk/epic/E-001',
    started_at: '2026-04-25T10:00:00Z',
    ended_at: null,
    current_sprint: sid('S-001'),
    completed_sprints: [],
    halt_reason: null,
    limit: 3,
    sprint_count: 0,
    execution_strategy: 'sequential',
    wave_index: -1,
    active_sprints: [],
    parallel_workers: [],
    abort_requested: false,
    ...overrides,
  };
}

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: sid('S-001'),
    epic_id: eid('E-001'),
    title: 'Bootstrap parser',
    status: 'active',
    lane: 'main',
    body: 'Implement the core token parser.',
    allowed_paths: [],
    denied_paths: [],
    depends_on: [],
    blocked_by: [],
    generated_paths: [],
    review_required: false,
    base_sha: 'deadbeef1234567',
    adr_links: [],
    extras: {},
    file: '.repokernel/plan/sprints/S-001.md',
    ...overrides,
  };
}

function makeEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: eid('E-001'),
    title: 'Parser Foundation',
    status: 'active',
    sprints: [sid('S-001')],
    adr_links: [],
    extras: {},
    body: '',
    file: '.repokernel/plan/epics/E-001.md',
    ...overrides,
  };
}

describe('generateSprintPacket', () => {
  it('includes run context section', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    expect(packet).toContain('RUN-001');
    expect(packet).toContain('E-001');
    expect(packet).toContain('S-001');
    expect(packet).toContain('assisted');
    expect(packet).toContain('manual');
    expect(packet).toContain('main');
  });

  it('includes sprint body when present', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    expect(packet).toContain('Implement the core token parser.');
  });

  it('omits sprint details section when body is empty', () => {
    const sprint = makeSprint({ body: '' });
    const packet = generateSprintPacket(makeRun(), sprint, makeEpic(), []);
    expect(packet).not.toContain('## Sprint Details');
  });

  it('includes allowed_paths when present', () => {
    const sprint = makeSprint({ allowed_paths: ['src/parser/**', 'test/parser/**'] });
    const packet = generateSprintPacket(makeRun(), sprint, makeEpic(), []);
    expect(packet).toContain('## Allowed Paths');
    expect(packet).toContain('`src/parser/**`');
    expect(packet).toContain('`test/parser/**`');
  });

  it('omits allowed_paths section when empty', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    expect(packet).not.toContain('## Allowed Paths');
  });

  it('includes denied_paths when present', () => {
    const sprint = makeSprint({ denied_paths: ['secrets/**'] });
    const packet = generateSprintPacket(makeRun(), sprint, makeEpic(), []);
    expect(packet).toContain('## Denied Paths');
    expect(packet).toContain('`secrets/**`');
  });

  it('includes dependencies when present', () => {
    const sprint = makeSprint({ depends_on: [sid('S-000')] });
    const packet = generateSprintPacket(makeRun(), sprint, makeEpic(), []);
    expect(packet).toContain('## Dependencies');
    expect(packet).toContain('S-000');
  });

  it('omits dependencies section when empty', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    expect(packet).not.toContain('## Dependencies');
  });

  it('includes previous summaries when provided', () => {
    const summaries = ['### S-000 (accepted)\n\nFixed the tokenizer.'];
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), summaries);
    expect(packet).toContain('## Previous Sprint Summaries');
    expect(packet).toContain('Fixed the tokenizer.');
  });

  it('omits summaries section when none', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    expect(packet).not.toContain('## Previous Sprint Summaries');
  });

  it('includes output contract with sentinels', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    expect(packet).toContain('REPOKERNEL_RESULT_START');
    expect(packet).toContain('REPOKERNEL_RESULT_END');
    expect(packet).toContain('"status"');
    expect(packet).toContain('"summary"');
    expect(packet).toContain('"changed_files"');
    expect(packet).toContain('"needs_human"');
  });

  it('includes rk close instruction in autonomous mode', () => {
    const run = makeRun({ mode: 'autonomous' });
    const packet = generateSprintPacket(run, makeSprint(), makeEpic(), []);
    expect(packet).toContain('rk close');
  });

  it('omits rk close instruction in assisted mode', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    const closeIndex = packet.indexOf('rk close');
    expect(closeIndex).toBe(-1);
  });

  it('includes stop conditions', () => {
    const packet = generateSprintPacket(makeRun(), makeSprint(), makeEpic(), []);
    expect(packet).toContain('## Stop Conditions');
    expect(packet).toContain('P0/P1');
    expect(packet).toContain('denied_paths');
  });
});

describe('writeSprintPacket', () => {
  it('writes packet to opRoot/runs/RUN-NNN/sprint-packets/S-NNN.md', async () => {
    const run = makeRun();
    const sprint = makeSprint();
    const content = 'test content';
    const path = await writeSprintPacket(run, sprint, content, opRoot);
    expect(path).toContain('RUN-001');
    expect(path).toContain('S-001.md');
    const written = await readFile(path, 'utf8');
    expect(written).toBe('test content');
  });
});

describe('writeSummary / loadPrevSummaries', () => {
  it('writes and reads back sprint summaries', async () => {
    const run = makeRun({
      completed_sprints: [
        {
          id: sid('S-001'),
          verdict: 'accepted',
          summary_path: 'runs/RUN-001/summaries/S-001.md',
          start_sha: 'deadbeef1234567',
          end_sha: 'cafebabe1234567',
        },
      ],
    });

    await writeSummary(run, makeSprint(), 'Implemented the parser.', opRoot);
    const summaries = await loadPrevSummaries(run, opRoot);
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain('S-001');
    expect(summaries[0]).toContain('accepted');
    expect(summaries[0]).toContain('Implemented the parser.');
  });

  it('returns empty array when run has no completed sprints', async () => {
    const summaries = await loadPrevSummaries(makeRun(), opRoot);
    expect(summaries).toEqual([]);
  });

  it('skips missing summary files gracefully', async () => {
    const run = makeRun({
      completed_sprints: [
        {
          id: sid('S-999'),
          verdict: 'accepted',
          summary_path: 'runs/RUN-001/summaries/S-999.md',
          start_sha: 'deadbeef1234567',
          end_sha: 'cafebabe1234567',
        },
      ],
    });
    const summaries = await loadPrevSummaries(run, opRoot);
    expect(summaries).toEqual([]);
  });
});
