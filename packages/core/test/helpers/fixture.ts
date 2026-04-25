import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

export interface Fixture {
  readonly cwd: string;
  cleanup(): Promise<void>;
}

const tracked: string[] = [];

export async function makeFixture(files: readonly FixtureFile[]): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), 'repokernel-fix-'));
  tracked.push(cwd);
  for (const f of files) {
    const abs = join(cwd, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
  }
  return {
    cwd,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

export async function cleanupAllFixtures(): Promise<void> {
  await Promise.all(tracked.map((d) => rm(d, { recursive: true, force: true })));
  tracked.length = 0;
}

export function defaultConfigYaml(extra: Partial<Record<string, string>> = {}): string {
  return `schemaVersion: 1
projectId: ${extra['projectId'] ?? 'demo'}
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
}

export function fm(data: Record<string, unknown>, body = ''): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${k}: ${formatYamlValue(v)}`);
  }
  lines.push('---', body);
  return lines.join('\n');
}

function formatYamlValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '\n' + v.map((x) => `  - ${formatYamlValueInline(x)}`).join('\n');
  }
  return JSON.stringify(v);
}

function formatYamlValueInline(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Objects and nested arrays use YAML flow syntax (a JSON subset that YAML accepts).
  return JSON.stringify(v);
}
