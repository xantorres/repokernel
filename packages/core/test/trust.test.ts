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
    if (!result.allowed) expect(result.reason).toMatch(/checks_cmd/);
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

  it('denies when checksPhases are configured but checks_cmd grant is missing', () => {
    const result = evaluateChecksCmdGrant(
      {
        allowAutonomousClose: false,
        defaultMode: 'assisted',
        defaultAgent: 'manual',
        defaultReviewer: 'agent',
        checksPhases: { check: 'pnpm check', test: 'pnpm test' },
        checksTimeoutSeconds: 1800,
      },
      EMPTY_REPO_GRANT,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/automation\.checksPhases/);
  });

  it('allows checksPhases when checks_cmd grant is set', () => {
    const result = evaluateChecksCmdGrant(
      {
        allowAutonomousClose: false,
        defaultMode: 'assisted',
        defaultAgent: 'manual',
        defaultReviewer: 'agent',
        checksPhases: { check: 'pnpm check' },
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
    if (!ev.allowed) expect(ev.reason).toMatch(/not granted/);
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

  it('emits a reviewer request for each automation.reviewers entry', () => {
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
      automation: {
        ...baseAutomation,
        defaultReviewer: 'codex',
        reviewers: { codex: { authMode: 'chatgpt', schemaPath: null, rubricExtras: null } },
      },
    } as never);
    const reviewer = requests.find((r) => r.scope === 'reviewer' && r.key === 'codex');
    expect(reviewer).toBeDefined();
    expect(reviewer?.source).toBe('automation.reviewers.codex');
  });

  it('emits checks_cmd requests for each checksPhases command', () => {
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
      automation: { ...baseAutomation, checksPhases: { check: 'pnpm check', test: 'pnpm test' } },
      agents: {},
    } as never);
    expect(requests.filter((request) => request.scope === 'checks_cmd')).toEqual([
      expect.objectContaining({ source: 'automation.checksPhases.check = "pnpm check"' }),
      expect.objectContaining({ source: 'automation.checksPhases.test = "pnpm test"' }),
    ]);
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

describe('trust loader error kinds', () => {
  it('throws TRUST_FILE_INVALID for malformed YAML', async () => {
    writeFileSync(trustPath, ':\n:not valid', 'utf8');
    clearTrustCache();
    await expect(loadUserTrust()).rejects.toMatchObject({ kind: 'TRUST_FILE_INVALID' });
  });

  it('throws TRUST_FILE_INVALID when the top level is a sequence', async () => {
    writeFileSync(trustPath, '- foo\n- bar\n', 'utf8');
    clearTrustCache();
    await expect(loadUserTrust()).rejects.toMatchObject({ kind: 'TRUST_FILE_INVALID' });
  });

  it('throws TRUST_FILE_INVALID for reserved repo keys (prototype pollution defense)', async () => {
    // Write the literal `__proto__` key via raw YAML; the JS object literal
    // `{ __proto__: ... }` would set the prototype, not an own key.
    writeFileSync(
      trustPath,
      ['version: 1', 'repos:', '  __proto__:', '    agents: []'].join('\n'),
      'utf8',
    );
    clearTrustCache();
    await expect(loadUserTrust()).rejects.toMatchObject({ kind: 'TRUST_FILE_INVALID' });
  });

  it('throws TRUST_FILE_VERSION_UNSUPPORTED for a future version', async () => {
    writeFileSync(trustPath, 'version: 99\nrepos: {}\n', 'utf8');
    clearTrustCache();
    await expect(loadUserTrust()).rejects.toMatchObject({
      kind: 'TRUST_FILE_VERSION_UNSUPPORTED',
    });
  });

  it('throws TRUST_FILE_INVALID when the file exceeds the byte limit', async () => {
    // 300 KB > 256 KB cap.
    writeFileSync(trustPath, `version: 1\nrepos:\n  /x: {}\n${'# pad\n'.repeat(50_000)}`, 'utf8');
    clearTrustCache();
    await expect(loadUserTrust()).rejects.toMatchObject({ kind: 'TRUST_FILE_INVALID' });
  });

  it('rejects YAML alias-bomb expansion', async () => {
    // Classic billion-laughs: every layer references the previous N times.
    // yaml@2's maxAliasCount=100 caps the expansion cost; an unbounded chain
    // would otherwise blow up memory before we ever reach validation.
    const yaml = [
      'version: 1',
      'repos:',
      '  ok: { agents: [] }',
      'a0: &a0 ["lol"]',
      'a1: &a1 [*a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0]',
      'a2: &a2 [*a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1]',
      'a3: &a3 [*a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2]',
      'a4: &a4 [*a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3]',
    ].join('\n');
    writeFileSync(trustPath, yaml, 'utf8');
    clearTrustCache();
    await expect(loadUserTrust()).rejects.toMatchObject({ kind: 'TRUST_FILE_INVALID' });
  });
});

describe('evaluateRepo with epic reviewer requests', () => {
  const baseAutomation = {
    allowAutonomousClose: false,
    defaultMode: 'assisted' as const,
    defaultAgent: 'manual',
    defaultReviewer: 'agent',
    checksTimeoutSeconds: 1800,
  };

  const minimalConfig = {
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
    automation: baseAutomation,
    agents: {},
  } as never;

  it('reports a reviewer violation when an epic declares a panel_review with an ungranted id', () => {
    const epic = {
      id: 'E-001',
      title: 'Demo',
      status: 'planned' as const,
      adr_links: [],
      sprints: [],
      extras: {},
      file: 'epics/E-001.md',
      body: '',
      quality_rules: [
        {
          type: 'panel_review' as const,
          yellow_blocks_close: false,
          reviewers: [
            {
              id: 'critique-bot',
              command: '/never-used-here',
              args: [],
              timeoutSeconds: 300,
              failure_verdict: 'RED' as const,
              env_passthrough: [],
            },
          ],
        },
      ],
    };
    const ev = evaluateRepo(minimalConfig, EMPTY_REPO_GRANT, {
      epics: [epic as never],
    });
    expect(ev.violations.some((v) => v.scope === 'reviewer' && v.key === 'critique-bot')).toBe(
      true,
    );
  });

  it('returns no reviewer violations when the grant lists the reviewer id', () => {
    const epic = {
      id: 'E-001',
      title: 'Demo',
      status: 'planned' as const,
      adr_links: [],
      sprints: [],
      extras: {},
      file: 'epics/E-001.md',
      body: '',
      quality_rules: [
        {
          type: 'panel_review' as const,
          yellow_blocks_close: false,
          reviewers: [
            {
              id: 'critique-bot',
              command: '/never-used-here',
              args: [],
              timeoutSeconds: 300,
              failure_verdict: 'RED' as const,
              env_passthrough: [],
            },
          ],
        },
      ],
    };
    const grant = {
      ...EMPTY_REPO_GRANT,
      reviewers: {
        'critique-bot': {
          command: '/local/critique',
          args: [],
          env_passthrough: [],
          timeout_seconds: 300,
        },
      },
    };
    const ev = evaluateRepo(minimalConfig, grant, { epics: [epic as never] });
    expect(ev.violations.filter((v) => v.scope === 'reviewer')).toEqual([]);
  });
});

describe('controlRepoForWorktree + repoGrantForAny (worktree inheritance)', () => {
  it('worktree path inherits the host repo grant when the .git pointer resolves', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const host = realpathSync(mkdtempSync(join(tmpdir(), 'rk-host-')));
    const worktreeName = 'wt-001';
    mkdirSync(join(host, '.git', 'worktrees', worktreeName), { recursive: true });
    const worktreeDir = realpathSync(mkdtempSync(join(tmpdir(), 'rk-wt-')));
    // worktree's .git is a file with `gitdir: <host>/.git/worktrees/<name>`
    writeFileSync(
      join(worktreeDir, '.git'),
      `gitdir: ${join(host, '.git', 'worktrees', worktreeName)}\n`,
      'utf8',
    );

    const { controlRepoForWorktree, repoGrantForAny } = await import('../src/trust/index.js');
    const control = await controlRepoForWorktree(worktreeDir);
    expect(control).not.toBeNull();
    expect(realpathSync(control as string)).toBe(host);

    // Trust is granted on the host, not the worktree.
    writeFileSync(
      trustPath,
      stringifyYaml({
        version: 1,
        repos: {
          [realpathSync(host)]: {
            checks_cmd: true,
            env_passthrough: [],
            agents: [],
            reviewers: {},
          },
        },
      }),
      'utf8',
    );
    clearTrustCache();

    const grant = await repoGrantForAny([worktreeDir, control as string]);
    expect(grant.checks_cmd).toBe(true);
  });

  it('returns null for a non-worktree cwd (its .git is a directory)', async () => {
    const { mkdirSync } = await import('node:fs');
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rk-norm-')));
    mkdirSync(join(repo, '.git'), { recursive: true });
    const { controlRepoForWorktree } = await import('../src/trust/index.js');
    expect(await controlRepoForWorktree(repo)).toBeNull();
  });
});

describe('validateForTarget (lifecycle target scoping)', () => {
  it('returns only findings rooted at the target sprint (or unscoped) in close mode', async () => {
    const { findingAppliesToTarget, validateForTarget } = await import('../src/validator/index.js');
    const finding = (kind: string, entityType: string | undefined, entityId: string | undefined) =>
      ({
        code: kind,
        severity: 'P1',
        message: kind,
        entityType,
        entityId,
      }) as never;
    const findings = [
      finding('GLOBAL', undefined, undefined),
      finding('TARGET_SPRINT', 'sprint', 'S-001'),
      finding('OTHER_SPRINT', 'sprint', 'S-002'),
      finding('TARGET_REVIEW', 'review', 'R-001'),
      finding('OTHER_REVIEW', 'review', 'R-002'),
    ];
    const graph = {
      sprints: new Map([
        ['S-001', { id: 'S-001', epic_id: 'E-001' } as never],
        ['S-002', { id: 'S-002', epic_id: 'E-001' } as never],
      ]),
      reviews: new Map([
        ['R-001', { id: 'R-001', sprint_id: 'S-001' } as never],
        ['R-002', { id: 'R-002', sprint_id: 'S-002' } as never],
      ]),
      queuesByLane: new Map<string, never>(),
    } as never;
    const close = validateForTarget(findings, 'S-001', graph, 'close');
    const codes = close.map((f) => (f as { code: string }).code);
    expect(codes).toEqual(['GLOBAL', 'TARGET_SPRINT', 'TARGET_REVIEW']);
    const global = validateForTarget(findings, 'S-001', graph, 'global');
    expect(global).toEqual(findings);
    const otherSprint = findings[2];
    if (!otherSprint) throw new Error('test fixture missing OTHER_SPRINT finding');
    expect(findingAppliesToTarget(otherSprint, 'S-001', graph)).toBe(false);
  });
});

describe('TaskAliasSchema + parseTaskAlias', () => {
  it('parses a well-formed alias', async () => {
    const { TaskAliasSchema } = await import('../src/schemas/index.js');
    const parsed = TaskAliasSchema.parse({
      id: 'T-001',
      epic_id: 'E-001',
      sprint_id: 'S-001',
      source: 'inline',
      title: 'Demo',
      created_at: '2026-05-19T00:00:00.000Z',
      closed_at: null,
      status: 'active',
    });
    expect(parsed.id).toBe('T-001');
  });

  it('parseTaskAlias rejects when the filename id does not match the body id', async () => {
    const { parseTaskAlias } = await import('../src/schemas/index.js');
    const data = {
      id: 'T-001',
      epic_id: 'E-001',
      sprint_id: 'S-001',
      source: 'inline',
      title: 'Demo',
      created_at: '2026-05-19T00:00:00.000Z',
      closed_at: null,
      status: 'active',
    };
    const result = parseTaskAlias(data, 'T-099');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not match filename/);
  });

  it('parseTaskAlias rejects unknown fields (strict)', async () => {
    const { parseTaskAlias } = await import('../src/schemas/index.js');
    const data = {
      id: 'T-001',
      epic_id: 'E-001',
      sprint_id: 'S-001',
      source: 'inline',
      title: 'Demo',
      created_at: '2026-05-19T00:00:00.000Z',
      closed_at: null,
      status: 'active',
      garbage: 'should be rejected',
    };
    const result = parseTaskAlias(data);
    expect(result.ok).toBe(false);
  });
});

