import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { collectCsvOption, collectOption } from '../src/util/program.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);
const RK_BIN = resolve(__dirname, '..', 'dist', 'index.js');

afterAll(cleanupAllFixtures);

async function projectWithEpic(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'demo', status: 'active', sprints: [] }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

async function createSprintViaBinary(
  cwd: string,
  flag: string,
  value: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    'node',
    [
      RK_BIN,
      'create',
      'sprint',
      'Glob sprint',
      '--epic',
      'E-001',
      flag,
      value,
      '--cwd',
      cwd,
      '--json',
    ],
    { env: { ...process.env, NO_COLOR: '1' } },
  );
  const env = JSON.parse(stdout) as Record<string, unknown>;
  const raw = await readFile(join(cwd, env.file as string), 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

// The brace-glob split bug lives entirely in the Commander option-parsing
// layer (collectCsvOption). Calling the command function directly with
// pre-built arrays cannot catch it, so these tests must drive the compiled
// binary end-to-end.
describe('path-glob options preserve brace globs through the CLI', () => {
  it('--allowed-path keeps a brace glob as one entry', async () => {
    const cwd = await projectWithEpic();
    const fmData = await createSprintViaBinary(cwd, '--allowed-path', 'apps/web/{routes,shell}/**');
    expect(fmData.allowed_paths).toEqual(['apps/web/{routes,shell}/**']);
  });

  it('--denied-path keeps a brace glob as one entry', async () => {
    const cwd = await projectWithEpic();
    const fmData = await createSprintViaBinary(cwd, '--denied-path', 'packages/{a,b}/dist/**');
    expect(fmData.denied_paths).toEqual(['packages/{a,b}/dist/**']);
  });
});

// Pin the collector contract directly so a future refactor cannot silently
// re-route a path/free-text option back onto the comma-splitting collector.
describe('option collectors', () => {
  it('collectOption keeps commas literal (one value per flag)', () => {
    expect(collectOption('apps/web/{routes,shell}/**', [])).toEqual(['apps/web/{routes,shell}/**']);
    expect(collectOption('latency < 100ms, P99', [])).toEqual(['latency < 100ms, P99']);
    expect(collectOption('b', ['a'])).toEqual(['a', 'b']);
  });

  it('collectCsvOption splits on commas (reserved for ID/list flags)', () => {
    expect(collectCsvOption('S-001,S-002', [])).toEqual(['S-001', 'S-002']);
  });
});
