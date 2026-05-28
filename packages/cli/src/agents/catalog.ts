import type { AgentDefinition } from '@repokernel/core';

// Built-in presets opt out of the strict env allowlist by passing through
// every common LLM-provider credential. Real-world claude/codex
// invocations need these to be useful; users authoring `agents.<name>`
// custom commands in their config get the empty default until they
// explicitly opt in via `envPassthrough`.
const BUILTIN_PRESET_PASSTHROUGH: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'CODEX_API_KEY',
  'NO_COLOR',
  'FORCE_COLOR',
];

export const BUILTIN_PRESETS: Readonly<Record<string, AgentDefinition>> = {
  claude: {
    command: 'claude',
    args: ['--print', '--cwd', '{worktree}', '-p', '{packet_path}'],
    resultFormat: 'sentinel-json',
    timeoutSeconds: 1800,
    envPassthrough: [...BUILTIN_PRESET_PASSTHROUGH],
  },
  codex: {
    command: 'codex',
    args: [
      'exec',
      '--cd',
      '{worktree}',
      '--sandbox',
      'danger-full-access',
      'Read and follow the RepoKernel sprint packet at {packet_path}. Emit the required RepoKernel sentinel block when complete.',
    ],
    resultFormat: 'sentinel-json',
    timeoutSeconds: 1800,
    envPassthrough: [...BUILTIN_PRESET_PASSTHROUGH],
  },
};