describe('partitionCommandEvidence (transitional vs blocking)', () => {
  it('classifies failed entries by transitional flag', async () => {
    const { partitionCommandEvidence } = await import('../src/schemas/review.js');
    const evidence = [
      {
        label: 'a',
        status: 'failed',
        ran_at: '2026-05-19T00:00:00.000Z',
      },
      {
        label: 'b',
        status: 'failed',
        ran_at: '2026-05-19T00:00:00.000Z',
        transitional: true,
      },
      {
        label: 'c',
        status: 'passed',
        ran_at: '2026-05-19T00:00:00.000Z',
      },
    ] as never;
    const { blocking_failures, transitional_failures } = partitionCommandEvidence(evidence);
    expect(blocking_failures.map((e) => e.label)).toEqual(['a']);
    expect(transitional_failures.map((e) => e.label)).toEqual(['b']);
  });
});

describe('assertContainsRealpath (symlink escape defense)', () => {
  it('returns the canonical absolute when the path is contained', async () => {
    const { assertContainsRealpath } = await import('../src/schemas/index.js');
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'rk-realguard-')));
    const out = await assertContainsRealpath(cwd, 'epics/E-001.md');
    expect(out.startsWith(cwd)).toBe(true);
  });

  it('rejects a symlink that escapes the cwd', async () => {
    const { symlinkSync, mkdirSync } = await import('node:fs');
    const { assertContainsRealpath } = await import('../src/schemas/index.js');
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'rk-realguard-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'rk-outside-')));
    mkdirSync(join(cwd, 'inside'));
    symlinkSync(outside, join(cwd, 'inside', 'evil'));
    await expect(assertContainsRealpath(cwd, 'inside/evil/foo')).rejects.toMatchObject({
      kind: 'IO_ERROR',
    });
  });
});
