import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import {
  AgentSentinelOutputSchema,
  clearTrustCache,
  EMPTY_REPO_GRANT,
  evaluateAgentGrant,
  evaluateChecksCmdGrant,
  evaluateRepo,
  evaluateReviewerGrant,
  isSensitiveEnvName,
  loadUserTrust,
  RepoTrustGrantSchema,
  repoGrantFor,
  summarizeRepoRequests,
  UserLocalTrustSchema,
} from '../src/index.js';

let originalEnv: string | undefined;
let tmpDir: string;
let trustPath: string;

beforeEach(() => {
  originalEnv = process.env.REPOKERNEL_TRUST_FILE;
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'rk-trust-test-')));
  trustPath = join(tmpDir, 'trust.yaml');
  process.env.REPOKERNEL_TRUST_FILE = trustPath;
  clearTrustCache();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.REPOKERNEL_TRUST_FILE;
  else process.env.REPOKERNEL_TRUST_FILE = originalEnv;
  clearTrustCache();
});

describe('RepoTrustGrantSchema', () => {
  it('parses an empty grant with all defaults', () => {
    const grant = RepoTrustGrantSchema.parse({});
    expect(grant.checks_cmd).toBe(false);
    expect(grant.env_passthrough).toEqual([]);
    expect(grant.agents).toEqual([]);
    expect(grant.reviewers).toEqual({});
  });

  it('rejects wildcard env var names in env_passthrough', () => {
    expect(() => RepoTrustGrantSchema.parse({ env_passthrough: ['*_KEY'] })).toThrow();
  });

  it('rejects lowercase env var names', () => {
    expect(() => RepoTrustGrantSchema.parse({ env_passthrough: ['openai_api_key'] })).toThrow();
  });

  it('accepts canonical env var names', () => {
    const grant = RepoTrustGrantSchema.parse({
      env_passthrough: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    });
    expect(grant.env_passthrough).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  });

  it('parses a reviewer grant with command, args, timeout', () => {
    const grant = RepoTrustGrantSchema.parse({
      reviewers: {
        'gpt-reviewer': {
          command: '/usr/local/bin/gpt',
          args: ['--mode', 'review'],
          env_passthrough: ['OPENAI_API_KEY'],
          timeout_seconds: 600,
        },
      },
    });
    expect(grant.reviewers['gpt-reviewer']?.command).toBe('/usr/local/bin/gpt');
    expect(grant.reviewers['gpt-reviewer']?.timeout_seconds).toBe(600);
  });
});

describe('isSensitiveEnvName', () => {
  it.each([
    ['OPENAI_API_KEY', true],
    ['ANTHROPIC_API_KEY', true],
    ['AWS_SECRET_ACCESS_KEY', true],
    ['AWS_REGION', true],
    ['GITHUB_TOKEN', true],
    ['STRIPE_LIVE_KEY', true],
    ['NPM_TOKEN', true],
    ['PATH', false],
    ['HOME', false],
    ['CI', false],
    ['TZ', false],
  ])('isSensitiveEnvName(%s) → %s', (name, expected) => {
    expect(isSensitiveEnvName(name)).toBe(expected);
  });
});

describe('loadUserTrust', () => {
  it('returns empty trust when the trust file does not exist', async () => {
    const trust = await loadUserTrust();
    expect(trust).toEqual({ version: 1, repos: {} });
  });

  it('caches the result across calls until clearTrustCache', async () => {
    writeFileSync(trustPath, stringifyYaml({ version: 1, repos: {} }));
    const a = await loadUserTrust();
    writeFileSync(trustPath, stringifyYaml({ version: 1, repos: { '/x': {} } }));
    const b = await loadUserTrust();
    expect(b).toBe(a); // cached
    clearTrustCache();
    const c = await loadUserTrust();
    expect(c.repos['/x']).toBeDefined();
  });

  it('throws CONFIG_INVALID on malformed YAML', async () => {
    writeFileSync(trustPath, ': not valid yaml :\n@#$');
    await expect(loadUserTrust()).rejects.toThrow(/trust file|YAML/);
  });

  it('throws CONFIG_INVALID on schema mismatch', async () => {
    writeFileSync(trustPath, stringifyYaml({ version: 1, repos: { '/x': { unknown: true } } }));
    await expect(loadUserTrust()).rejects.toThrow(/trust file/);
  });
});

