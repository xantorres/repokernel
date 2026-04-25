import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const tracked: string[] = [];

export interface FileSpec {
  readonly path: string;
  readonly content: string;
}

export async function makeFixture(files: readonly FileSpec[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'repokernel-cli-'));
  tracked.push(cwd);
  for (const f of files) {
    const abs = join(cwd, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
  }
  return cwd;
}

export async function cleanupAllFixtures(): Promise<void> {
  await Promise.all(tracked.map((d) => rm(d, { recursive: true, force: true })));
  tracked.length = 0;
}

export function defaultConfigYaml(): string {
  return `schemaVersion: 1
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
    return `\n${v.map((x) => `  - ${inline(x)}`).join('\n')}`;
  }
  return JSON.stringify(v);
}

function inline(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
