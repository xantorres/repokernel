import { describe, expect, it } from 'vitest';
import { BANNER_DOCS_URL, formatPostInitBanner } from '../src/commands/initBanner.js';
import type { InitChoices } from '../src/commands/initPrompts.js';

const PATHS = {
  config: 'repokernel.config.yaml',
  planDir: '.repokernel/plan',
};

function choices(overrides: Partial<InitChoices> = {}): InitChoices {
  return {
    agent: 'manual',
    lane: 'main',
    checksCmd: null,
    example: false,
    ...overrides,
  };
}

describe('formatPostInitBanner', () => {
  it('renders the manual/no-example variant', () => {
    const out = formatPostInitBanner(choices(), PATHS);
    expect(out).toContain('RepoKernel initialized.');
    expect(out).toContain('agent:     manual');
    expect(out).toContain('lane:      main');
    expect(out).toContain('Before running worktree tasks:');
    expect(out).toContain('git add -- repokernel.config.yaml .repokernel');
    expect(out).toContain('Then:');
    expect(out).toContain('rk run -m "Add a README section" --agent fake');
    expect(out).not.toContain('rk next                # picks S-002');
    expect(out).toContain(BANNER_DOCS_URL);
  });

  it('renders the committed fastpath variant', () => {
    const out = formatPostInitBanner(choices(), PATHS, { committed: true });
    expect(out).toContain('Ready for fastpath:');
    expect(out).toContain('rk run -m "Add a README section" --agent fake');
    expect(out).not.toContain('git add -- repokernel.config.yaml .repokernel');
  });

  it('renders the example/fake variant', () => {
    const out = formatPostInitBanner(choices({ agent: 'fake', example: true }), PATHS);
    expect(out).toContain('agent:     fake');
    expect(out).toContain('Try:');
    expect(out).toContain('rk next                # picks S-002 from the starter epic');
    expect(out).toContain('git add -- repokernel.config.yaml .repokernel');
    expect(out).not.toContain('No plan yet?');
  });

  it('includes custom plan dir in git add hint when outside .repokernel', () => {
    const customPaths = { config: 'repokernel.config.yaml', planDir: 'plan' };
    const out = formatPostInitBanner(choices(), customPaths);
    expect(out).toContain('git add -- repokernel.config.yaml .repokernel plan');
    expect(out).not.toContain('git add -- repokernel.config.yaml .repokernel &&');
  });

  it('does not duplicate .repokernel in git add hint for default plan dir', () => {
    const out = formatPostInitBanner(choices(), PATHS);
    expect(out).toContain('git add -- repokernel.config.yaml .repokernel &&');
    expect(out).not.toContain('.repokernel .repokernel');
  });

  it('shows the checks command when set', () => {
    const out = formatPostInitBanner(choices({ checksCmd: 'pnpm test' }), PATHS);
    expect(out).toContain('checks:    pnpm test');
  });

  it('omits the checks line when null', () => {
    const out = formatPostInitBanner(choices(), PATHS);
    expect(out).not.toMatch(/^\s*checks:/m);
  });

  it('always includes the docs URL', () => {
    const variants: ReadonlyArray<Partial<InitChoices>> = [
      {},
      { example: true, agent: 'fake' },
      { agent: 'claude' },
      { agent: 'codex', checksCmd: 'cargo test' },
    ];
    for (const v of variants) {
      expect(formatPostInitBanner(choices(v), PATHS)).toContain(BANNER_DOCS_URL);
    }
  });
});
