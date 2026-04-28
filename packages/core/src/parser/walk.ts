import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface ListMarkdownFilesOptions {
  readonly missing?: 'empty' | 'throw';
}

export async function listMarkdownFiles(
  root: string,
  dir: string,
  options: ListMarkdownFilesOptions = {},
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if ((code === 'ENOENT' || code === 'ENOTDIR') && options.missing !== 'throw') return [];
    throw cause;
  }

  const files: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.md')) continue;
    const parentPath: string =
      typeof (e as { parentPath?: string }).parentPath === 'string'
        ? (e as { parentPath: string }).parentPath
        : typeof (e as { path?: string }).path === 'string'
          ? (e as { path: string }).path
          : dir;
    const full = join(parentPath, e.name);
    files.push(full);
  }

  files.sort((a, b) => a.localeCompare(b));
  return files.map((f) => relativePosix(root, f));
}

function relativePosix(root: string, full: string): string {
  return relative(root, full).split(sep).join('/');
}
