---
status: current
last_verified: 2026-07-02
release: v0.2.4
title: "Use OpenSIP with AI agents"
audience: [getting-started, ci-integrators]
purpose: "Three agent loops — Discover, Edit, Final — over the machine-first CLI surface."
source-files:
  - packages/cli/src/commands/agent-catalog.ts
  - packages/contracts/src/agent-filters.ts
  - packages/core/src/lib/git-changed-files.ts
  - packages/graph/engine/src/cli/impact.ts
  - packages/mcp/src/command.ts
related-docs:
  - ../70-reference/01-cli-commands.md
  - ../70-reference/04-json-output-schema.md
  - ./08-connect-mcp-clients.md
  - ../../decisions/ADR-0084-mcp-server-surface.md
  - ../../decisions/ADR-0085-change-detection-substrate.md
  - ../../decisions/ADR-0086-signal-repair-metadata.md
  - ../../decisions/ADR-0109-mcp-first-agent-guidance-init-refresh.md
  - ../../decisions/ADR-0110-host-owned-review-brief-contract.md
---
# Use OpenSIP with AI agents

OpenSIP CLI is designed for coding agents: structured `--json` output, session
history, composable filters, and conventional agent recipes. This guide walks
the three loops agents should follow.

`opensip init` creates `AGENTS.md` when absent and refreshes a managed
MCP-first guidance block in known agent-instruction files. Re-running
`opensip init` on an already configured project is safe: it refreshes
`.gitignore` and the managed guidance block without rewriting config or example
scaffolds unless `--keep` or `--remove` is explicit.

## Discover

Start every session by learning what commands and output shapes exist:

```bash
opensip agent-catalog --json
```

The catalog lists tool entry points, common patterns, agent recipes, and notes
about `--filter` / `--raw` / `graph impact`.

For PR review workflows, read the host-owned audit review brief before drilling
into individual tool payloads:

```bash
opensip suite run audit --changed --json
```

The `data.reviewBrief` payload gives one verdict, bounded `topRisks[]`,
baseline/degradation notes, and `signalRef` pointers back to the source
envelopes. It is the interim read-side review surface until the MCP
`review_change` tool lands; do not re-run hidden analysis or inspect raw logs to
answer a question that the brief/session evidence already answers.

When the user says a tool **already reported findings**, use the OpenSIP MCP
result tools first: `get_latest_findings`, `show_run`, or `list_runs`. If MCP is
unavailable, inspect the latest stored result through session replay before
re-running:

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

## MCP (Cursor, Claude Code, Codex)

For agents that support [Model Context Protocol](https://modelcontextprotocol.io),
register `opensip mcp` as a stdio server instead of shelling out for every graph
or findings query. The server exposes 13 tools: graph traversal (`who_calls`,
`blast_radius`, …) and result replay (`get_latest_findings`, `show_run`, …).

For existing-result questions, MCP is the first source of truth. Do not grep
`.runtime/logs`, read `datastore.sqlite` directly, or re-run `fit` / `graph` /
`yagni` / `sim` just to answer what the last stored run reported; those are
fallback/debug paths. See
[ADR-0109](../../decisions/ADR-0109-mcp-first-agent-guidance-init-refresh.md).

Setup is client-specific (JSON vs TOML, config file locations, approval flows).
See **[Connect MCP clients](./08-connect-mcp-clients.md)** for copy-paste config for
Cursor, Claude Code, and Codex.