describe('repoGrantFor', () => {
  it('returns EMPTY_REPO_GRANT when no grant exists for the cwd', async () => {
    writeFileSync(trustPath, stringifyYaml({ version: 1, repos: {} }));
    const grant = await repoGrantFor(tmpDir);
    expect(grant).toEqual(EMPTY_REPO_GRANT);
  });

  it('resolves the grant by realpath of the cwd', async () => {
    writeFileSync(
      trustPath,
      stringifyYaml({ version: 1, repos: { [tmpDir]: { checks_cmd: true } } }),
    );
    const grant = await repoGrantFor(tmpDir);
    expect(grant.checks_cmd).toBe(true);
  });
});

describe('evaluateChecksCmdGrant', () => {
  it('allows when no checksCmd is configured', () => {
    const result = evaluateChecksCmdGrant(
      {
        allowAutonomousClose: false,
        defaultMode: 'assisted',
        defaultAgent: 'manual',
        defaultReviewer: 'agent',
        checksTimeoutSeconds: 1800,
      },
      EMPTY_REPO_GRANT,
    );
    expect(result.allowed).toBe(true);
  });

  it('denies when checksCmd is configured but grant is missing', () => {
    const result = evaluateChecksCmdGrant(
      {
        allowAutonomousClose: false,
        defaultMode: 'assisted',
        defaultAgent: 'manual',
        defaultReviewer: 'agent',
        checksCmd: 'pnpm test',
        checksTimeoutSeconds: 1800,
      },
      EMPTY_REPO_GRANT,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/checks_cmd/);
  });

  it('allows when checksCmd is configured and grant is set', () => {
    const result = evaluateChecksCmdGrant(
      {
        allowAutonomousClose: false,
        defaultMode: 'assisted',
        defaultAgent: 'manual',
        defaultReviewer: 'agent',
        checksCmd: 'pnpm test',
        checksTimeoutSeconds: 1800,
      },
      { ...EMPTY_REPO_GRANT, checks_cmd: true },
    );
    expect(result.allowed).toBe(true);
  });
});

describe('evaluateAgentGrant', () => {
  const def = {
    command: 'claude',
    args: [],
    resultFormat: 'sentinel-json' as const,
    timeoutSeconds: 1800,
    envPassthrough: ['OPENAI_API_KEY'],
  };

  it('denies when the agent name is not granted', () => {
    const ev = evaluateAgentGrant('claude-runner', def, EMPTY_REPO_GRANT);
    expect(ev.allowed).toBe(false);
    expect(ev.reason).toMatch(/not granted/);
    expect(ev.droppedEnv).toContainEqual({ name: 'OPENAI_API_KEY', reason: 'agent not granted' });
  });

  it('allows when granted but drops env names not in user-local env_passthrough', () => {
    const ev = evaluateAgentGrant('claude-runner', def, {
      ...EMPTY_REPO_GRANT,
      agents: ['claude-runner'],
    });
    expect(ev.allowed).toBe(true);
    expect(ev.allowedEnv).toEqual([]);
    expect(ev.droppedEnv[0]?.name).toBe('OPENAI_API_KEY');
    expect(ev.droppedEnv[0]?.reason).toMatch(/env_passthrough/);
  });

  it('passes through env names that are explicitly granted', () => {
    const ev = evaluateAgentGrant('claude-runner', def, {
      ...EMPTY_REPO_GRANT,
      agents: ['claude-runner'],
      env_passthrough: ['OPENAI_API_KEY'],
    });
    expect(ev.allowed).toBe(true);
    expect(ev.allowedEnv).toEqual(['OPENAI_API_KEY']);
    expect(ev.droppedEnv).toEqual([]);
  });

  it('drops repo-declared wildcards even when the agent is granted', () => {
    const wildcardDef = { ...def, envPassthrough: ['*_KEY'] };
    const ev = evaluateAgentGrant('claude-runner', wildcardDef, {
      ...EMPTY_REPO_GRANT,
      agents: ['claude-runner'],
      env_passthrough: ['OPENAI_API_KEY'],
    });
    expect(ev.allowed).toBe(true);
    expect(ev.allowedEnv).toEqual([]);
    expect(ev.droppedEnv[0]?.reason).toMatch(/wildcards/);
  });
});

