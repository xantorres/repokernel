import { describe, expect, it } from 'vitest';
import { runEnvPreflight } from '../src/commands/doctor.js';

describe('runEnvPreflight — codex-danger preset', () => {
  it('resolves the codex binary, never the preset alias', async () => {
    const warnings = await runEnvPreflight('codex-danger');
    // When the codex CLI is absent a missing-binary warning fires; it must name
    // the real `codex` executable, not the `codex-danger` preset alias.
    expect(warnings.some((w) => w.title.includes('"codex-danger"'))).toBe(false);
  });

  it('warns when OPENAI_API_KEY is unset', async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const warnings = await runEnvPreflight('codex-danger');
      expect(warnings.some((w) => w.title === 'OPENAI_API_KEY is not set')).toBe(true);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });
});
