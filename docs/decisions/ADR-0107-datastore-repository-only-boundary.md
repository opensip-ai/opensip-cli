---
status: active
last_verified: 2026-07-01
owner: opensip-cli
---

# ADR-0107: DataStore public surface is repository-only

```yaml
id: ADR-0107
title: DataStore public surface is repository-only
date: 2026-07-01
status: active
supersedes: []
superseded_by: null
related: [ADR-0105, ADR-0056, ADR-0042, ADR-0096]
tags: [datastore, persistence, dip]
enforcement: mechanizable
enforcement-reason: >
  Fitness restrict-raw-db-access check; depcruise rule on Drizzle query shapes;
  public barrel must not export DrizzleDataStore.
```

**Decision:** The `@opensip-cli/datastore` public barrel exports `DataStore`
(capability interface), repository classes (`BaselineRepo`, `ToolStateRepo`, …),
and factory functions only. The Drizzle ORM handle (`DrizzleDataStore.db`) is
**not** part of the public API. Sibling persistence packages (`session-store`)
that require direct Drizzle access use an `@internal` subpath
(`@opensip-cli/datastore/internal`) — not imported by tool packages or CLI
command handlers.

**Alternatives:**

- Keep `DrizzleDataStore` public with ESLint guards only — rejected; ADR-0056
  R18 identified this as a leaky abstraction; guards catch shapes but not the
  temptation to add ad-hoc queries.
- Force session-store behind repos only (no Drizzle) — deferred; session-store
  may need internal handle until its repos are fully extracted; subpath is
  interim, not permanent for tools.
- Swap ORM — rejected as scope; this ADR enables future backend swap by
  concentrating queries in repos.

**Rationale:** `baseline-repo.ts` and `tool-state-repo.ts` already embody the
Repository pattern. Exposing `db` on the narrow interface lets any consumer
couple to Drizzle/SQLite dialect and scatter queries outside migration control.
Tool packages must never touch datastore (ADR-0051); only host and persistence
substrates may.

**Consequences:**

- Remove `DrizzleDataStore` from `packages/datastore/src/index.ts`.
- Add `datastore/internal` subpath with `requireDrizzleHandle(store)` for
  session-store internal use.
- Grep and migrate any `.datastore.db` usage outside allowed packages.
- Extends ADR-0056 Phase 4 R18 from "documented trade-off" to enforced boundary.

**Related specs / ADRs:** Phase 3A in
`docs/plans/architecture-audit-p1-remediation/`; [ADR-0096](ADR-0096-host-owned-datastore-lifecycle.md).