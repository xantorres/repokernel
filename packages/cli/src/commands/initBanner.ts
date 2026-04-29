import type { InitChoices } from './initPrompts.js';

export interface BannerPaths {
  readonly config: string;
  /** Base directory for everything RepoKernel writes (e.g. `.repokernel`). */
  readonly baseDir: string;
}

export interface BannerState {
  readonly committed?: boolean;
}

const DOCS_URL = 'https://github.com/xantorres/repokernel#getting-started';

export function formatPostInitBanner(
  choices: InitChoices,
  paths: BannerPaths,
  state: BannerState = {},
): string {
  const lines: string[] = [];
  lines.push('RepoKernel initialized.', '');
  lines.push('You are here:');
  lines.push(`  config:    ${paths.config}`);
  lines.push(`  base dir:  ${paths.baseDir}`);
  lines.push(`  plan dir:  ${paths.baseDir}/plan`);
  lines.push(`  agent:     ${choices.agent}`);
  lines.push(`  lane:      ${choices.lane}`);
  if (choices.checksCmd) {
    lines.push(`  checks:    ${choices.checksCmd}`);
  }
  lines.push('');
  lines.push('Next 3 commands:');
  lines.push('  rk doctor              # verify env (git, $EDITOR, agent)');
  lines.push('  rk validate            # check repository state');
  lines.push('  rk next                # see what is runnable');
  lines.push('');

  const gitAddTargets = gitAddHintTargets(paths.baseDir);

  if (choices.example) {
    lines.push('Try:');
    lines.push('  rk next                # picks S-002 from the starter epic');
    if (state.committed !== true) {
      lines.push(`  git add -- ${gitAddTargets} && git commit -m "chore(rk): init RepoKernel"`);
    }
  } else {
    if (state.committed === true) {
      lines.push('Ready for fastpath:');
    } else {
      lines.push('Before running worktree tasks:');
      lines.push(`  git add -- ${gitAddTargets} && git commit -m "chore(rk): init RepoKernel"`);
      lines.push('');
      lines.push('Then:');
    }
    lines.push('  rk run -m "Add a README section" --agent fake');
  }

  lines.push('', `Docs: ${DOCS_URL}`);
  return lines.join('\n');
}

export const BANNER_DOCS_URL = DOCS_URL;

function gitAddHintTargets(baseDir: string): string {
  const normalized = baseDir.replaceAll('\\', '/').replace(/\/+$/, '');
  return `repokernel.config.yaml ${normalized}`;
}