describe('evaluateReviewerGrant', () => {
  it('denies an unknown reviewer id', () => {
    const result = evaluateReviewerGrant('gpt', EMPTY_REPO_GRANT);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/gpt/);
  });

  it('returns the granted reviewer config when present', () => {
    const result = evaluateReviewerGrant('gpt', {
      ...EMPTY_REPO_GRANT,
      reviewers: {
        gpt: {
          command: '/usr/local/bin/gpt',
          args: ['--mode=review'],
          env_passthrough: ['OPENAI_API_KEY'],
          timeout_seconds: 600,
        },
      },
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.reviewer.command).toBe('/usr/local/bin/gpt');
      expect(result.reviewer.timeout_seconds).toBe(600);
    }
  });
});

describe('summarizeRepoRequests + evaluateRepo', () => {
  const baseAutomation = {
    allowAutonomousClose: false,
    defaultMode: 'assisted' as const,
    defaultAgent: 'manual',
    defaultReviewer: 'agent',
    checksTimeoutSeconds: 1800,
  };

  it('emits one request per privileged action in the config', () => {
    const requests = summarizeRepoRequests({
      schemaVersion: 1,
      projectId: 'demo',
      projectName: 'Demo',
      paths: {
        epics: 'e',
        sprints: 's',
        reviews: 'r',
        queues: 'q',
        lanes: 'l',
        generated: '.g',
        registry: '.g/r.json',
      },
      automation: { ...baseAutomation, checksCmd: 'pnpm test' },
      agents: {
        'claude-runner': {
          command: 'claude',
          args: [],
          resultFormat: 'sentinel-json',
          timeoutSeconds: 1800,
          envPassthrough: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
        },
      },
    } as never);
    const scopes = requests.map((r) => r.scope);
    expect(scopes).toContain('checks_cmd');
    expect(scopes).toContain('agent');
    expect(scopes.filter((s) => s === 'env_passthrough').length).toBeGreaterThanOrEqual(2);
  });

  it('evaluateRepo returns the violations for an empty grant', () => {
    const config = {
      schemaVersion: 1,
      projectId: 'demo',
      projectName: 'Demo',
      paths: {
        epics: 'e',
        sprints: 's',
        reviews: 'r',
        queues: 'q',
        lanes: 'l',
        generated: '.g',
        registry: '.g/r.json',
      },
      automation: { ...baseAutomation, checksCmd: 'pnpm test' },
      agents: {},
    } as never;
    const ev = evaluateRepo(config, EMPTY_REPO_GRANT);
    expect(ev.violations.length).toBe(1);
    expect(ev.violations[0]?.scope).toBe('checks_cmd');
  });
});

describe('AgentSentinelOutputSchema', () => {
  it('parses a valid completed result with review', () => {
    const result = AgentSentinelOutputSchema.parse({
      status: 'completed',
      summary: 'done',
      changed_files: ['a.ts'],
      needs_human: false,
      review: { verdict: 'accepted', findings: [{ severity: 'P2', message: 'minor' }] },
    });
    expect(result.review?.verdict).toBe('accepted');
    expect(result.review?.findings[0]?.severity).toBe('P2');
  });

  it('rejects an invalid severity', () => {
    expect(() =>
      AgentSentinelOutputSchema.parse({
        status: 'completed',
        summary: 'done',
        review: { verdict: 'accepted', findings: [{ severity: 'CRITICAL', message: 'x' }] },
      }),
    ).toThrow();
  });

  it('rejects unknown status', () => {
    expect(() => AgentSentinelOutputSchema.parse({ status: 'unknown', summary: 'done' })).toThrow();
  });

  it('rejects an unknown top-level field (strict mode)', () => {
    expect(() =>
      AgentSentinelOutputSchema.parse({
        status: 'completed',
        summary: 'done',
        bogus_field: true,
      }),
    ).toThrow();
  });
});

describe('UserLocalTrustSchema strict', () => {
  it('rejects unknown top-level fields', () => {
    expect(() => UserLocalTrustSchema.parse({ version: 1, repos: {}, garbage: true })).toThrow();
  });
});
