import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');
const PLUGIN = join(ROOT, 'packages/cli/plugin');

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownFiles(path)));
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out.sort();
}

describe('plugin docs lint', () => {
  it('does not contain raw-renderer placeholder corruption', async () => {
    const files = await markdownFiles(PLUGIN);
    const failures: string[] = [];
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      const rel = file.slice(ROOT.length + 1);
      const checks: Array<[RegExp, string]> = [
        [/~~~~/, 'contains stripped fence marker `~~~~`'],
        [/~~/, 'contains stripped placeholder marker `~~`'],
        [/`rk inspect\s+--json`/, 'contains empty `rk inspect --json` command'],
        [/`rk context\s+--profile/, 'contains empty `rk context --profile ...` command'],
        [/`rk run --resume\s*`/, 'contains empty `rk run --resume` command'],
      ];
      for (const [pattern, reason] of checks) {
        if (pattern.test(raw)) failures.push(`${rel}: ${reason}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('slash command markdown has valid frontmatter', async () => {
    const dir = join(PLUGIN, 'commands');
    const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();
    const failures: string[] = [];
    for (const file of files) {
      const raw = await readFile(join(dir, file), 'utf8');
      const parsed = matter(raw);
      if (typeof parsed.data.name !== 'string' || parsed.data.name.trim().length === 0) {
        failures.push(`${file}: missing frontmatter name`);
      }
      if (
        typeof parsed.data.description !== 'string' ||
        parsed.data.description.trim().length === 0
      ) {
        failures.push(`${file}: missing frontmatter description`);
      }
      if (!parsed.content.includes(`# /${parsed.data.name}`)) {
        failures.push(`${file}: body heading must match slash command name`);
      }
    }
    expect(failures).toEqual([]);
  });
});
