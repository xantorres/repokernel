import type { AgentDefinition } from '@repokernel/core';

export const BUILTIN_PRESETS: Readonly<Record<string, AgentDefinition>> = {
  claude: {
    command: 'claude',
    args: ['--print', '--cwd', '{worktree}', '-p', '{packet_path}'],
    resultFormat: 'sentinel-json',
    timeoutSeconds: 1800,
  },
  codex: {
    command: 'codex',
    args: ['--approval-mode', 'full-auto', '-q', '{packet_path}'],
    resultFormat: 'sentinel-json',
    timeoutSeconds: 1800,
  },
};
