---
status: active
last_verified: 2026-07-18
owner: opensip-cli
---

# ADR-0169: Cache-first runtime evidence continuity

```yaml
id: ADR-0169
title: Cache-first runtime evidence continuity
date: 2026-07-18
status: active
supersedes: []
superseded_by: null
related: [ADR-0112, ADR-0143, ADR-0051, ADR-0075, ADR-0084, ADR-0155]
tags: [cli, runtime, sessions, init, mcp, reports]
enforcement: not-mechanizable
enforcement-reason: >
  Continuity is a customer-journey contract spanning leases, promotion journals,
  retention, and identity-preserving report selection. Static checks cover
  ownership and layering; behavioral tests cover races and crash recovery.
```

**Decision:** OpenSIP's local-first storage is one continuous journey: no-init
analysis writes truthful evidence to the user cache; `opensip init`
transactionally adopts that evidence into the project runtime; the same Run,
Session, report, and Change Impact identities remain available afterward.
`opensip mcp` is project-scoped but no-init capable over the host-entered
cache/project context. Local persistence is independent of output mode and
Cloud delivery.

**Alternatives:**

- Persist only selected output modes (`--json`/human) — rejected: agents and
  humans must trust evidence regardless of display mode.
- Rerun analysis after Init instead of promoting bytes — rejected: wastes work
  and can change results.
- Copy/remove without a lease/journal — rejected: concurrent commands and
  crashes can split or lose evidence.
- Require Init before MCP can serve cache-backed evidence — rejected: blocks
  MCP-only agent workflows during the cache stage.
- Infer report/parent identity by latest/name/time — rejected: not exact.

**Rationale:** The product thesis is enforceable guardrails with preserved
evidence. A continuous cache→Init path makes first value available without
mutating the customer repo, while Init remains the team customization step.
Shared/exclusive runtime leases, write-ahead promotion journals, starter-config
parity, polyglot Init, exact `report --run`, and crash-recoverable user
uninstall make the journey operationally safe.

**Consequences:**

- No-init-capable tools (`fit`, `graph`, `audit`, `report`, `sessions`, `mcp`,
  `status`, `runs`) use the active local evidence store (user cache or project
  runtime).
- Init promotion and authored mutations are journaled and recoverable.
- Conflict default is abort; customers choose keep-project or use-cache.
- Starter config semantics are shared between cache and Init (host-owned model).
- User and project uninstall participate in the lease/recovery plane.
- No new SQLite schema, Tool-side generic-session writer, model calls, or Cloud
  service is introduced by this decision.

**Related ADRs:** ADR-0112 (ephemeral project mode), ADR-0143 (Run/RunStep
ledger), ADR-0051 (host Session timing), ADR-0075 (state locking), ADR-0084
(MCP surface), ADR-0155 (canonical audit).
