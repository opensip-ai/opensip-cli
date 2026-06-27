---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0083: tool lifecycle hooks self-initialize

```yaml
id: ADR-0083
title: tool lifecycle hooks self-initialize
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0027, ADR-0051, ADR-0054]
tags: [tools, lifecycle, sessions, reports]
enforcement: mechanizable
enforcement-reason: >
  Worker-entry and lifecycle tests prove report/session hook paths do not assume
  command initialization ran, and source JSDoc/doc pages state the contract.
```

**Decision:** Tool lifecycle and contribution hooks are self-initializing. The
host guarantees only local call-site ordering: `initialize` runs before an
invoked command handler for that tool, while `collectReportData`,
`sessionReplay`, `contributeScope`, and `capabilityRegistrars` run when their
own host surface needs them. Hooks that require setup must call a tool-owned
idempotent `ensureInitialized()` helper.

**Alternatives:**

- **Always run `initialize` before any hook** - rejected; reports, sessions, and
  help/catalog paths would eagerly initialize uninvoked tools.
- **Document that hooks can assume prior command execution** - rejected; reports
  and replays are valid entry points on a fresh process.
- **Move all setup to module top level** - rejected; top-level work hurts
  startup and conflicts with external fault-isolation goals.

**Rationale:** The platform increasingly exposes non-command entry points:
report composition, session replay, capability loading, and agent catalog
inspection. Coupling those to a prior normal command run makes them order
dependent and fragile. The narrow rule keeps startup lazy while making hook
authors responsible for their own setup dependencies.

**Consequences:**

- Tool docs and JSDoc describe hook call-site ordering explicitly.
- Report and replay code must not assume command `initialize` already ran.
- External-worker hook execution can remain lazy and surface-specific.

**Fitness check:** Covered by lifecycle tests; no static source check is
warranted because valid setup patterns are tool-specific and idempotence is a
behavioral property.
