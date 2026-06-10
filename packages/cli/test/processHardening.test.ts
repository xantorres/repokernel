import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@repokernel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalRunner } from '../src/agents/external.js';
import { assertWriteSafe, shouldGatherContextFile } from '../src/agents/ollama.js';
import { runConfiguredChecks } from '../src/lifecycle/checks.js';
import { appendAgentLog, readLog } from '../src/lifecycle/runLogs.js';
import { redactSecrets } from '../src/lifecycle/secretScanner.js';
import { buildPolicyEnv } from '../src/security/spawnPolicy.js';
import { resetTrustForTest, seedTrustForCwd } from './helpers/fixture.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

let originalTrustEnv: string | undefined;
beforeEach(() => {
  originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
});
afterEach(() => {
  resetTrustForTest(originalTrustEnv);
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-harden-'));
  tracked.push(dir);
  return dir;
}

describe('buildPolicyEnv', () => {
  it('drops everything not on the default allowlist', () => {
    const env = buildPolicyEnv(
      {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-proj-leak-leak-leak-leak-leak-leak',
        AWS_SECRET_ACCESS_KEY: 'secret-shouldnt-leak',
        HOME: '/h',
      },
      [],
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/h');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('passes through explicitly allowlisted names', () => {
    const env = buildPolicyEnv(
      { PATH: '/u/b', OPENAI_API_KEY: 'sk-proj-allowed', UNRELATED: 'no' },
      ['OPENAI_API_KEY'],
    );
    expect(env.OPENAI_API_KEY).toBe('sk-proj-allowed');
    expect(env.UNRELATED).toBeUndefined();
  });

  it('omits names that are not present in the parent env', () => {
    const env = buildPolicyEnv({ PATH: '/u/b' }, ['NEVER_SET']);
    expect('NEVER_SET' in env).toBe(false);
  });
});

describe('external agent runtime env', () => {
  it('a custom agent without explicit envPassthrough cannot see OPENAI_API_KEY', async () => {
    const sprintsDir = await tmp();
    const opRoot = join(sprintsDir, '.op');
    await mkdir(opRoot, { recursive: true });
    const packetPath = join(sprintsDir, 'packet.md');
    await writeFile(packetPath, '# task', 'utf8');

    // Agent dumps its env to JSON and emits a sentinel that captures it
    // in the `summary` field. We assert OPENAI_API_KEY is NOT in summary.
    const script = `
      const env = JSON.stringify({ has: !!process.env.OPENAI_API_KEY });
      const result = {
        status: 'completed',
        summary: 'env=' + env,
        changed_files: [],
        needs_human: false,
      };
      process.stdout.write('REPOKERNEL_RESULT_START\\n' + JSON.stringify(result) + '\\nREPOKERNEL_RESULT_END\\n');
    `;
    const def: AgentDefinition = {
      command: 'node',
      args: ['-e', script],
      resultFormat: 'sentinel-json',
      timeoutSeconds: 10,
      envPassthrough: [],
    };

    // Trust the agent name but grant no env_passthrough — the assertion
    // below verifies OPENAI_API_KEY does NOT flow through.
    await seedTrustForCwd(sprintsDir, { agents: ['custom'] });
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-proj-fake-test-secret-1234567890';
    try {
      const runner = new ExternalRunner('custom', def);
      const result = await runner.runSprint({
        sprint_id: 'S-001',
        epic_id: 'E-001',
        run_id: 'RUN-001',
        worktree: sprintsDir,
        op_root: opRoot,
        control_cwd: sprintsDir,
        sprint_packet_path: packetPath,
        registry_path: join(sprintsDir, 'registry.json'),
        mode: 'assisted',
      });
      expect(result.summary).toContain('"has":false');
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe('redactSecrets', () => {
  it.each([
    ['AWS_SECRET_ACCESS_KEY=topsecretvalue', /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/],
    ['export OPENAI_API_KEY="sk-proj-fakefakefakefakefakefake"', /OPENAI_API_KEY=.*\[REDACTED\].*/],
    ['my-token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', /\[REDACTED\]/],
    ['log line with AKIAIOSFODNN7EXAMPLE in middle', /AKIA.*\[REDACTED\]|\[REDACTED\]/],
  ])('redacts secret-shaped content from %s', (input, expected) => {
    expect(redactSecrets(input)).toMatch(expected);
  });

  it('leaves non-secret text intact', () => {
    expect(redactSecrets('hello world, fixed bug #42')).toBe('hello world, fixed bug #42');
  });
});

describe('agent logs are written through redactSecrets', () => {
  it('a logged line with a fake OPENAI key persists redacted on disk', async () => {
    const opRoot = await tmp();
    await appendAgentLog(
      'RUN-001',
      'S-001',
      'agent printed sk-proj-fake-test-secret-1234567890 in stdout',
      opRoot,
    );
    const persisted = await readLog('RUN-001', 'S-001', 'agent', opRoot);
    expect(persisted).not.toContain('sk-proj-fake-test-secret');
    expect(persisted).toContain('[REDACTED]');
  });
});

describe('Ollama symlink hardening', () => {
  it('excludes a symlink from the context-gather pass and includes a regular file', () => {
    // A tracked symlink could point outside the worktree → never gathered.
    expect(shouldGatherContextFile({ isSymbolicLink: () => true, isFile: () => false })).toBe(
      false,
    );
    expect(shouldGatherContextFile({ isSymbolicLink: () => true, isFile: () => true })).toBe(false);
    // A plain regular file is the only thing worth reading into context.
    expect(shouldGatherContextFile({ isSymbolicLink: () => false, isFile: () => true })).toBe(true);
    // Directories and other non-regular nodes are skipped.
    expect(shouldGatherContextFile({ isSymbolicLink: () => false, isFile: () => false })).toBe(
      false,
    );
  });

  it('assertWriteSafe rejects a write through a symlink that escapes the worktree', async () => {
    const worktree = await tmp();
    const outside = await tmp();
    await writeFile(join(outside, 'target.txt'), 'OUTSIDE', 'utf8');
    // tracked symlink inside worktree → file outside worktree.
    await symlink(join(outside, 'target.txt'), join(worktree, 'tracked-link.txt'));
    await expect(assertWriteSafe(worktree, 'tracked-link.txt')).rejects.toThrow(/symlink/);
  });
});

describe('configured checks timeout', () => {
  it('a hanging checksCmd is killed once timeoutSeconds elapses', async () => {
    const cwd = await tmp();
    const start = Date.now();
    const r = await runConfiguredChecks('sleep 999', cwd, 1);
    const elapsedSec = (Date.now() - start) / 1000;
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    // Should fire well before the 999s sleep would naturally finish; we
    // allow generous headroom for the SIGTERM grace + scheduler jitter.
    expect(elapsedSec).toBeLessThan(20);
  }, 30_000);

  it('a fast-exiting checksCmd reports its real exit code with timedOut=false', async () => {
    const cwd = await tmp();
    const r = await runConfiguredChecks('exit 0', cwd, 5);
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBeFalsy();
  });

  it('passes through a non-zero exit code for a check that fails on its own', async () => {
    const cwd = await tmp();
    const r = await runConfiguredChecks('exit 42', cwd, 5);
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(42);
    expect(r.timedOut).toBeFalsy();
  });
});
