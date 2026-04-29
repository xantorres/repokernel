import type { InitChoices } from './initPrompts.js';

export interface BannerPaths {
  readonly config: string;
  readonly planDir: string;
}

const DOCS_URL = 'https://github.com/xantorres/repokernel#getting-started';

export function formatPostInitBanner(choices: InitChoices, paths: BannerPaths): string {
  const lines: string[] = [];
  lines.push('RepoKernel initialized.', '');
  lines.push('You are here:');
  lines.push(`  config:    ${paths.config}`);
  lines.push(`  plan dir:  ${paths.planDir}`);
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

  if (choices.example) {
    lines.push('Try:');
    lines.push('  rk next                # picks S-002 from the starter epic');
  } else {
    lines.push('No plan yet? Try:');
    lines.push('  rk run -m "Add a README section" --agent fake');
  }

  lines.push('', `Docs: ${DOCS_URL}`);
  return lines.join('\n');
}

export const BANNER_DOCS_URL = DOCS_URL;
