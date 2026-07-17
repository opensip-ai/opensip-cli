---
status: current
last_verified: 2026-07-15
release: v0.7.0
title: "Use OpenSIP with AI agents"
audience: [getting-started, ci-integrators]
purpose: "Three agent loops — Discover, Edit, Final — over the machine-first CLI surface."
source-files:
  - packages/cli/src/commands/agent-catalog.ts
  - packages/contracts/src/agent-catalog-assembly.ts
  - packages/contracts/src/agent-catalog.ts
  - packages/mcp/src/tools/get-agent-catalog.ts
  - packages/contracts/src/agent-filters.ts
  - packages/contracts/src/impact-trust.ts
  - packages/contracts/src/review-brief-correlation.ts
  - packages/core/src/lib/git-changed-files.ts
  - packages/graph/engine/src/cli/impact.ts
  - packages/fitness/engine/src/cli/fit/changed-targeting.ts
  - packages/mcp/src/command.ts
  - packages/contracts/src/task-context.ts
  - packages/cli/src/commands/suite/task-context-manifest.ts
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
  - ../../decisions/ADR-0155-canonical-audit-command.md
  - ../../decisions/ADR-0156-bounded-stored-impact-proof.md
  - ../../decisions/ADR-0160-deterministic-task-context-evidence-plane.md
  - ../../decisions/ADR-0161-codebase-inventory-and-context-snapshot-ownership.md
  - ../../decisions/ADR-0166-agent-catalog-transport-parity.md
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

### Prepare before editing

When the task names one or more files, prepare deterministic context before the
first edit:

```bash
opensip suite run agent-context --files packages/mcp/src/command.ts --json
```

The built-in suite records package/file inventory, the exact graph generation,
and labelled static test-selection evidence in one parent Run
`contextManifest`. It does not execute selected tests, emit findings, create a
ReviewBrief, or call a model. Inventory and graph are required; test selection
is required when `--files` is supplied. Read `readiness`, each plane's
`coverage`/reason codes, and `nextActions` before relying on it.

With MCP, call `get_agent_catalog` and verify root/surface epoch/tool names,
then call `get_context_status` with the same explicit `files`. Trust the replay
only when the response is `available`, `fileScope.status` is `matched`,
`manifest.readiness` is `ready`, and every required plane is current, complete,
uncapped, and backed by a pointer whose replay status is `available`. Run the
suite whenever one of those conditions fails. During the edit use
`get_file_context`, `impact_files`, `select_tests`, and entity-detail
`get_symbol` as needed. Ordinary reads never build a graph, invoke Git, execute
tests, or start the suite, and recorded snapshot pointers are never silently
rebound to newer evidence. Status replay also compares the recorded inventory
identity with a newly computed bounded metadata inventory, but never returns or
substitutes the replacement identity.

For PR review workflows, read the host-owned audit review brief before drilling
into individual tool payloads:

```bash
opensip audit --json
```

In a git repo this is changed-scope by default; use `--files <path>` for an
explicit git-free edit set, `--since <ref>` for a branch base, and `--full` only
when the review needs whole-repo evidence. `--full` conflicts with the three
changed-scope selectors. A no-Git default falls back once to full scope and
records that degradation instead of claiming changed-only coverage.

The `data.reviewBrief` payload gives one verdict, bounded `topRisks[]`,
bounded `newFindings[]` (baseline-marked net-new risks; can diverge from
`topRisks` when older high-severity risks fill the top cap), optional
`correlatedRisks[]`, baseline/degradation notes, and `signalRef` pointers back
to the source envelopes. Inspect `correlatedRisks[]` first when it is present:
it shows when multiple tools are pointing at the same symbol, graph node, file
range, package, or fingerprint. Treat those groups as navigation only, then
follow each member's `signalRef` before changing code. When the human report is
open, Change Impact lists **Top risks** and **New findings** as separate
sections so net-new findings are not lost. When MCP is available, prefer the
`review_change` tool for the same read-side review shape over persisted suite
evidence; do not re-run hidden analysis or inspect raw logs to answer a question
that the brief/session evidence already answers.

Also inspect `data.steps[].verification` before claiming complete scoped
coverage. Current results return optional `data.runId`, the authoritative
persisted parent Run ID; absence means persistence was unavailable, not that
`suiteRunId` should be substituted. The linked graph session retains bounded
impact detail and a catalog identity for the human report, while the emitted
envelope verification remains the full trust authority.

Top-level `audit` and `opensip suite run audit` always use the same curated
built-in definition. The suite name `audit` is reserved (ADR-0159): config
validation rejects a configured `suites.audit`, so nothing can shadow the
canonical review. Name custom multi-tool workflows something else
(`audit-custom`, `nightly-review`, …) and run them with `suite run <name>`.
Agents never need `--open`: JSON, CI, non-TTY, and remote-shell execution
suppresses browser launch, and machine evidence is complete without a browser.

