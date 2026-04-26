import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRunner, SprintRunInput, SprintRunResult } from './types.js';

const execFileAsync = promisify(execFile);

function resolveGlobBase(pattern: string): string {
  const segments = pattern.split('/');
  const safe: string[] = [];
  for (const seg of segments) {
    if (seg.includes('*') || seg.includes('?') || seg.includes('{') || seg.includes('[')) break;
    safe.push(seg);
  }
  return safe.join('/') || '.';
}

function parseAllowedPaths(packetMarkdown: string): string[] {
  const match = packetMarkdown.match(/^## Allowed Paths\s*\n((?:- `[^\n]+`\n?)*)/m);
  if (!match?.[1]) return [];
  return match[1]
    .split('\n')
    .map((line) => line.match(/^- `([^`]+)`$/)?.[1] ?? '')
    .filter(Boolean);
}

export class FakeRunner implements AgentRunner {
  readonly name = 'fake';

  async runSprint(input: SprintRunInput): Promise<SprintRunResult> {
    let packetContent = '';
    try {
      packetContent = await readFile(input.sprint_packet_path, 'utf8');
    } catch {
      // packet missing — proceed with no allowed paths
    }

    const allowedPaths = parseAllowedPaths(packetContent);
    const firstPath = resolveGlobBase(allowedPaths[0] ?? 'fake-output');
    const targetDir = join(input.worktree, firstPath);

    await mkdir(targetDir, { recursive: true });

    const outputFile = join(targetDir, `repokernel-fake-${input.sprint_id}.txt`);
    const relativeFile = join(firstPath, `repokernel-fake-${input.sprint_id}.txt`);

    await writeFile(
      outputFile,
      `fake implementation for sprint ${input.sprint_id}\nrun: ${input.run_id}\n`,
      'utf8',
    );

    await execFileAsync('git', ['-C', input.worktree, 'add', outputFile]);
    await execFileAsync('git', [
      '-C',
      input.worktree,
      'commit',
      '-m',
      `feat(${input.sprint_id}): fake implementation`,
    ]);

    return {
      status: 'completed',
      summary: `Fake agent: ${input.sprint_id}`,
      changed_files: [relativeFile],
      needs_human: input.mode === 'assisted',
      ...(input.mode === 'autonomous' && { review: { verdict: 'accepted', findings: [] } }),
    };
  }
}
