import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * Hard contract: RK is agent-agnostic. No model-vendor strings (haiku /
 * sonnet / opus / gpt-N / llama-N / claude-<id>) may appear in the runtime
 * source of @repokernel/core or the CLI. Tier names are abstract; the
 * mapping from tier → concrete model ID lives in the consumer's skill, not
 * here.
 *
 * Allowed: agent-adapter names referenced by the run subsystem (`claude`,
 * `codex`, `ollama`) — those are adapter identifiers, not model IDs, and
 * stay scoped to packages/cli/src/agents and packages/cli/src/commands.
 */
describe('vendor-agnosticism', () => {
  async function searchUnderRoot(root: string): Promise<string> {
    const args = [
      '-RInE',
      String.raw`\b(haiku|sonnet|opus|gpt-[0-9]|llama-[0-9]|claude-(haiku|sonnet|opus|instant)[a-z0-9-]*)\b`,
      `${REPO_ROOT}/${root}`,
      '--include=*.ts',
      '--exclude-dir=__tests__',
      '--exclude-dir=test',
      '--exclude=*.test.ts',
    ];
    try {
      const { stdout } = await execFileAsync('grep', args);
      return stdout;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { code?: number }).code;
      if (code === 1 || code === '1') return ''; // grep: no match
      throw err;
    }
  }

  it('packages/core/src has no vendor-specific model strings', async () => {
    const hits = await searchUnderRoot('packages/core/src');
    expect(hits, `vendor leak in core/src:\n${hits}`).toBe('');
  });

  it('packages/cli/src has no vendor-specific model strings', async () => {
    const hits = await searchUnderRoot('packages/cli/src');
    expect(hits, `vendor leak in cli/src:\n${hits}`).toBe('');
  });
});
