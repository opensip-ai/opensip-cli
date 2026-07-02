---
status: active
last_verified: 2026-07-01
owner: opensip-cli
---

# ADR-0109: Agent guidance must route OpenSIP queries through MCP first

```yaml
id: ADR-0109
title: Agent guidance must route OpenSIP queries through MCP first
date: 2026-07-01
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0085, ADR-0095]
tags: [agents, mcp, init, sessions]
enforcement: mechanizable
enforcement-reason: >
  The project-local fitness check
  opensip-cli/fit/checks/mcp-first-agent-guidance.mjs verifies that init-managed
  agent guidance and MCP result-tool descriptions tell agents to use MCP /
  persisted results first, avoid .runtime/logs and datastore.sqlite as primary
  result sources, and avoid re-running tools for stored-result questions.
```

**Decision:** Agent-facing OpenSIP guidance MUST prefer the OpenSIP MCP server
for questions about existing runs, findings, warnings, errors, scores, sessions,
or graph relationships. `opensip init` owns a managed guidance block in known
agent-instruction files and repeated `opensip init` refreshes that block plus
`.gitignore` without rewriting config or scaffold examples unless the user asks
for `--keep` or `--remove`.

**Alternatives:**

- Rely only on MCP tool descriptions — rejected; deferred or hidden tools are not
  always visible when an agent chooses its first lookup path.
- Rely only on repository docs — rejected; agents often start from
  client-specific instruction files, not long-form documentation.
- Keep repeat `opensip init` as a no-op or partial-state refusal — rejected;
  existing adopters need a safe path to receive updated agent guidance without
  destructive scaffold churn.
- Tell agents to use sessions CLI first — rejected; CLI replay remains the
  fallback when MCP is unavailable, but MCP is the domain interface built for
  tool discovery and structured agent calls.

**Rationale:** Raw `.runtime/logs` are event streams, and direct
`datastore.sqlite` reads bypass the domain semantics that `list_runs`, `show_run`,
and `get_latest_findings` expose. ADR-0084 already makes MCP a read-only surface
for stored results and graph context; this ADR makes that consumption path
discoverable at the moment agents decide whether to call MCP, run shell commands,
or grep local files.

**Consequences:**

- `opensip init` creates or refreshes `AGENTS.md` and refreshes existing
  `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules`,
  `.cursor/rules/opensip.mdc` when the Cursor rules directory exists, and
  `.windsurfrules` through a delimited managed block.
- Repeat `opensip init` with an existing `opensip-cli.config.yml` exits
  successfully in refresh mode. It updates `.gitignore` and managed agent
  guidance only; config and example scaffolds are left untouched unless
  `--keep` or `--remove` is explicit.
- MCP result-tool descriptions must state that existing-result questions should
  use persisted replay first and must not instruct agents to grep logs, read the
  datastore directly, or re-run tools as the default answer path.

**Related specs / ADRs:** Local implementation plan under
`docs/plans/ready/mcp-first-agent-guidance-init-refresh/`; [ADR-0084](ADR-0084-mcp-server-surface.md).
