---
status: current
last_verified: 2026-07-02
release: v0.4.1
title: "Use OpenSIP with AI agents"
audience: [getting-started, ci-integrators]
purpose: "Three agent loops — Discover, Edit, Final — over the machine-first CLI surface."
source-files:
  - packages/cli/src/commands/agent-catalog.ts
  - packages/contracts/src/agent-filters.ts
  - packages/contracts/src/impact-trust.ts
  - packages/contracts/src/review-brief-correlation.ts
  - packages/core/src/lib/git-changed-files.ts
  - packages/graph/engine/src/cli/impact.ts
  - packages/fitness/engine/src/cli/fit/changed-targeting.ts
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
  - ../../decisions/ADR-0123-impact-analysis-trust-foundation.md
  - ../../decisions/ADR-0124-review-brief-correlation-join.md
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
opensip suite run audit --json
```

In a git repo this is changed-scope by default; use `--full` only when the
review needs whole-repo evidence.

The `data.reviewBrief` payload gives one verdict, bounded `topRisks[]`,
optional `correlatedRisks[]`, baseline/degradation notes, and `signalRef`
pointers back to the source envelopes. Inspect `correlatedRisks[]` first when it
is present: it shows when multiple tools are pointing at the same symbol, graph
node, file range, package, or fingerprint. Treat those groups as navigation
only, then follow each member's `signalRef` before changing code. When MCP is
available, prefer the `review_change` tool for the same read-side review shape
over persisted suite evidence; do not re-run hidden analysis or inspect raw logs
to answer a question that the brief/session evidence already answers.

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
- `fit --changed` — checks whose targets intersect changed (+ impacted) files when
  impact trust is full; otherwise it falls back to the full target set.

Read `graph impact` JSON `data.trust.fullyVerified` before claiming targeted
verification. If git or the graph catalog is unavailable or incomplete, fit
degrades conservatively with a warning and broader execution — it does not crash
or silently claim changed-only coverage.

Use `--raw` when you need the smallest payload (no `CommandOutcome` wrapper):

```bash
opensip fit --json --raw --filter errors-only
```

Signals may carry structured repair guidance under `signal.repair` — see
[ADR-0086](../../decisions/ADR-0086-signal-repair-metadata.md).
Preview deterministic repairs before applying them. When you apply one, use
`--verify` and treat the verification verdict literally:

```bash
opensip repair preview latest --tool fit --signal index:0 --json
opensip repair apply latest --tool fit --signal index:0 --action replace-ts-ignore --verify --json
```

Only `data.verification.status: "verified"` is a verified repair. `partial`,
`unverified`, or `skipped` means you must not tell the user the issue is fixed.
MCP mutation is off by default; `repair_apply_verify` appears only when the
server is started with `opensip mcp --allow-mutations` or
`OPENSIP_MCP_ALLOW_MUTATIONS=1`.

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
or findings query. By default the server exposes 15 read-only tools: graph traversal (`who_calls`,
`blast_radius`, …), result replay (`get_latest_findings`, `show_run`, …), and
review helpers (`review_change`, `compare_to_baseline`).

For existing-result questions, MCP is the first source of truth. Do not grep
`.runtime/logs`, read `datastore.sqlite` directly, or re-run `fit` / `graph` /
`yagni` / `sim` just to answer what the last stored run reported; those are
fallback/debug paths. See
[ADR-0109](../../decisions/ADR-0109-mcp-first-agent-guidance-init-refresh.md).

Setup is client-specific (JSON vs TOML, config file locations, approval flows).
See **[Connect MCP clients](./08-connect-mcp-clients.md)** for copy-paste config for
Cursor, Claude Code, and Codex.
