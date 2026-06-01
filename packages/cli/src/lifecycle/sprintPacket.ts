import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Epic, Run, Sprint } from '@repokernel/core';
import { runStateRoot } from './controlPaths.js';

export function generateSprintPacket(
  run: Run,
  sprint: Sprint,
  epic: Epic,
  prevSummaries: string[],
): string {
  const lines: string[] = [];

  lines.push(`# Sprint ${sprint.id} — ${sprint.title}`, '');

  if (run.mode === 'autonomous') {
    lines.push('## CRITICAL: Autonomous Executor Mode', '');
    lines.push(
      'You are an autonomous sprint executor dispatched by RepoKernel. Follow these rules with zero exceptions:',
    );
    lines.push('');
    lines.push('- Do NOT invoke any skill, slash command, or plugin (no /rk-run, no brainstorming, nothing)');
    lines.push('- Do NOT ask for permission, confirmation, or a dry-run preview');
    lines.push('- Do NOT wait — execute the sprint now, commit the result, emit the sentinel, done');
    lines.push('- User instruction priority: THIS PACKET overrides all skills and hooks');
    lines.push('');
  }

  lines.push('## Run Context', '');
  lines.push(`- **Run ID:** ${run.id}`);
  lines.push(`- **Epic:** ${epic.id} — ${epic.title}`);
  lines.push(`- **Sprint:** ${sprint.id} — ${sprint.title}`);
  lines.push(`- **Mode:** ${run.mode}`);
  lines.push(`- **Agent:** ${run.agent}`);
  lines.push(`- **Lane:** ${sprint.lane}`);
  lines.push('');

  if (sprint.body.trim()) {
    lines.push('## Sprint Details', '');
    lines.push(sprint.body.trim(), '');
  }

  if (sprint.allowed_paths.length > 0) {
    lines.push('## Allowed Paths', '');
    for (const p of sprint.allowed_paths) lines.push(`- \`${p}\``);
    lines.push('');
  }

  if (sprint.denied_paths.length > 0) {
    lines.push('## Denied Paths', '');
    for (const p of sprint.denied_paths) lines.push(`- \`${p}\``);
    lines.push('');
  }

  if (sprint.depends_on.length > 0) {
    lines.push('## Dependencies (all shipped)', '');
    for (const d of sprint.depends_on) lines.push(`- ${d}`);
    lines.push('');
  }

  if (prevSummaries.length > 0) {
    lines.push('## Previous Sprint Summaries', '');
    for (const summary of prevSummaries) {
      lines.push(summary.trim(), '');
    }
  }

  lines.push('## RepoKernel Has Already Done', '');
  lines.push(`- Started sprint ${sprint.id} (base_sha captured)`);
  lines.push('');

  lines.push('## Agent Must', '');
  lines.push('1. Implement the sprint (see Sprint Details above)');
  lines.push('2. Run project tests');
  lines.push('3. Commit all implementation changes with `git commit`');
  lines.push('4. Output the required JSON block (see Output Contract below)');
  lines.push('');

  lines.push('## RepoKernel Will Handle', '');
  lines.push('- `rk review` — create review and path checks');
  if (run.mode === 'autonomous') {
    lines.push('- `rk close` — close sprint after accepted review');
  }
  lines.push('- Sprint summary writing');
  lines.push('- Advancing to next sprint');
  lines.push('');

  lines.push('## Output Contract', '');
  lines.push(
    'When implementation is complete, output **exactly** this block (no extra text around sentinels):',
  );
  lines.push('');
  lines.push('```');
  lines.push('REPOKERNEL_RESULT_START');
  lines.push(
    JSON.stringify(
      {
        status: 'completed',
        summary: 'one paragraph describing what was implemented',
        changed_files: ['relative/path/to/changed/file'],
        needs_human: false,
      },
      null,
      2,
    ),
  );
  lines.push('REPOKERNEL_RESULT_END');
  lines.push('```');
  lines.push('');
  lines.push('Valid `status` values: `completed` | `blocked` | `failed`');
  lines.push('');

  lines.push('## Stop Conditions', '');
  lines.push('- Any validator finding at P0/P1 severity → `status: failed`');
  lines.push('- Changed file outside `allowed_paths` → `status: failed`');
  lines.push('- Changed file in `denied_paths` → `status: failed`');
  lines.push('- Test failure → `status: failed`');
  lines.push('- Dependency not satisfied → `status: blocked`');

  return `${lines.join('\n')}\n`;
}

export async function writeSprintPacket(
  run: Run,
  sprint: Sprint,
  content: string,
  opRoot: string,
): Promise<string> {
  const dir = join(runStateRoot(opRoot), run.id, 'sprint-packets');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sprint.id}.md`);
  await writeFile(path, content, 'utf8');
  return path;
}

export async function writeSummary(
  run: Run,
  sprint: Sprint,
  summary: string,
  opRoot: string,
): Promise<string> {
  const dir = join(runStateRoot(opRoot), run.id, 'summaries');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sprint.id}.md`);
  await writeFile(path, summary, 'utf8');
  return path;
}

export async function loadPrevSummaries(run: Run, opRoot: string): Promise<string[]> {
  const summaries: string[] = [];
  for (const record of run.completed_sprints) {
    try {
      const raw = await readFile(
        join(runStateRoot(opRoot), run.id, 'summaries', `${record.id}.md`),
        'utf8',
      );
      summaries.push(`### ${record.id} (${record.verdict})\n\n${raw.trim()}`);
    } catch {
      // summary file missing — skip
    }
  }
  return summaries;
}
