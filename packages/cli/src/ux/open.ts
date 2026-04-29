import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

export interface OpenResult {
  readonly opened: boolean;
  readonly path: string;
  readonly message: string;
}

export async function openPathInEditor(cwd: string, file: string): Promise<OpenResult> {
  const path = isAbsolute(file) ? file : join(cwd, file);
  const abs = resolve(path);

  if (!process.stdout.isTTY && process.env.REPOKERNEL_OPEN_FORCE !== '1') {
    return { opened: false, path: abs, message: `Open: ${abs}` };
  }

  const editor = process.env.EDITOR?.trim();
  if (editor) {
    const ok = await runShellCommand(`${editor} ${shellQuote(abs)}`);
    if (ok) return { opened: true, path: abs, message: `Opened ${abs}` };
  }

  const codeOk = await runCommand('code', [abs]);
  if (codeOk) return { opened: true, path: abs, message: `Opened ${abs}` };

  return { opened: false, path: abs, message: `Open: ${abs}` };
}

function runShellCommand(command: string): Promise<boolean> {
  return new Promise((resolveDone) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
    });
    child.on('error', () => resolveDone(false));
    child.on('exit', (code) => resolveDone(code === 0));
  });
}

function runCommand(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolveDone) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => resolveDone(false));
    child.on('spawn', () => {
      child.unref();
      resolveDone(true);
    });
  });
}

export async function openPathInBrowser(path: string): Promise<boolean> {
  if (!process.stdout.isTTY && process.env.REPOKERNEL_OPEN_FORCE !== '1') return false;
  if (process.platform === 'win32') {
    return runCommand('cmd', ['/c', 'start', '', path]);
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return runCommand(cmd, [path]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
