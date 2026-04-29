import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  canonicalJson,
  type Epic,
  type Finding,
  type LoadProjectOutcome,
  loadProject,
  resolveNextRunnableSprint,
  runValidators,
  type Sprint,
} from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export interface ReportCommandOptions {
  readonly cwd: string;
  readonly out?: string;
  readonly json?: boolean;
}

export async function runReportCommand(opts: ReportCommandOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const out = resolve(cwd, opts.out ?? '.repokernel/report.html');

  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${message}\n` };
  }
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `cannot build report: ${outcome.findings[0]?.message ?? 'project failed to load'}\n`,
    };
  }

  const findings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
  });
  const html = renderReportHtml(outcome, findings);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html, 'utf8');

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${canonicalJson({ report: { path: out } })}\n`,
      stderr: '',
    };
  }

  return {
    exitCode: EXIT_OK,
    stdout: `Report written: ${out}\n`,
    stderr: '',
  };
}

function renderReportHtml(outcome: LoadedProject, findings: readonly Finding[]): string {
  const epics = [...outcome.graph.epics.values()].sort(byId);
  const sprints = [...outcome.graph.sprints.values()].sort(byId);
  const next = resolveNextRunnableSprint(outcome.graph, outcome.config, findings);
  const counts = countByStatus(sprints);
  const maxSeverity = ['P0', 'P1', 'P2', 'P3'].find((sev) =>
    findings.some((f) => f.severity === sev),
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RepoKernel Report</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f7f4; --fg: #1d2428; --muted: #657177; --line: #d8ddd7; --panel: #ffffff; --accent: #237c71; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111715; --fg: #eef4ef; --muted: #9aa9a4; --line: #2b3934; --panel: #18211e; --accent: #66c7b8; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; border-bottom: 1px solid var(--line); padding-bottom: 20px; }
    h1, h2 { margin: 0; line-height: 1.15; }
    h1 { font-size: 30px; }
    h2 { font-size: 18px; margin-top: 28px; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; background: var(--panel); border: 1px solid var(--line); }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; color: var(--muted); letter-spacing: .04em; }
    tr:last-child td { border-bottom: 0; }
    .pill { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; color: var(--accent); }
    @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } header { display: block; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>RepoKernel Report</h1>
        <div class="muted">${h(outcome.config.projectName)} (${h(outcome.config.projectId)})</div>
      </div>
      <div class="muted">${h(new Date().toISOString())}</div>
    </header>

    <section class="grid" aria-label="Summary">
      ${metric('Epics', epics.length)}
      ${metric('Sprints', sprints.length)}
      ${metric('Active', counts.active ?? 0)}
      ${metric('Findings', findings.length, maxSeverity ? `max ${maxSeverity}` : 'clean')}
    </section>

    <h2>Next Work</h2>
    <table>
      <tbody>
        <tr><th>Result</th><td>${h(next.result)}</td></tr>
        <tr><th>Sprint</th><td>${next.sprintId ? h(next.sprintId) : 'None'}</td></tr>
        <tr><th>Lane</th><td>${h(next.lane)}</td></tr>
      </tbody>
    </table>

    <h2>Epics</h2>
    ${table(
      ['ID', 'Title', 'Status', 'Sprints'],
      epics.map((e) => [e.id, e.title, e.status, String(e.sprints.length)]),
    )}

    <h2>Sprints</h2>
    ${table(
      ['ID', 'Title', 'Status', 'Lane', 'Epic'],
      sprints.map((s) => [s.id, s.title, s.status, s.lane, s.epic_id]),
    )}

    <h2>Findings</h2>
    ${
      findings.length === 0
        ? '<p class="muted">No validation findings.</p>'
        : table(
            ['Severity', 'Code', 'Entity', 'Message'],
            findings.map((f) => [f.severity, f.code, f.entityId ?? '', f.message]),
          )
    }
  </main>
</body>
</html>
`;
}

type LoadedProject = Extract<LoadProjectOutcome, { ok: true }>;

function countByStatus(sprints: readonly Sprint[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sprint of sprints) counts[sprint.status] = (counts[sprint.status] ?? 0) + 1;
  return counts;
}

function metric(label: string, value: number, sub = ''): string {
  return `<div class="metric"><span class="muted">${h(label)}</span><strong>${value}</strong><span class="muted">${h(sub)}</span></div>`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return `<table><thead><tr>${headers.map((x) => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((x, i) => `<td>${i === 2 ? `<span class="pill">${h(x)}</span>` : h(x)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
}

function byId<T extends Epic | Sprint>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function h(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
