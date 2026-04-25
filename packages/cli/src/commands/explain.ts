import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { allFindingCodes, explainCode } from '../ux/explanations.js';
import type { CommandResult } from './validate.js';

export interface ExplainCommandOptions {
  readonly code: string;
}

export function runExplainCommand(opts: ExplainCommandOptions): CommandResult {
  const explanation = explainCode(opts.code);
  if (!explanation) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `unknown finding code "${opts.code}"\nKnown codes: ${allFindingCodes().join(', ')}\n`,
    };
  }

  const lines = [
    explanation.code,
    '',
    'Severity:',
    `  ${explanation.severity}`,
    '',
    'Why it matters:',
    `  ${explanation.why}`,
    '',
    'Expected:',
    `  ${explanation.expected}`,
    '',
    'Fix:',
    `  ${explanation.fix}`,
  ];
  if (explanation.command) {
    lines.push('', 'Related command:', `  ${explanation.command}`);
  }
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
