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

// The worktree RepoKernel hands the agent is already isolated, so the safe
// default confines codex writes to it with `workspace-write` (network off).
// Tasks that genuinely need full host access or network (installing deps,
// fetching) opt in by name via the `codex-danger` preset.
const codexPreset = (sandbox: string): AgentDefinition => ({
  command: 'codex',
  args: [
    'exec',
    '--cd',
    '{worktree}',
    '--sandbox',
    sandbox,
    'Read and follow the RepoKernel sprint packet at {packet_path}. Emit the required RepoKernel sentinel block when complete.',
  ],
  resultFormat: 'sentinel-json',
  timeoutSeconds: 1800,
  envPassthrough: [...BUILTIN_PRESET_PASSTHROUGH],
});

export const BUILTIN_PRESETS: Readonly<Record<string, AgentDefinition>> = {
  claude: {
    command: 'claude',
    args: [
      '--print',
      'Read the RepoKernel sprint packet at {packet_path}, implement every requirement, git commit all changes, then output the REPOKERNEL_RESULT_START/REPOKERNEL_RESULT_END sentinel JSON exactly as specified in the packet. Execute immediately without asking for confirmation.',
    ],
    resultFormat: 'sentinel-json',
    timeoutSeconds: 1800,
    envPassthrough: [...BUILTIN_PRESET_PASSTHROUGH],
  },
  codex: codexPreset('workspace-write'),
  'codex-danger': codexPreset('danger-full-access'),
};
