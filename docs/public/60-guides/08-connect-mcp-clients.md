---
status: current
last_verified: 2026-07-11
release: v0.7.0
title: "Connect MCP clients (Cursor, Claude Code, Codex)"
audience: [getting-started, ci-integrators]
purpose: "Register opensip mcp as a stdio MCP server in Cursor, Claude Code, and Codex."
source-files:
  - packages/mcp/src/command.ts
  - packages/mcp/src/tools/register.ts
related-docs:
  - ../70-reference/01-cli-commands.md
  - ./use-opensip-with-ai-agents.md
  - ../../decisions/ADR-0084-mcp-server-surface.md
  - ../../decisions/ADR-0109-mcp-first-agent-guidance-init-refresh.md
---
# Connect MCP clients (Cursor, Claude Code, Codex)

`opensip mcp` is a long-lived stdio [Model Context Protocol](https://modelcontextprotocol.io)
server. Your coding agent spawns it as a child process and exchanges JSON-RPC over
stdin/stdout for the whole session. The server exposes the persisted call graph and
stored `fit` / `graph` / `yagni` / `sim` results — it does **not** re-run those
tools on every query.

> **What you'll understand after this:**
> - How to prepare a project so MCP can start
> - Where each client stores MCP configuration
> - Copy-paste setup for Cursor, Claude Code, and Codex
> - How to verify the connection and what to do when it fails

For the full tool catalog, freshness rules, and `symbolId` contract, see
[`mcp` in the CLI command reference](../70-reference/01-cli-commands.md#mcp--serve-the-call-graph--results-to-agents-over-stdio).

---

## 1. Prepare the project

MCP reads from `<project>/opensip-cli/.runtime/datastore.sqlite`. Run these once
per project before connecting a client:

```bash
cd your-project
opensip init
opensip graph
opensip fit --recipe agent-fast   # optional — gives findings MCP can replay
```

Confirm the CLI is on your `PATH`:

```bash
which opensip
opensip --version
```

Without a datastore, `opensip mcp` exits 2 with `MCP.DATASTORE_UNAVAILABLE`.

---

## 2. What every client registers

All three clients use the same underlying command — a **stdio** server that blocks
until the client closes stdin:

| Piece | Value |
|---|---|
| Command | `opensip` (or `node /path/to/opensip-cli/packages/cli/dist/index.js` when developing the CLI itself) |
| Args | `mcp`, `--cwd`, `<absolute-project-path>` |
| Transport | stdio (JSON-RPC on stdout; logs on stderr) |
| Flags | `--cwd <path>` selects the project; optional `--allow-mutations` adds only `repair_apply_verify`. Graph/result parameters are MCP tool args, not CLI flags. |

Use an **absolute path** for `--cwd` unless the client provides a project-root
variable (Claude Code's `${CLAUDE_PROJECT_DIR}`). MCP result tools are scoped to
that project root: runs recorded under another root are treated as not found
([ADR-0130](../../decisions/ADR-0130-mcp-repo-scoped-session-reads.md)).

The server is read-only by default. To opt in to `repair_apply_verify`, append
`--allow-mutations` to the registered args or set
`OPENSIP_MCP_ALLOW_MUTATIONS=1` in the server environment. This adds only
`repair_apply_verify`; it does not change graph/result query parameters.

---

## 3. Cursor

**Config file:** project `.cursor/mcp.json` (committed for the team) or global
`~/.cursor/mcp.json` (personal).

**Settings UI:** Cursor Settings → **MCP** → add a stdio server.

### Project config (recommended)

Create `.cursor/mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "opensip": {
      "command": "opensip",
      "args": ["mcp", "--cwd", "/absolute/path/to/your/project"]
    }
  }
}
```

Replace `/absolute/path/to/your/project` with the real path, or use a path your
team standardizes in docs/onboarding.

### Verify

1. Restart Cursor or reload MCP servers from Settings.
2. Open the MCP panel and compare initialize/listTools with `get_agent_catalog.mcp`. Treat those live names and the surface epoch as authority. Mutating repair apply/verify is off by default; `--allow-mutations` adds only `repair_apply_verify` (defensive registration caps: 256 tools / 128-character names — not targets).
3. Ask the agent: *"Use OpenSIP to call `get_agent_catalog`, then `get_architecture`, and summarize the graph."*
4. Ask a result replay question: *"Use OpenSIP MCP to show the latest `fit`
   findings before deciding whether to re-run fit."*

For graph answers, verify the configured project root, opaque `g1:` generation
and source, freshness completeness/reasons, effective filters, evidence labels,
coverage truncation/hard-cap reasons, and any continuation cursor. Project and
generation cursor keys are distinct; keep filters stable across pages. Call
`package_dependencies`, `why_depends`, or `package_cycles` for labelled
call/import package evidence, and `get_runtime_wiring` for live
manifest/registry/CommandSpec evidence that a static path cannot prove.
See [ADR-0148](../../decisions/ADR-0148-mcp-catalog-identity-auto-swap-and-complete-freshness.md)
for lifecycle/freshness, [ADR-0153](../../decisions/ADR-0153-faceted-compact-mcp-graph-protocol.md)
for faceted compact query bounds (supersedes ADR-0149),
[ADR-0152](../../decisions/ADR-0152-dependency-and-declaration-audit-evidence.md) for
dependency/declaration evidence,
[ADR-0154](../../decisions/ADR-0154-declarative-runtime-handler-bridge.md) for runtime
handler bridging, and [ADR-0147](../../decisions/ADR-0147-public-graph-read-and-fail-closed-package-boundaries.md)
for the public graph-read boundary.

### Compact audit workflow

1. **Diagnose the connector** with `get_agent_catalog` (version, surface epoch,
   names/count, mutation posture, root). Compare with initialize/listTools. A
   rebuilt executable requires a new MCP process/connection — `refresh_graph`
   cannot repair a cached connector inventory.
2. **Prefer exclusive detail modes:** `summary` (counts), `groups` (bounded
   group keys), or `nodes` (rows). Default package samples and cycle proofs are
   off (opt-in). Architecture defaults to metrics with deterministic top-N.
3. **Coverage facets:** inventory / evidence / grouping / projection are
   independent. A complete edge inventory may still omit samples.
4. **Identity searches** (`search_symbols`, `search_declarations`) default to
   **20** nodes (caller range 1–500). Unrelated paged tools default to 100 / max
   500. Final JSON stays under **4 MiB**.
5. **Declarations:** `search_declarations` → declaration ID → `references_to`
   (cross-file, exact TypeScript). Keep `search_symbols` callable-only.
6. **Runtime wiring:** `get_runtime_wiring` exposes stable-content `w1:` inventory
   and author-declared static-handler bridges against `g1:`. Runtime edges are
   not call edges; third-party package claims must match admitted identity.
7. Continue pages with the returned cursor and stable filters. Externally
   persisted newer catalogs auto-swap on ordinary reads (including runtime-only
   follow-ups).

### Task-context workflow

1. Call `get_context_status` with the same explicit `files` before editing.
   Trust the recorded evidence only when the response is `available`,
   `fileScope.status` is `matched`, `manifest.readiness` is `ready`, and every
   required plane is current, complete, uncapped, and backed by a pointer whose
   replay status is `available`. An evicted, stale, or current-inventory-mismatched
   pointer is never replaced with latest.
2. If any trust condition fails, run
   `opensip suite run agent-context --files <path> --json` outside MCP, then
   reconnect only if the MCP surface itself changed.
3. Use `get_file_context`, `impact_files`, `select_tests`, and `get_symbol` with
   `detail: "entity"` for the explicit project-relative files. Inspect
   freshness, all four coverage facets, evidence confidence, caps, and fallback
   commands. These reads never run Git, graph builds, or tests.

---

## 4. Claude Code

**Config files:**

| Scope | File | Shared with team? |
|---|---|---|
| Project | `.mcp.json` at repo root | Yes (via git) |
| User | `~/.claude.json` | No — all your projects |
| Local | `~/.claude.json` (per-project entry) | No — one project only |

Claude Code sets `CLAUDE_PROJECT_DIR` to the project root when it spawns a stdio
server. Use it in committed `.mcp.json` so paths are portable:

```json
{
  "mcpServers": {
    "opensip": {
      "type": "stdio",
      "command": "opensip",
      "args": ["mcp", "--cwd", "${CLAUDE_PROJECT_DIR}"]
    }
  }
}
```

### CLI setup (alternative)

From the project directory:

```bash
# All projects (user scope)
claude mcp add --transport stdio --scope user opensip -- \
  opensip mcp --cwd /absolute/path/to/your/project

# Team-shared (writes .mcp.json)
claude mcp add --transport stdio --scope project opensip -- \
  opensip mcp --cwd '${CLAUDE_PROJECT_DIR}'
```

The `--` separates Claude's options from the server command. Everything after
`--` is passed to `opensip mcp` unchanged.

**Approval:** Project-scoped servers in `.mcp.json` require approval the first
time you open the repo in an untrusted workspace. Run `claude` interactively and
accept when prompted.

### Verify

```bash
claude mcp list          # outside a session
/mcp                     # inside Claude Code — shows connected servers + tool counts
```

**Docs:** [Claude Code MCP](https://code.claude.com/docs/en/mcp)

---

## 5. Codex (CLI + IDE extension)

**Config file:** `~/.codex/config.toml` (global) or `.codex/config.toml` in a
**trusted** project. The CLI and IDE extension share this file.

Codex uses **TOML**, not JSON.

### `config.toml` (manual)

Add to `~/.codex/config.toml` or `.codex/config.toml`:

```toml
[mcp_servers.opensip]
command = "opensip"
args = ["mcp", "--cwd", "/absolute/path/to/your/project"]

# refresh_graph parses the whole project — allow extra time on large repos
tool_timeout_sec = 300
startup_timeout_sec = 30
```

### CLI setup (alternative)

```bash
codex mcp add opensip -- opensip mcp --cwd /absolute/path/to/your/project
```

This writes the `[mcp_servers.opensip]` block to `~/.codex/config.toml`.

### Verify

```bash
codex mcp list    # CLI
/mcp              # inside the Codex TUI
```

In the IDE extension: gear menu → **MCP settings** → **Open config.toml**.

**Docs:** [Codex MCP](https://developers.openai.com/codex/mcp)

---

## 6. Developing opensip-cli itself

When you work on the CLI repo and want MCP against a local build (not the globally
installed `opensip` binary), point the client at the built dispatcher:

**Cursor / Claude (JSON):**

```json
{
  "mcpServers": {
    "opensip": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/opensip-cli/packages/cli/dist/index.js",
        "mcp",
        "--cwd",
        "/absolute/path/to/target-project"
      ]
    }
  }
}
```

**Codex (TOML):**

```toml
[mcp_servers.opensip]
command = "node"
args = [
  "/absolute/path/to/opensip-cli/packages/cli/dist/index.js",
  "mcp",
  "--cwd",
  "/absolute/path/to/target-project",
]
tool_timeout_sec = 300
```

Run `pnpm build` in the opensip-cli monorepo first so `packages/cli/dist/index.js`
exists.

---

## 7. Client comparison

| | Cursor | Claude Code | Codex |
|---|---|---|---|
| Project config | `.cursor/mcp.json` | `.mcp.json` | `.codex/config.toml` |
| Global config | `~/.cursor/mcp.json` | `~/.claude.json` | `~/.codex/config.toml` |
| Format | JSON | JSON | TOML |
| Portable project root | hardcode or env in `args` | `${CLAUDE_PROJECT_DIR}` | hardcode in `args` or `cwd` |
| Add via CLI | Settings UI | `claude mcp add …` | `codex mcp add …` |
| Check status | MCP settings panel | `/mcp` | `/mcp` |

---

## 8. Example agent prompts

Once connected, steer the agent toward result-first and graph-aware queries:

**Graph structure:**

> Use OpenSIP to search for `readYamlFile`, then show who calls the match.

**Replay findings (don't re-run fit):**

> Use OpenSIP `get_latest_findings` for tool `fit` — do not run `opensip fit` again.

**Catalog lifecycle:**

> If a separate `opensip graph` just completed, make the next ordinary MCP graph
> read and verify that it reports the new `g1:` generation with
> `generationSource: persisted-auto-swap`; do not refresh merely to reload it.
> Call `refresh_graph` only when missing/stale evidence explicitly requires a
> fresh build, then show blast radius for the resolved symbol.

See [Use OpenSIP with AI agents](./use-opensip-with-ai-agents.md) for the broader
Discover → Edit → Final CLI loops.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server won't start | `opensip` not on `PATH` | Install the CLI or use the `node …/dist/index.js` form |
| `MCP.DATASTORE_UNAVAILABLE` | Project not initialized | `opensip init` then `opensip graph` in that `--cwd` |
| Connected but no useful data | Empty catalog / no sessions | Run `opensip graph` and at least one `opensip fit` |
| Run exists but `list_runs` does not show it | The run was recorded under a different project root | Verify with `opensip sessions list --json`, then restart MCP with the right `--cwd` |
| `refresh_graph` times out | Large repo, default client timeout | Raise `tool_timeout_sec` (Codex) or per-server `timeout` in `.mcp.json` (Claude) |
| Cursor is stale or rejected | Project, catalog generation, query filters, or cursor bytes changed | Restart at the first page; do not reuse or edit an opaque cursor |
| Response is partial/truncated | Freshness evidence or a hard resource cap is incomplete | Inspect reasons, narrow filters, and continue `page.nextCursor` before making a completeness claim |
| Tools missing after connect | Server still starting | Wait and recheck `/mcp`; Codex/Claude retry transient failures |
| Claude ignores `.mcp.json` | Untrusted workspace | Run `claude` interactively and approve project MCP servers |

**Sanity check** (blocks until Ctrl+C — that is expected):

```bash
opensip mcp --cwd /absolute/path/to/your/project
```

stdout must stay clean for JSON-RPC; do not pipe or tee it manually while testing.

---

## What's next

- [Use OpenSIP with AI agents](./use-opensip-with-ai-agents.md) — CLI loops without MCP
- [`mcp` command reference](../70-reference/01-cli-commands.md#mcp--serve-the-call-graph--results-to-agents-over-stdio) — full tool table and limitations
- [ADR-0084](../../decisions/ADR-0084-mcp-server-surface.md) — design decisions and trust model
