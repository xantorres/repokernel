import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig } from '@repokernel/core';
import { afterAll, describe, expect, it } from 'vitest';
import { applyWarningBaseline, fingerprintFinding } from '../src/lifecycle/warningBaseline.js';
import { cleanupAllFixtures, defaultConfigYaml, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const P2_FINDING = {
  code: 'DEMO_WARNING',
  severity: 'P2' as const,
  message: 'a warning to baseline',
  file: 'src/app.ts',
  entityId: 'S-001',
};

async function projectWithBaseline(expires: string | null): Promise<{
  cwd: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
}> {
  const cwd = await makeFixture([{ path: 'repokernel.config.yaml', content: defaultConfigYaml() }]);
  const loaded = await loadConfig({ cwd });
  if (!loaded.ok) throw new Error('fixture config failed to load');
  const fingerprint = fingerprintFinding({
    code: P2_FINDING.code,
    file: P2_FINDING.file,
    entityId: P2_FINDING.entityId,
    message: P2_FINDING.message,
  });
  const baseline = {
    schemaVersion: 1,
    owner: 'team-x',
    expires,
    captured_at: '2026-05-20T00:00:00.000Z',
    warnings: [
      {
        fingerprint,
        code: P2_FINDING.code,
        severity: 'P2',
        file: P2_FINDING.file,
        entity_id: P2_FINDING.entityId,
        message: P2_FINDING.message,
      },
    ],
  };
  const baselinePath = join(cwd, loaded.config.paths.generated, 'warnings-baseline.json');
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return { cwd, config: loaded };
}

describe('warning baseline expiry', () => {
  it('an unexpired baseline suppresses the matching P2 finding', async () => {
    const { cwd, config } = await projectWithBaseline('2099-12-31');
    if (!config.ok) throw new Error('config not ok');
    const { findingsForExit, application } = await applyWarningBaseline({
      cwd,
      config: config.config,
      findings: [P2_FINDING as never],
      now: new Date('2026-05-21T12:00:00.000Z'),
    });
    expect(findingsForExit).toHaveLength(0);
    expect(application?.expired).toBe(false);
    expect(application?.active_count).toBe(1);
  });

  it('an expired baseline no longer suppresses — the finding returns to the exit set', async () => {
    const { cwd, config } = await projectWithBaseline('2026-05-20');
    if (!config.ok) throw new Error('config not ok');
    // now is the day AFTER expiry → expired.
    const { findingsForExit, application } = await applyWarningBaseline({
      cwd,
      config: config.config,
      findings: [P2_FINDING as never],
      now: new Date('2026-05-21T00:00:01.000Z'),
    });
    expect(findingsForExit).toHaveLength(1);
    expect(application?.expired).toBe(true);
    expect(application?.expired_count).toBe(1);
    expect(application?.active_count).toBe(0);
  });

  it('a baseline stays active through the whole of its UTC expiry day', async () => {
    const { cwd, config } = await projectWithBaseline('2026-05-21');
    if (!config.ok) throw new Error('config not ok');
    // 23:59 UTC on the expiry date itself → still active.
    const { findingsForExit, application } = await applyWarningBaseline({
      cwd,
      config: config.config,
      findings: [P2_FINDING as never],
      now: new Date('2026-05-21T23:59:59.000Z'),
    });
    expect(findingsForExit).toHaveLength(0);
    expect(application?.expired).toBe(false);
  });
});
