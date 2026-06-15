---
status: active
last_verified: 2026-06-15
owner: opensip-cli
---

# ADR-0051: Host-Owned Run Lifecycle, Timing, and Persistence

> **Amendment (2026-06-15):** the per-run **dashboard-tab contribution**
> sub-feature originally shipped with this decision (`ToolDashboardContribution`,
> the auto-generated `<tool> — Latest Run` / `— Units` tabs, and the
> `session_dashboard_contributions` table) was **removed** before release — the
> auto-generated tabs duplicated each tool's existing report tab and added
> clutter. Tools now return only `{ result?, envelope?, session? }`; there is no
> `dashboard` field, no contributed-tab persistence/rendering. The core decision
> below (host owns the run lifecycle, timing, and the generic `StoredSession`
> row) is unchanged.

```yaml
id: ADR-0051
title: Host-Owned Run Lifecycle, Timing, and Persistence
date: 2026-06-14
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0036, ADR-0042, ADR-0048]
tags: [sessions, timing, persistence, hygiene, architecture, contracts]
enforcement: mechanizable
enforcement-reason: >
  The project-local fitness check `architecture-session-timing-not-host-owned`
  (path-gated to the first-party tool packages) forbids tool code from
  referencing the generic-session persistence surface (`SessionRepo`, any
  `persist*Session` helper, `runSession.record`). A compile-time guard in
  `packages/core/src/tools/__tests__/types.test.ts` asserts `keyof
  ToolRunSessions === 'timing'`, so no generic-session writer can be re-added to
  the launch surface. `only-documented-toolcli-seams` + dep-cruiser layering
  forbid raw datastore use from tool engines.
```

**Decision:** The CLI host is the sole owner of a tool run's generic lifecycle:
it creates one `RunTimer` (a.k.a. `RunLifecycle`) per invocation at the
command-action boundary (after `RunScope` entry, before any tool work) and
stamps `StoredSession.startedAt` / `completedAt` / `durationMs` from it. Tools no
longer persist generic session rows or capture their own wall-clock for them —
they RETURN a `ToolRunCompletion` (`{ result?, envelope?, session? }`)
from their command handler / live renderer, whose `session` is a
`ToolSessionContribution` (`{ tool, cwd, recipe?, score, passed, payload? }`).
The host run plane freezes the lifecycle when the tool returns, persists the row,
and records host-side overhead on a sibling `StoredSessionHostMetrics` record.
The public `ToolCliContext.runSession` carries only a read-only `timing` for a
display clock; the transitional `runSession.record(...)` writer is removed.

**Alternatives:**
- Keep the `cli.runSession.record(...)` writer seam (the intermediate model)
  (rejected: it left tools able to stamp/skew timing and to persist generic rows
  directly, the exact ownership ambiguity this work removes; a writer on the
  launch surface is an open re-introduction vector).
- Let each tool own a `persist*Session(..., startedAt, durationMs)` helper
  (rejected: duplicated per tool, each captured its own clock — drift between the
  displayed "Duration X" and the stored row, and no single host metric surface).
- Store host overhead (persist/render/egress) inside `durationMs` or the tool
  payload (rejected: conflates "how long the tool took" with "where host-side
  cost accumulated"; the sibling `hostMetrics` record keeps them distinct).
- A single `timestamp` column (rejected: cannot express a true
  start→complete interval, and host metrics need a stable session-id key).

**Rationale:** One host-owned clock makes the displayed duration, the
`sessions list` row, `sessions show`, and the HTML report agree by construction —
they all read the same frozen snapshot. Removing every tool-side writer collapses
the persistence surface to one place (`packages/cli/src/bootstrap/run-plane.ts`),
so timing/persistence behaviour cannot drift per tool and is enforceable by a
single path-gated fitness check rather than a fragile per-call audit. The
return-contribution shape mirrors the established host-owned planes (ADR-0011
output, ADR-0036 baseline, ADR-0042 tool state): tools hand the host pure data
and the host owns the effect. Internal per-unit/stage timers and the
SignalEnvelope's own timing stay tool-owned (diagnostics in the payload/envelope),
so nothing of value is lost.

**Consequences:**
- `StoredSession.timestamp` → `startedAt` + `completedAt`; `hostMetrics?` added
  (hydrated from the sibling `session_host_metrics` record). DB migration is
  additive; baselines/sessions are drop-and-recapture (CI-ephemeral).
- `ToolRunCompletion`, `ToolSessionContribution`, `RunTimer`/`RunLifecycle`,
  `StoredSessionHostMetrics` are the new contract types;
  `ToolCliContext.runSession` is `{ timing }` only.
- Live renderers return a `ToolRunCompletion | void`; the host times TTY
  occupancy and persists after `await render()`.
- `buildToolCliContext` is a thin assembler over focused bootstrap planes
  (run / live / output / egress / baseline / state / host-planes).
- First-party tools and third-party authors record a run by returning the
  contribution; there is no documented generic-session writer.
- Host metrics merge bug fixed in `SessionRepo.upsertHostMetrics` (the
  `onConflictDoUpdate` set must key on Drizzle column properties, not SQL names).

**Related specs / ADRs:**
- Governing spec / plan: `docs/plans/ready/host-owned-run-timing/` (local-only).
- ADR-0011 (machine-output plane), ADR-0036 (baseline/ratchet plane),
  ADR-0042 (per-tool state plane) — the host-owned-plane precedent this follows.
- ADR-0048 (tool stable UUID identity) — adjacent session/datastore evolution.
