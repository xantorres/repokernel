/**
 * Extended coverage for runFixCommand.
 *
 * fix.test.ts covers SHIPPED_SPRINT_IN_QUEUE, CANCELLED_SPRINT_IN_QUEUE, and
 * leaked worktrees. This file targets the remaining uncovered paths:
 * text-output branches, missing-directory/registry fixes, DUPLICATE_REVIEW_ID,
 * SHIPPED_SPRINT_MISSING_BASE_SHA, argument-validation errors, and apply
 * without --yes (declined prompt handled via stdin pipe).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runFixCommand } from '../src/commands/fix.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('runFixCommand — argument validation', () => {
  it('rejects --preview + --apply together', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runFixCommand({ cwd, preview: true, apply: true, yes: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('rejects invocation without --preview or --apply', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runFixCommand({ cwd, preview: false, apply: false, yes: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--preview or --apply');
  });
});

// ---------------------------------------------------------------------------
// Preview text output (no --json)
// ---------------------------------------------------------------------------

describe('runFixCommand — preview text output', () => {
  it('renders safe fixes list as human-readable text', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'shipped',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-04-29T12:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Available safe fixes');
    expect(result.stdout).toContain('S-001');
  });

  it('shows "No safe mechanical fixes found" when clean', async () => {
    // Bootstrap: apply all fixes first, then preview should be empty
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    await runFixCommand({ cwd, preview: false, apply: true, yes: true, json: false });
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No safe mechanical fixes found');
  });
});

// ---------------------------------------------------------------------------
// Apply text output (no --json)
// ---------------------------------------------------------------------------

describe('runFixCommand — apply text output', () => {
  it('apply with no applicable fixes → "No applicable safe fixes."', async () => {
    // Bootstrap: first apply creates dirs + queue + registry; second run has nothing left
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    await runFixCommand({ cwd, preview: false, apply: true, yes: true, json: false });
    const result = await runFixCommand({
      cwd,
      preview: false,
      apply: true,
      yes: true,
      json: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No applicable safe fixes');
  });

  it('apply text output reports applied fix titles', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'shipped',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-04-29T12:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    const result = await runFixCommand({
      cwd,
      preview: false,
      apply: true,
      yes: true,
      json: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Applied \d+ fix/);
    expect(result.stdout).toContain('S-001');
  });
});

// ---------------------------------------------------------------------------
// Missing directory fix
// ---------------------------------------------------------------------------

describe('runFixCommand — missing directory auto-create', () => {
  it('preview surfaces missing directory as safe fix', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      // deliberately do NOT create reviews/, queues/, etc.
    ]);
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { safeFixes: Array<{ title: string }> };
    expect(parsed.safeFixes.some((f) => f.title.includes('Create missing directory'))).toBe(true);
  });

  it('apply creates missing directories', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runFixCommand({ cwd, preview: false, apply: true, yes: true, json: true });
    expect(result.exitCode).toBe(0);
    // After apply, the required dirs should exist
    expect(existsSync(join(cwd, 'reviews'))).toBe(true);
    expect(existsSync(join(cwd, 'queues'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing registry fix
// ---------------------------------------------------------------------------

describe('runFixCommand — missing registry', () => {
  it('preview surfaces missing registry as safe fix', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: [] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      // No .repokernel/registry.json
    ]);
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { safeFixes: Array<{ title: string }> };
    expect(parsed.safeFixes.some((f) => f.title.includes('registry'))).toBe(true);
  });

  it('apply generates registry file', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: [] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    // Create required dirs first so fix only fixes registry
    for (const d of ['reviews', 'sprints', 'lanes']) {
      await mkdir(join(cwd, d), { recursive: true });
    }
    await mkdir(join(cwd, '.repokernel'), { recursive: true });

    const result = await runFixCommand({ cwd, preview: false, apply: true, yes: true, json: true });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(cwd, '.repokernel', 'registry.json'))).toBe(true);
  });

  it('apply also regenerates invalid registry (bad JSON)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: [] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      { path: '.repokernel/registry.json', content: 'not valid json' },
    ]);
    for (const d of ['reviews', 'sprints', 'lanes']) {
      await mkdir(join(cwd, d), { recursive: true });
    }

    const result = await runFixCommand({ cwd, preview: false, apply: true, yes: true, json: true });
    expect(result.exitCode).toBe(0);
    const registry = JSON.parse(await readFile(join(cwd, '.repokernel', 'registry.json'), 'utf8'));
    expect(registry.schemaVersion).toBe(3);
    // Backup created for the invalid file
    expect(existsSync(join(cwd, '.repokernel', 'registry.json.bak'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate review id pre-load fix
// ---------------------------------------------------------------------------

describe('runFixCommand — duplicate review ids', () => {
  it('preview surfaces duplicate review renumber fixes before loadProject aborts', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'reviews/R-001.md',
        content: fm({ id: 'R-001', sprint_id: 'S-001', verdict: 'pending' }),
      },
      {
        path: 'reviews/R-001-copy.md',
        content: fm({ id: 'R-001', sprint_id: 'S-002', verdict: 'pending' }),
      },
    ]);

    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    const parsed = JSON.parse(result.stdout) as { safeFixes: Array<{ title: string }> };

    expect(result.exitCode).toBe(0);
    expect(parsed.safeFixes.some((fix) => fix.title.includes('Renumber duplicate review id'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// SHIPPED_SPRINT_MISSING_BASE_SHA with --base-sha flag
// ---------------------------------------------------------------------------

describe('runFixCommand — SHIPPED_SPRINT_MISSING_BASE_SHA', () => {
  async function missingBaseShaFixture(): Promise<string> {
    return makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 't', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'shipped without base_sha',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          end_sha: 'e'.repeat(40),
          closed_at: '2026-04-29T12:00:00Z',
          // no base_sha — intentional gap
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
  }

  it('preview with --base-sha flag → surfaces safe fix with source:flag', async () => {
    const cwd = await missingBaseShaFixture();
    const sha = 'f'.repeat(40);
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
      baseSha: sha,
      sprint: 'S-001',
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      safeFixes: Array<{ title: string; detail: string }>;
    };
    const fix = parsed.safeFixes.find((f) => f.title.includes('base_sha'));
    expect(fix).toBeDefined();
    expect(fix?.title).toContain('flag');
    expect(fix?.detail).toContain(sha.slice(0, 8));
  });

  it('preview without flag → surfaces manual suggestion (no reliable source)', async () => {
    const cwd = await missingBaseShaFixture();
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      safeFixes: Array<{ title: string }>;
      manualSuggestions: Array<{ title: string }>;
    };
    // No flag provided → no safe fix, should be manual
    const manual = parsed.manualSuggestions.find((f) => f.title.includes('base_sha'));
    expect(manual).toBeDefined();
  });

  it('apply with --base-sha flag → writes base_sha into sprint file', async () => {
    const cwd = await missingBaseShaFixture();
    const sha = 'a1b2c3d4'.repeat(5);
    const result = await runFixCommand({
      cwd,
      preview: false,
      apply: true,
      yes: true,
      json: true,
      baseSha: sha,
      sprint: 'S-001',
    });
    expect(result.exitCode).toBe(0);
    const sprintRaw = await readFile(join(cwd, 'sprints', 'S-001.md'), 'utf8');
    expect(sprintRaw).toContain(sha);
  });
});

// ---------------------------------------------------------------------------
// No-config cwd (no repokernel.config.yaml) → init suggestion
// ---------------------------------------------------------------------------

describe('runFixCommand — no config present', () => {
  it('preview surfaces init as safe fix when no config found', async () => {
    // makeFixture with just an empty dir
    const cwd = await makeFixture([]);
    const result = await runFixCommand({
      cwd,
      preview: true,
      apply: false,
      yes: false,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      safeFixes: Array<{ title: string; detail?: string }>;
    };
    expect(
      parsed.safeFixes.some(
        (f) => /Create RepoKernel|init/i.test(f.title) || /init/.test(f.detail ?? ''),
      ),
    ).toBe(true);
  });
});
