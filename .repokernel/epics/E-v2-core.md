---
id: E-v2-core
title: "RepoKernel V2: Market Validation & Local-First Orchestration"
status: planned
description: |
  OpenAI Symphony validates the market: agent coordination is the bottleneck.
  
  RepoKernel V2 builds local-first, Git-native workflow state orchestration.
  Control plane is `.repokernel/` YAML, not a tracker daemon. Agents operate 
  via CLI/plugin. Tracker (Linear, Jira) is optional bridge, not source of truth.
  
  Competitive positioning: small, offline-first, agent-agnostic, merge-safe state.
  No daemon. No API lock-in.
  
  Key changes: merge-safe registry, team status visibility, tracker/PR bridges,
  per-state dispatch, stall detection.
---

## Why This Matters

Symphony (21k+ GitHub stars) demonstrates coding agent coordination is a real need:
- Teams manage work through trackers
- Agents pull tasks and iterate
- 500% PR increase in 3 weeks at OpenAI

RepoKernel's thesis is identical—but different control plane.

## Differentiation

| Aspect | Symphony | RepoKernel V2 |
|--------|----------|---------------|
| Source of truth | Linear tracker | Git `.repokernel/` YAML |
| Runtime | Daemon + Codex Server | CLI/plugin, local-first |
| Offline | No | Yes |
| Agent-agnostic | No (Codex-centric) | Yes (Claude, Codex, any) |
| Tracker required | Yes | Optional (bridge) |

## Success Metrics

- P0: Merge-safe state works (no registry corruption on concurrent writes)
- P1: Team status visible (`rk team status --json` shows active/blocked/ready)
- P1: Tracker bridge works (Linear issue → RK sprint → PR update)
- P2: Per-state dispatch + stall detection operational
- Market: V2 launch positions as "local-first Symphony alternative"

## Roadmap Overview

- **P0 (Existential)**: Merge-safe state
- **P1 (Visibility)**: Team status, tracker bridge, PR bridge
- **P2 (Dispatch)**: Per-state concurrency, stall detection, atomic claims
