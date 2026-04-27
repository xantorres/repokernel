# Agent adapters

An agent adapter is the bridge between RepoKernel's run loop and the AI coding tool that does the actual work. RepoKernel invokes the agent, waits for it to finish, and parses a sentinel JSON result from its output.

## Sentinel format

Every agent must write the following to stdout before exiting:

```
REPOKERNEL_RESULT_START
{"status":"completed","summary":"Added JWT signing module","changed_files":["src/auth/jwt.ts","tests/auth/jwt.test.ts"],"needs_human":false}
REPOKERNEL_RESULT_END
```

The JSON between the markers is the result. Required fields:

| Field | Type | Values | Description |
|---|---|---|---|
| `status` | string | `completed`, `failed`, `blocked` | Whether the agent finished successfully |
| `summary` | string | any | Human-readable description of what was done |
| `changed_files` | string[] | repo-relative paths | Files the agent modified |
| `needs_human` | boolean | `true` / `false` | Whether the agent is requesting human intervention |

If `status` is `failed` or `blocked`, the run halts with `agent_failed:<sprint-id>`. The summary is logged for diagnosis.

## Built-in agents

### `fake`

A deterministic test agent for verifying the run loop without a real AI model.

- Reads the context packet
- Creates a `rk-fake-output.txt` file in the worktree
- Commits it
- Returns a `completed` sentinel

```bash
rk run E-001 --agent fake --limit 1
```

Use `fake` to verify your setup, test CI pipelines, or smoke-test new sprints before connecting a real agent.

### `manual`

The default agent. Instead of invoking a program, `rk run` pauses and prints the full context packet path, then waits for you to resume.

```bash
rk run E-001 --agent manual --limit 1
```

Output:

```
Sprint S-001 ready.
Context packet: /tmp/rk-packet-S-001-abc123.json
Worktree: /path/to/.repokernel-worktrees/repo/E-001/

Work on the sprint manually, then resume:
  rk run --resume RUN-001
```

`manual` is useful when you want RepoKernel to manage lifecycle and review while you (or an agent not integrated via CLI) do the actual coding.

### `claude`

Invokes the Claude CLI:

```bash
claude --print --cwd <worktree> -p <packet_path>
```

Requires the `claude` CLI installed and authenticated:

```bash
rk run E-001 --agent claude --limit 1
```

### `codex`

Invokes the Codex CLI:

```bash
codex --approval-mode full-auto -q <packet_path>
```

Requires the `codex` CLI installed and authenticated:

```bash
rk run E-001 --agent codex --limit 1
```

## External agents

You can connect any script or program as an agent by defining it in config under the `agents` key.

### Config

```yaml
agents:
  my-agent:
    command: ./scripts/run-agent.sh
    args:
      - "{packet_path}"
      - "{worktree}"
    resultFormat: sentinel-json
    timeoutSeconds: 1800
```

### Invoke

```bash
rk run E-001 --agent my-agent --limit 1
```

### Arg placeholders

Use these placeholders in the `args` array — they are substituted at runtime:

| Placeholder | Value |
|---|---|
| `{packet_path}` | Absolute path to the context packet JSON file |
| `{worktree}` | Absolute path to the agent's working directory |
| `{sprint_id}` | Sprint ID (e.g., `S-001`) |
| `{run_id}` | Run ID (e.g., `RUN-001`) |
| `{epic_id}` | Epic ID (e.g., `E-001`) |
| `{op_root}` | Root of the main checkout |
| `{registry_path}` | Absolute path to `registry.json` |
| `{mode}` | Execution mode: `assisted` or `autonomous` |

### Minimal shell agent example

```bash
#!/usr/bin/env bash
# scripts/run-agent.sh
set -euo pipefail

PACKET_PATH="$1"
WORKTREE="$2"

# Read the context packet
SPRINT_ID=$(jq -r '.sprint.id' "$PACKET_PATH")
TITLE=$(jq -r '.sprint.title' "$PACKET_PATH")

# Do the work inside the worktree
cd "$WORKTREE"
echo "# $TITLE" > "output-${SPRINT_ID}.md"
git add "output-${SPRINT_ID}.md"
git commit -m "feat: $TITLE"

# Write the sentinel result
cat <<'EOF'
REPOKERNEL_RESULT_START
{"status":"completed","summary":"Created output file","changed_files":["output-S-001.md"],"needs_human":false}
REPOKERNEL_RESULT_END
EOF
```

### Timeout

`timeoutSeconds` (default: 1800) controls how long RepoKernel waits for the agent process before killing it and marking the sprint as `failed`. Increase it for agents that need more time on large tasks.

## Choosing an agent

| Situation | Recommended agent |
|---|---|
| Verifying setup or CI pipelines | `fake` |
| Manual coding with lifecycle tracking | `manual` |
| Claude CLI integration | `claude` |
| Custom script or wrapper | External agent via config |

## Related

- [Run loop](run-loop.md) — how agents are invoked within the loop
- [Config reference](config-reference.md#agents) — full `agents` config schema
