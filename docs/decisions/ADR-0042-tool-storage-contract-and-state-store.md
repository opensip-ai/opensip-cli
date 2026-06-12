---
status: active
last_verified: 2026-06-12
owner: opensip-cli
---

# ADR-0042: Two-tier tool storage contract + host-owned ToolStateStore

```yaml
id: ADR-0042
title: Two-tier tool storage contract + host-owned ToolStateStore
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0009, ADR-0028, ADR-0036, ADR-0041]
tags: [datastore, plugins, tools, parity]
enforcement: mechanizable
enforcement-reason: >
  Tier A is enforced by static checks in `tools validate`/`tools install`
  (DDL strings, datastore-file paths, private schema/migration imports —
  pattern family shared with the restrict-raw-db-access fitness check) plus
  the parity acceptance test "all first-party bundled tools pass `tools
  validate` unchanged". Tier B enforcement is explicitly DEFERRED until the
  first-party persistence migration lands (tracked in the spec's Phase 3);
  until then it is direction, not a gate.
```

**Decision:** The tool storage contract is two tiers. **Tier A (enforced now,
all tools including bundled):** no migrations, no DDL (`CREATE/ALTER/DROP
TABLE`, `CREATE INDEX`, `PRAGMA writable_schema`), no direct writes to
`opensip-cli/.runtime/datastore.sqlite`, no imports of datastore-private
schema/migration modules. **Tier B (policy direction, enforced only after
first-party persistence moves behind host seams):** tools do not receive raw
Drizzle/SQLite handles; they persist exclusively through host APIs — sessions,
the ADR-0036 baseline seams, and a new host-owned **`ToolStateStore`**
(generic keyed JSON state over one host table `tool_state`:
`tool | key | payload | updatedAt`, composite PK `tool+key`), which ships as a
required part of the tools-command feature.

**Alternatives:**

- *Single-tier contract ("no raw handles, no table-name dependence") enforced
  at admission immediately.* Rejected: the bundled tools do not satisfy it —
  graph owns drizzle table objects for `graph_catalog`/`graph_shard_fragment`
  in its `src/persistence/` layer over the public `DataStore.db` handle
  (sanctioned by ADR-0009 + `tables-only-in-persistence`), and fit constructs
  `SessionRepo` over the same handle. Enforcing it would break 3.0.0 parity
  (rules for third-party tools that first-party tools are exempt from) or
  force a rushed persistence rewrite.
- *No generic state store (sessions + baselines only for third-party tools).*
  Rejected: that leaves a permanent undocumented parity gap — bundled tools
  enjoy bespoke tables third-party tools structurally cannot have (no
  migration path). `ToolStateStore` is the parity mechanism, on the exact
  generic-table shape ADR-0036 already proved.
- *Let tools contribute migrations/schema fragments.* Rejected (spec non-goal):
  schema is host-owned; tool-contributed DDL makes the datastore's version
  guard and drop-and-recapture semantics unownable.

**Rationale:** Tier A is structurally true for graph and fit today — their DDL
lives in host-owned migrations in the datastore package; the tools hold column
accessors, not schema authority — so it can gate admission without parity
exceptions. Tier B enforced early would just teach third-party authors to
cargo-cult what fit/graph do with the raw handle; sequencing enforcement
behind the seams (a sessions seam parallel to the baseline seams; graph's
catalog repo evaluated for the same treatment) makes compliance possible
before it is demanded.

**Consequences:**

- `ToolStateStore` + `ToolStateRepo` (and `SessionRepo.clearForTool`,
  `BaselineRepo.clear`) land in the tools-command feature, Phase 2.
- A future release migrates first-party session persistence behind a host
  seam; only then does Tier B become an admission check (Phase 3).
- `tools data purge` clears `tool_state` rows alongside sessions/baselines.
- Payload size caps / per-tool budgets are an open question resolved in the
  implementation plan (error vs. evict).

**Related specs / ADRs:** `docs/plans/specs/tool-management-command.md` (rev 2);
ADR-0009 (public `db` handle + confined table symbols); ADR-0028 (engine
persistence-free, caller persists); ADR-0036 (host-owned baseline plane —
the generic-table pattern `tool_state` copies).
