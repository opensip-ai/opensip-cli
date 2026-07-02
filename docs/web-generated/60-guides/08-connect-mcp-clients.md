---
status: current
last_verified: 2026-06-30
release: v0.2.0
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
[`mcp` in the CLI command reference](/docs/opensip-cli/70-reference/01-cli-commands/#mcp--serve-the-call-graph--results-to-agents-over-stdio).

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
| Flags | Only `--cwd` matters for MCP — graph/result parameters are MCP tool args, not CLI flags |

Use an **absolute path** for `--cwd` unless the client provides a project-root
variable (Claude Code's `${CLAUDE_PROJECT_DIR}`).

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
2. Open the MCP panel — `opensip` should appear with **13 tools** (9 graph + 4 result).
3. Ask the agent: *"Use OpenSIP to call `get_architecture` and summarize the graph."*
4. Ask a result replay question: *"Use OpenSIP MCP to show the latest `fit`
   findings before deciding whether to re-run fit."*

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

**Stale catalog:**

> OpenSIP reports `freshness.fresh === false`. Call `refresh_graph` once, then
> show blast radius for the symbol you found.

See [Use OpenSIP with AI agents](/docs/opensip-cli/60-guides/use-opensip-with-ai-agents/) for the broader
Discover → Edit → Final CLI loops.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server won't start | `opensip` not on `PATH` | Install the CLI or use the `node …/dist/index.js` form |
| `MCP.DATASTORE_UNAVAILABLE` | Project not initialized | `opensip init` then `opensip graph` in that `--cwd` |
| Connected but no useful data | Empty catalog / no sessions | Run `opensip graph` and at least one `opensip fit` |
| `refresh_graph` times out | Large repo, default client timeout | Raise `tool_timeout_sec` (Codex) or per-server `timeout` in `.mcp.json` (Claude) |
| Tools missing after connect | Server still starting | Wait and recheck `/mcp`; Codex/Claude retry transient failures |
| Claude ignores `.mcp.json` | Untrusted workspace | Run `claude` interactively and approve project MCP servers |

**Sanity check** (blocks until Ctrl+C — that is expected):

```bash
opensip mcp --cwd /absolute/path/to/your/project
```

stdout must stay clean for JSON-RPC; do not pipe or tee it manually while testing.

---

## What's next

- [Use OpenSIP with AI agents](/docs/opensip-cli/60-guides/use-opensip-with-ai-agents/) — CLI loops without MCP
- [`mcp` command reference](/docs/opensip-cli/70-reference/01-cli-commands/#mcp--serve-the-call-graph--results-to-agents-over-stdio) — full tool table and limitations
- [ADR-0084](https://github.com/opensip-ai/opensip-cli/blob/v0.2.0/docs/decisions/ADR-0084-mcp-server-surface.md) — design decisions and trust model
