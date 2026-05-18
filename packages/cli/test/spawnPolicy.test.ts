import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAgentTrusted,
  assertChecksCmdTrusted,
  buildPolicyEnv,
  DEFAULT_SPAWN_ENV_ALLOWLIST,
  resolveTrustedReviewer,
} from '../src/security/spawnPolicy.js';
import { resetTrustForTest, seedTrustForCwd } from './helpers/fixture.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-spawn-policy-'));
  tracked.push(dir);
  return dir;
}

let originalTrustEnv: string | undefined;
beforeEach(() => {
  originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
});
afterEach(() => {
  resetTrustForTest(originalTrustEnv);
});

describe('buildPolicyEnv', () => {
  it('keeps only allowlist + explicit passthrough', () => {
    const env = buildPolicyEnv(
      {
        PATH: '/usr/bin',
        HOME: '/h',
        OPENAI_API_KEY: 'sk-x',
        AWS_SECRET_ACCESS_KEY: 'x',
        SOMETHING_ELSE: 'y',
      },
      ['OPENAI_API_KEY'],
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/h');
    expect(env.OPENAI_API_KEY).toBe('sk-x');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SOMETHING_ELSE).toBeUndefined();
  });

  it('exposes the canonical allowlist', () => {
    expect(DEFAULT_SPAWN_ENV_ALLOWLIST).toContain('PATH');
    expect(DEFAULT_SPAWN_ENV_ALLOWLIST).toContain('CI');
  });
});

describe('assertChecksCmdTrusted', () => {
  const automationNoCmd = {
    allowAutonomousClose: false,
    defaultMode: 'assisted' as const,
    defaultAgent: 'manual',
    defaultReviewer: 'agent',
    checksTimeoutSeconds: 1800,
  };
  const automationWithCmd = {
    ...automationNoCmd,
    checksCmd: 'pnpm test',
  };

  it('no-ops when no checksCmd is configured', async () => {
    const cwd = await tmp();
    await expect(assertChecksCmdTrusted(automationNoCmd, cwd)).resolves.toBeUndefined();
  });

  it('throws TRUST_DENIED when checksCmd is configured but ungranted', async () => {
    const cwd = await tmp();
    await expect(assertChecksCmdTrusted(automationWithCmd, cwd)).rejects.toThrow(
      /not granted 'checks_cmd'/,
    );
  });

  it('passes when checksCmd is configured and granted', async () => {
    const cwd = await tmp();
    await seedTrustForCwd(cwd, { checks_cmd: true });
    await expect(assertChecksCmdTrusted(automationWithCmd, cwd)).resolves.toBeUndefined();
  });
});

describe('assertAgentTrusted', () => {
  const def = {
    command: 'claude',
    args: [],
    resultFormat: 'sentinel-json' as const,
    timeoutSeconds: 1800,
    envPassthrough: ['OPENAI_API_KEY'],
  };

  it('throws when the agent is not granted', async () => {
    const cwd = await tmp();
    await expect(assertAgentTrusted('claude-runner', def, cwd)).rejects.toThrow(/not granted/);
  });

  it('returns the filtered passthrough when granted but env name is not granted', async () => {
    const cwd = await tmp();
    await seedTrustForCwd(cwd, { agents: ['claude-runner'] });
    const trust = await assertAgentTrusted('claude-runner', def, cwd);
    expect(trust.allowedEnv).toEqual([]);
    expect(trust.droppedEnv[0]?.name).toBe('OPENAI_API_KEY');
  });

  it('returns the env name when both agent and env are granted', async () => {
    const cwd = await tmp();
    await seedTrustForCwd(cwd, {
      agents: ['claude-runner'],
      env_passthrough: ['OPENAI_API_KEY'],
    });
    const trust = await assertAgentTrusted('claude-runner', def, cwd);
    expect(trust.allowedEnv).toEqual(['OPENAI_API_KEY']);
    expect(trust.droppedEnv).toEqual([]);
  });
});

describe('resolveTrustedReviewer', () => {
  it('throws when the reviewer id has no grant', async () => {
    const cwd = await tmp();
    await expect(resolveTrustedReviewer('gpt', cwd)).rejects.toThrow(/gpt/);
  });

  it('returns the granted reviewer config', async () => {
    const cwd = await tmp();
    await seedTrustForCwd(cwd, {
      reviewers: {
        gpt: {
          command: '/usr/local/bin/gpt',
          args: ['--mode', 'review'],
          env_passthrough: ['OPENAI_API_KEY'],
          timeout_seconds: 600,
        },
      },
    });
    const reviewer = await resolveTrustedReviewer('gpt', cwd);
    expect(reviewer.command).toBe('/usr/local/bin/gpt');
    expect(reviewer.args).toEqual(['--mode', 'review']);
    expect(reviewer.timeout_seconds).toBe(600);
  });
});

describe('rk trust audit', () => {
  it('emits the grant fragment matching the repo config', async () => {
    const cwd = await tmp();
    await writeFile(
      join(cwd, 'repokernel.config.yaml'),
      `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
automation:
  checksCmd: "pnpm test"
agents:
  claude-runner:
    command: claude
    args: []
    envPassthrough: [OPENAI_API_KEY]
`,
      'utf8',
    );
    const { runTrustAuditCommand } = await import('../src/commands/trust.js');
    const result = await runTrustAuditCommand({ cwd, apply: false, json: true });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.grant.checks_cmd).toBe(true);
    expect(out.grant.agents).toContain('claude-runner');
    expect(out.grant.env_passthrough).toContain('OPENAI_API_KEY');
  });
});

