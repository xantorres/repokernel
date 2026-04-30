import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const RK_BIN = resolve(__dirname, '..', 'dist', 'index.js');

async function help(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('node', [RK_BIN, ...args], {
    env: { ...process.env, NO_COLOR: '1' },
  });
  return stdout;
}

/**
 * Pin the externally-observable command surface so the PR10 architecture
 * split (and any future refactor that moves command registrations between
 * files) cannot change it without an explicit, reviewable test update.
 */
describe('rk --help surface (PR10 architecture split guard)', () => {
  it('top-level help lists every documented command', async () => {
    const out = await help(['--help']);
    for (const verb of [
      'create',
      'start',
      'review',
      'review-verdict',
      'review-aggregate',
      'close',
      'discard',
      'reopen',
      'cancel',
      'queue',
      'recover',
      'doctor',
      'validate',
      'run',
      'runs',
    ]) {
      expect(out, `top-level help missing: ${verb}`).toMatch(new RegExp(`\\b${verb}\\b`));
    }
  });

  it('rk create help lists the four subcommands', async () => {
    const out = await help(['create', '--help']);
    for (const sub of ['epic', 'sprint', 'queue', 'review']) {
      expect(out).toMatch(new RegExp(`\\b${sub}\\b`));
    }
  });

  it('rk start --help retains --force / --enqueue / --dry-run / --json flags', async () => {
    const out = await help(['start', '--help']);
    for (const flag of ['--force', '--enqueue', '--dry-run', '--json']) {
      expect(out).toContain(flag);
    }
  });

  it('rk review-verdict --help retains <review-id> <verdict> positional + --summary', async () => {
    const out = await help(['review-verdict', '--help']);
    expect(out).toContain('<review-id>');
    expect(out).toContain('<verdict>');
    expect(out).toContain('--summary');
  });

  it('rk cancel --help retains --reason / --dry-run / --json flags', async () => {
    const out = await help(['cancel', '--help']);
    for (const flag of ['--reason', '--dry-run', '--json']) {
      expect(out).toContain(flag);
    }
  });

  it('rk reopen --help documents cancelled sprint recovery', async () => {
    const out = await help(['reopen', '--help']);
    expect(out).toContain('cancelled');
  });

  it('rk create sprint --help carries the --enqueue + --json flags added in PR8', async () => {
    const out = await help(['create', 'sprint', '--help']);
    for (const flag of ['--enqueue', '--json', '--epic', '--lane', '--status']) {
      expect(out).toContain(flag);
    }
  });
});
