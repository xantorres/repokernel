import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runStateRoot } from './controlPaths.js';

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
  await appendFile(path, `${line}\n`, 'utf8');
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