describe('rk trust audit (--apply)', () => {
  it('writes the grant to the configured trust file and notes reviewer ids needing manual entry', async () => {
    const cwd = await tmp();
    await writeFile(
      join(cwd, 'repokernel.config.yaml'),
      `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
automation:
  checksCmd: "pnpm test"
`,
      'utf8',
    );
    // Add an epic with a panel-review quality rule so reviewer enumeration
    // has something to find. loadProject also expects the other entity
    // directories to exist (even if empty) — create them all.
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    for (const dir of ['epics', 'sprints', 'reviews', 'queues', 'lanes']) {
      await mkdir(join(cwd, dir), { recursive: true });
    }
    await wf(
      join(cwd, 'epics', 'E-001.md'),
      `---
id: E-001
title: Demo
status: active
sprints: []
quality_rules:
  - type: panel_review
    yellow_blocks_close: false
    reviewers:
      - id: gpt-reviewer
        command: placeholder
        failure_verdict: RED
        env_passthrough: []
---
`,
      'utf8',
    );
    const trustPath = `${cwd}/trust.yaml`;
    process.env.REPOKERNEL_TRUST_FILE = trustPath;
    const { runTrustAuditCommand } = await import('../src/commands/trust.js');
    const result = await runTrustAuditCommand({ cwd, apply: true, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/gpt-reviewer/);

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(trustPath, 'utf8');
    expect(written).toContain('checks_cmd: true');
  });
});

describe('rk trust list', () => {
  it('reports "no trust grants" when the file is empty', async () => {
    const cwd = await tmp();
    const trustPath = `${cwd}/trust.yaml`;
    process.env.REPOKERNEL_TRUST_FILE = trustPath;
    const { runTrustListCommand } = await import('../src/commands/trust.js');
    const result = await runTrustListCommand({ json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no trust grants/);
  });

  it('lists granted repos in human-readable form', async () => {
    const cwd = await tmp();
    await seedTrustForCwd(cwd, { checks_cmd: true, agents: ['claude-runner'] });
    const { runTrustListCommand } = await import('../src/commands/trust.js');
    const result = await runTrustListCommand({ json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('checks_cmd:       true');
    expect(result.stdout).toContain('agents:           claude-runner');
  });
});

describe('rk trust grant / revoke', () => {
  it('grants then revokes checks_cmd', async () => {
    const cwd = await tmp();
    const trustPath = `${cwd}/trust.yaml`;
    process.env.REPOKERNEL_TRUST_FILE = trustPath;
    const { runTrustGrantCommand, runTrustRevokeCommand } = await import(
      '../src/commands/trust.js'
    );

    const grantResult = await runTrustGrantCommand({ cwd, scope: 'checks_cmd' });
    expect(grantResult.exitCode).toBe(0);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(trustPath, 'utf8')).toContain('checks_cmd: true');

    const revokeResult = await runTrustRevokeCommand({ cwd, scope: 'checks_cmd' });
    expect(revokeResult.exitCode).toBe(0);
    expect(await readFile(trustPath, 'utf8')).toContain('checks_cmd: false');
  });

  it('grant agent <name> adds and grant env_passthrough <name> adds', async () => {
    const cwd = await tmp();
    const trustPath = `${cwd}/trust.yaml`;
    process.env.REPOKERNEL_TRUST_FILE = trustPath;
    const { runTrustGrantCommand } = await import('../src/commands/trust.js');

    await runTrustGrantCommand({ cwd, scope: 'agent', key: 'claude' });
    await runTrustGrantCommand({ cwd, scope: 'env_passthrough', key: 'OPENAI_API_KEY' });
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(trustPath, 'utf8');
    expect(text).toContain('claude');
    expect(text).toContain('OPENAI_API_KEY');
  });

  it('grant agent without a key returns EXIT_USAGE', async () => {
    const cwd = await tmp();
    const { runTrustGrantCommand } = await import('../src/commands/trust.js');
    const result = await runTrustGrantCommand({ cwd, scope: 'agent' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/requires a key/);
  });
});

describe('rk trust check', () => {
  it('exits 0 when no checksCmd or agents are configured', async () => {
    const cwd = await tmp();
    await writeFile(
      join(cwd, 'repokernel.config.yaml'),
      `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
      'utf8',
    );
    const { runTrustCheckCommand } = await import('../src/commands/trust.js');
    const result = await runTrustCheckCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
  });

  it('exits 1 with a hint when a checksCmd is declared but ungranted', async () => {
    const cwd = await tmp();
    await writeFile(
      join(cwd, 'repokernel.config.yaml'),
      `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
automation:
  checksCmd: "pnpm test"
`,
      'utf8',
    );
    const { runTrustCheckCommand } = await import('../src/commands/trust.js');
    const result = await runTrustCheckCommand({ cwd, json: false });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/trust grants missing/);
  });
});
