import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXIT_BLOCKED,
  EXIT_BUDGET_EXCEEDED,
  EXIT_BUDGET_TOO_SMALL,
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
} from '../src/exitCodes.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

describe('exit codes documentation matches the source (PR8 finding 16)', () => {
  it('docs/internals/cli-reference.md mentions every exit code constant in exitCodes.ts', async () => {
    const doc = await readFile(resolve(REPO_ROOT, 'docs/internals/cli-reference.md'), 'utf8');
    // Sanity: source values are stable. If a future refactor changes a
    // constant, this test is the canary.
    expect(EXIT_OK).toBe(0);
    expect(EXIT_FINDINGS).toBe(1);
    expect(EXIT_BLOCKED).toBe(EXIT_FINDINGS);
    expect(EXIT_RUNTIME).toBe(2);
    expect(EXIT_BUDGET_EXCEEDED).toBe(3);
    expect(EXIT_BUDGET_TOO_SMALL).toBe(4);
    expect(EXIT_USAGE).toBe(64);

    for (const code of [
      String(EXIT_OK),
      String(EXIT_FINDINGS),
      String(EXIT_RUNTIME),
      String(EXIT_BUDGET_EXCEEDED),
      String(EXIT_BUDGET_TOO_SMALL),
      String(EXIT_USAGE),
    ]) {
      expect(doc, `cli-reference.md is missing exit code ${code}`).toContain(`\`${code}\``);
    }

    // The user-facing constant names matter to anyone scripting against
    // the binary; the doc table cites them for grep-ability.
    for (const name of [
      'EXIT_OK',
      'EXIT_FINDINGS',
      'EXIT_RUNTIME',
      'EXIT_BUDGET_EXCEEDED',
      'EXIT_BUDGET_TOO_SMALL',
      'EXIT_USAGE',
    ]) {
      expect(doc, `cli-reference.md is missing constant name ${name}`).toContain(name);
    }
  });
});
