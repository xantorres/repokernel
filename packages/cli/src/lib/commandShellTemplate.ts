export interface CommandShellInput {
  readonly name: string;
  readonly description: string;
  readonly argHint: string;
  readonly tier: string;
  readonly protocolPath: string;
}

export interface ProtocolShellInput {
  readonly name: string;
}

function yamlString(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !/^(true|false|null|yes|no)$/i.test(value)) {
    return value;
  }
  // Use double quotes and escape backslashes + double quotes.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderCommandShell(input: CommandShellInput): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`description: ${yamlString(input.description)}`);
  lines.push(`arg-hint: ${yamlString(input.argHint)}`);
  lines.push(
    `# tier: ${input.tier} -- map to your harness model (add \`model: <name>\` per your tier table)`,
  );
  lines.push('# See docs/recipes/protocol-layer.md for the canonical command + protocol pattern.');
  lines.push('---');
  lines.push(`Read \`${input.protocolPath}\`. Execute.`);
  lines.push('');
  return lines.join('\n');
}

export function renderProtocolShell(input: ProtocolShellInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.name} protocol`);
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  lines.push('- TODO: list arguments expected from the calling command');
  lines.push('');
  lines.push('## Pre-checks');
  lines.push('');
  lines.push('- TODO: rk validate / rk inspect calls before any mutation');
  lines.push('');
  lines.push('## Loop');
  lines.push('');
  lines.push('1. TODO: orchestration steps (rk commands, sub-agent spawns, decisions)');
  lines.push('');
  lines.push('## Halt conditions');
  lines.push('');
  lines.push('- TODO: when to stop and render `rk brief <ID>`');
  lines.push('');
  lines.push('## Next steps');
  lines.push('');
  lines.push('- TODO: what to surface to the operator after success or halt');
  lines.push('');
  lines.push('<!-- See docs/recipes/protocol-layer.md for the canonical pattern. -->');
  lines.push('');
  return lines.join('\n');
}
