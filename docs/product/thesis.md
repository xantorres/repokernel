# Thesis

## Why RepoKernel exists

AI coding agents (Claude, Codex, Cursor, Copilot, and successors) can now read repos, edit files, run commands, open PRs, and continue work across sessions. Their weakness is not generation. Their weakness is *context discipline*: they have no deterministic way to ask the repo "what's safe to do right now?" and get a trustworthy answer.

Without that, agents:

- pick up stale plans from old markdown
- act on partial reviews
- branch from the wrong base
- collide with other agents on the same lane
- mark sprints shipped with no review or no diff
- accumulate registry drift that nobody notices
- get blocked by ambiguous IDs and silent parse failures

A human reviewing the same repo would catch most of these in five minutes. Agents currently don't.

## What RepoKernel is

RepoKernel is a local-first, Git-native correctness engine for AI coding workflows. It validates repo project state before agents execute.

Inputs: markdown + YAML files in the repo (epics, sprints, reviews, queues, lanes), plus a config file.

Outputs:

- a deterministic finding list (with severity codes, agent-stable strings)
- a canonical machine-readable registry
- a "next runnable sprint" decision
- exit codes that scripts and agents can branch on

The product is the validator. Everything else is packaging.

## What RepoKernel is not

- not a UI
- not a task tracker
- not a sprint planner
- not an AI project manager
- not a notebook
- not a dashboard
- not a hosted service
- not a prompt framework
- not a model adapter

RepoKernel does not manage tasks. It validates execution state.

## Design principles

1. **Schema first.** Markdown is for humans. Frontmatter is the contract.
2. **Deterministic state machine.** No lifecycle inference from prose.
3. **Git native.** Git is the audit trail and diff source.
4. **Local first.** No hosted service, no DB.
5. **Human readable.** Authoritative files stay plain text.
6. **Agent portable.** Every agent reads the same validated state.
7. **Fail loudly.** Malformed state must produce findings.
8. **No hidden magic.** Every action is reproducible via CLI.
9. **No project-specific code.** Policies live in config, not in framework code.
10. **Diff correctness is sacred.** Review diff = `base_sha..HEAD`, never dates.
11. **Never stage broadly.** No lifecycle command may use `git add .`.
12. **Generated state must not silently drift.**

## v0 promise

> Before Claude, Codex, Cursor, or Copilot touches a repo, RepoKernel proves what work is valid, runnable, reviewed, scoped, and safe.

If RepoKernel says blocked, the agent stops.

If RepoKernel says runnable, the agent gets a precise validated next sprint.