When the user says a tool **already reported findings**, use the OpenSIP MCP
result tools first: `get_latest_findings`, `show_run`, or `list_runs`. If MCP is
unavailable, inspect the latest stored result through session replay before
re-running:

```bash
opensip sessions show latest --tool fit --json --filter errors-only --filter top:20
```

See [ADR-0085](../../decisions/ADR-0085-change-detection-substrate.md) for how
change detection and filtering share one substrate.
See [ADR-0155](../../decisions/ADR-0155-canonical-audit-command.md) for canonical
audit placement and [ADR-0156](../../decisions/ADR-0156-bounded-stored-impact-proof.md)
for the stored report-evidence boundary.

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
or findings query. Treat live `listTools` and `get_agent_catalog.mcp.toolNames` as
the inventory authority. Mutation opt-in adds only `repair_apply_verify`; the
default server remains read-only apart from explicit `refresh_graph` rebuilds.

### The catalog is the same across both transports

`opensip agent-catalog --json` and the MCP `get_agent_catalog` tool return the
**same common catalog body** for the same invocation and project: identical
entry points, common patterns, output shapes, notes, `reservedNames` (the
host-owned root commands and built-in suite names from ADR-0159), bounded
`projectContext.targetConventions`, and the same honest `hostSupport`
assessment (the process-only platform-support projection from Plan 02). One pure
assembler in `@opensip-cli/contracts` produces that body for both transports, so
you can rely on either surface without re-deriving facts (see
[ADR-0166](../../decisions/ADR-0166-agent-catalog-transport-parity.md)).

The MCP response adds **one** extra top-level object — `mcp` — that the CLI
never emits. It is live connector diagnosis, not part of the shared catalog:

| `mcp` field | Meaning |
|---|---|
| `version` | The running MCP server version. |
| `surfaceEpoch` | The tool-surface epoch; a change means the registered tool set changed. |
| `toolNames` / `toolCount` | The live registered tool inventory (authority for what you can call). |
| `mutationPosture` | Whether mutation is enabled (`repair_apply_verify` present) or read-only. |
| `project.root` / `project.scope` | The captured project root and its scope binding. |

Treat the `mcp` object as connector identity only. When `surfaceEpoch`,
`toolNames`, or `version` no longer match what your client cached, **reconnect
the MCP process/connection** — do not call `refresh_graph`. `refresh_graph`
rebuilds graph evidence and can never repair a stale connector inventory
(ADR-0153).

Both catalog reads are **read-only**: assembling the catalog builds no graph,
runs no analysis, invokes no Git or tests, and creates no session — over either
transport.

To compare the two surfaces programmatically, drop only the top-level `mcp`
object; the rest must match:

```bash
# CLI body (the catalog is nested under data.catalog in the CommandOutcome)
opensip agent-catalog --json | jq '.data.catalog'

# MCP get_agent_catalog result, minus the connector overlay, is byte-identical
jq 'del(.mcp)' mcp-get-agent-catalog.json
```

Before using graph evidence, verify the canonical project context, distinct
project and `g1:` generation identities, generation source, complete/partial
freshness reasons, effective filters, evidence kind/confidence, truncation and
hard-cap reasons, and cursor continuation. A newly persisted external
`opensip graph` catalog auto-loads on the next ordinary read; do not call
`refresh_graph` merely to reload it. Reserve refresh for missing/stale evidence
that explicitly needs a new build.

Use `package_dependencies`, `why_depends`, and `package_cycles` for labelled
call/import boundary evidence. Use `get_runtime_wiring` / `search_declarations` / `references_to` for admitted
manifest/registry/CommandSpec/host-mount paths that static traversal cannot
prove. Direct source, configuration, and tests remain the final proof.

For existing-result questions, MCP is the first source of truth. Do not grep
`.runtime/logs`, read `datastore.sqlite` directly, or re-run `fit` / `graph` /
`yagni` / `sim` just to answer what the last stored run reported; those are
fallback/debug paths. See
[ADR-0109](../../decisions/ADR-0109-mcp-first-agent-guidance-init-refresh.md).
Catalog auto-swap/freshness is governed by
[ADR-0148](../../decisions/ADR-0148-mcp-catalog-identity-auto-swap-and-complete-freshness.md);
bounded labelled query/runtime evidence by
[ADR-0149](../../decisions/ADR-0149-bounded-labelled-mcp-audit-evidence.md).
MCP production reaches graph internals only through the public read facade in
[ADR-0147](../../decisions/ADR-0147-public-graph-read-and-fail-closed-package-boundaries.md).

Setup is client-specific (JSON vs TOML, config file locations, approval flows).
See **[Connect MCP clients](./08-connect-mcp-clients.md)** for copy-paste config for
Cursor, Claude Code, and Codex.

See also [Connect MCP clients](./08-connect-mcp-clients.md) and ADR-0152..0154 for the compact audit surface.
Task-context evidence ownership is recorded in ADR-0160 and ADR-0161.
