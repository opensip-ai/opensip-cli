---
status: current
last_verified: 2026-06-27
release: v0.1.15
title: "Use OpenSIP with AI agents"
audience: [getting-started, ci-integrators]
purpose: "Three agent loops — Discover, Edit, Final — over the machine-first CLI surface."
source-files:
  - packages/cli/src/commands/agent-catalog.ts
  - packages/contracts/src/agent-filters.ts
  - packages/core/src/lib/git-changed-files.ts
  - packages/graph/engine/src/cli/impact.ts
related-docs:
  - ../70-reference/01-cli-commands.md
  - ../70-reference/04-json-output-schema.md
  - ../../decisions/ADR-0085-change-detection-substrate.md
  - ../../decisions/ADR-0086-signal-repair-metadata.md
---
# Use OpenSIP with AI agents

OpenSIP CLI is designed for coding agents: structured `--json` output, session
history, composable filters, and conventional agent recipes. This guide walks
the three loops agents should follow.

`opensip init` writes a short `AGENTS.md` playbook at the project root
(write-if-absent) with the same commands.

## Discover

Start every session by learning what commands and output shapes exist:

```bash
opensip agent-catalog --json
```

The catalog lists tool entry points, common patterns, agent recipes, and notes
about `--filter` / `--raw` / `graph impact`.

When the user says a tool **already reported findings**, inspect the latest
stored result before re-running:

```bash
opensip sessions show latest --tool fit --json --filter errors-only --filter top:20
```

See [ADR-0085](../../decisions/ADR-0085-change-detection-substrate.md) for how
change detection and filtering share one substrate.

## Edit loop

After each code change, run a bounded fast pass, then check blast radius:

```bash
opensip fit --recipe agent-fast --json --filter errors-only --top 20
opensip graph impact --changed --json --top 20
opensip fit --changed --include-impacted --json
```

- `agent-fast` — cheap, high-confidence checks (console.log, secrets, skipped tests, …).
- `graph impact` — what changed and what depends on it (git or explicit `--files`).
- `fit --changed` — only checks whose targets intersect changed (+ impacted) files.

If git or the graph catalog is unavailable, fit degrades gracefully with a
warning — it does not crash.

Use `--raw` when you need the smallest payload (no `CommandOutcome` wrapper):

```bash
opensip fit --json --raw --filter errors-only
```

Signals may carry structured repair guidance under `signal.repair` — see
[ADR-0086](../../decisions/ADR-0086-signal-repair-metadata.md).

## Final handoff

Before handing work back, run the full verification tier and compare against
baseline:

```bash
opensip fit --recipe agent-final --gate-compare
opensip graph --recipe agent-final --gate-compare
```

`agent-final` runs all enabled checks/rules — equivalent to the CI gate. The
gate compares against stored baselines; filtered views do not affect gate
verdicts (live runs deliver the unfiltered envelope for egress and sessions).

## Agent recipes

| Recipe | Tool | Purpose |
|---|---|---|
| `agent-fast` | fit | Bounded cheap checks for edit loops |
| `agent-risk` | fit, graph | Architecture / security / high-impact |
| `agent-final` | fit, graph | Full verification (CI-equivalent) |

Projects can override built-in recipes in `opensip-cli.config.yml`.