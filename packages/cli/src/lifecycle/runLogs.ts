import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runStateRoot } from './controlPaths.js';
import { StickyRedactor } from './secretScanner.js';

// Per-log-file sticky redactor. Keys on the absolute log path so PEM
// blocks split across `appendLog` calls (one line per call) still get
// fully redacted. Process-local — fine for single-process CLI semantics.
const stickyRedactors = new Map<string, StickyRedactor>();
function getStickyRedactor(path: string): StickyRedactor {
  let r = stickyRedactors.get(path);
  if (!r) {
    r = new StickyRedactor();
    stickyRedactors.set(path, r);
  }
  return r;
}

function logPath(
  opRoot: string,
  runId: string,
  sprintId: string,
  type: 'agent' | 'lifecycle',
): string {
  return join(runStateRoot(opRoot), runId, 'logs', `${sprintId}.${type}.log`);
}

export async function appendLog(
  runId: string,
  sprintId: string,
  type: 'agent' | 'lifecycle',
  line: string,
  opRoot: string,
): Promise<void> {
  const path = logPath(opRoot, runId, sprintId, type);
  await mkdir(join(path, '..'), { recursive: true });
  // Redact any secret-shaped tokens or VAR=secret style assignments
  // before the line lands on disk. The sticky redactor maintains
  // per-log-file state so multi-line PEM bodies are fully scrubbed,
  // not just the BEGIN line.
  const redacted = getStickyRedactor(path).redact(line);
  await appendFile(path, `${redacted}\n`, 'utf8');
}

export async function appendAgentLog(
  runId: string,
  sprintId: string,
  line: string,
  opRoot: string,
): Promise<void> {
  await appendLog(runId, sprintId, 'agent', line, opRoot);
}

export async function appendLifecycleLog(
  runId: string,
  sprintId: string,
  line: string,
  opRoot: string,
): Promise<void> {
  await appendLog(runId, sprintId, 'lifecycle', line, opRoot);
}

export async function readLog(
  runId: string,
  sprintId: string,
  type: 'agent' | 'lifecycle',
  opRoot: string,
): Promise<string> {
  try {
    return await readFile(logPath(opRoot, runId, sprintId, type), 'utf8');
  } catch {
    return '';
  }
}
