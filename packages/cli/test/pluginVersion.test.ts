import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

describe('plugin version alignment', () => {
  it('keeps bundled plugin and skill versions aligned to the CLI package', async () => {
    const cli = JSON.parse(await readFile(resolve(ROOT, 'packages/cli/package.json'), 'utf8')) as {
      version: string;
    };
    const plugin = JSON.parse(
      await readFile(resolve(ROOT, 'packages/cli/plugin/.claude-plugin/plugin.json'), 'utf8'),
    ) as { version: string };
    const skill = matter(
      await readFile(resolve(ROOT, 'packages/cli/plugin/skills/repokernel/SKILL.md'), 'utf8'),
    ).data as { version: string };

    expect(plugin.version).toBe(cli.version);
    expect(skill.version).toBe(cli.version);
  });
});
