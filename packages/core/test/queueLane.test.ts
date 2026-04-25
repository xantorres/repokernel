import { afterAll, describe, expect, it } from 'vitest';
import { validateProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface FileSpec {
  path: string;
  content: string;
}

async function setup(files: FileSpec[]) {
  const fixture = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ...files,
  ]);
  return validateProject({ cwd: fixture.cwd });
}

describe('MULTIPLE_QUEUE_FILES_FOR_LANE', () => {
  it('flags two queue files claiming the same lane as P1', async () => {
    const r = await setup([
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: 'queues/main-other.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const f = r.findings.find((x) => x.code === 'MULTIPLE_QUEUE_FILES_FOR_LANE');
    expect(f?.severity).toBe('P1');
    expect(f?.data?.files).toBeDefined();
  });
});

describe('QUEUE_FILE_LANE_MISMATCH', () => {
  it('flags when filename stem does not equal lane field as P3', async () => {
    const r = await setup([{ path: 'queues/foo.md', content: fm({ lane: 'main', slots: [] }) }]);
    const f = r.findings.find((x) => x.code === 'QUEUE_FILE_LANE_MISMATCH');
    expect(f?.severity).toBe('P3');
  });

  it('does not flag when filename matches lane', async () => {
    const r = await setup([{ path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) }]);
    expect(r.findings.some((f) => f.code === 'QUEUE_FILE_LANE_MISMATCH')).toBe(false);
  });
});

describe('QUEUE_SLOT_ORDER_GAP', () => {
  it('flags non-contiguous orders as P3', async () => {
    const r = await setup([
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [
            { id: 'Q-001', sprint_id: 'S-001', order: 0 },
            { id: 'Q-002', sprint_id: 'S-002', order: 5 },
          ],
        }),
      },
    ]);
    const f = r.findings.find((x) => x.code === 'QUEUE_SLOT_ORDER_GAP');
    expect(f?.severity).toBe('P3');
  });

  it('does not flag contiguous orders starting at 0', async () => {
    const r = await setup([
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
    expect(r.findings.some((f) => f.code === 'QUEUE_SLOT_ORDER_GAP')).toBe(false);
  });
});
