---
status: active
last_verified: 2026-07-06
owner: opensip-cli
---

# ADR-0134: Stamp opensip-cli + engine version on every session row

```yaml
id: ADR-0134
title: Stamp opensip-cli + engine version on every session row
date: 2026-07-06
status: active
related: [ADR-0060]
enforcement: mechanizable
enforced-by: ['script:verify-drizzle-migrations']

**Decision:** The host stamps two provenance columns on every persisted
`StoredSession`: `cli_version` (the opensip-cli version that produced the run)
and `engine_version` (the producing tool's manifest version). Both are
host-owned — stamped in the run plane at persist time from `readPackageVersion`
and `manifestVersionFor(contribution.tool)`, exactly like `startedAt` /
`completedAt` / `id`. Tools contribute neither. Both columns are nullable;
absent on legacy rows and, for `engine_version`, on runs whose tool declares no
manifest version (host commands, unversioned tools).

**Alternatives:**
- *Keep version only on the transient `SignalEnvelope`* (status quo) — the
  report env panel showed the report run's CLI version but no session carried
  its own, so `sessions list/show`, the report table, and MCP were all blind to
  which version produced a given finding. Rejected: the evidence surface can't
  answer "what version made this?".
- *Stamp version inside the opaque tool payload* — rejected: the payload is
  tool-owned (ADR-0042) and version is a host fact; putting it there would make
  the host depend on tool vocabulary and duplicate it per tool.
- *CLI version only, no engine version* — rejected as a false economy: the two
  columns share one migration and the same five persist files; engine version
  adds only one `manifestVersionFor` lookup, and it's what distinguishes a
  check-pack change from a CLI change.

**Rationale:** Provenance is core preserved evidence — reproducing or explaining
a finding, distinguishing a code change from a tool-version upgrade, debugging a
gate flip after an upgrade, and answering "what version?" on a support report
all require the version stamped per run. The host already resolves both values
(`declared-inputs.ts` for the report env panel); `manifestVersionFor` is now
exported and reused so there is one source of truth. The stamp lives in
`run-plane.ts` beside the timing stamp, keeping the "host owns the generic row"
invariant intact (`packages/cli/src/bootstrap/run-plane.ts`;
`packages/session-store/src/schema/sessions.ts` migration 0006).

**Consequences:** New nullable columns via migration `0006_session_versions`
(`LOGICAL_SCHEMA_VERSION` = offset + 7). Forward-compatible: legacy rows read
back with the fields absent (the `run_outcome`/ADR-0060 precedent), so no
backfill is required and baselines are unaffected. Surfaced in `sessions show`,
the report session-detail subline, and the MCP `RunSummary`. NOTE (drizzle): the
committed migration chain has a duplicate snapshot id on 0001/0002 that makes
`drizzle-kit generate` abort, so migration 0006 was hand-authored (the same
workflow the 0002–0005 column-adds used) with its snapshot content taken from a
clean empty-dir squash; the drift gate (`scripts/verify-drizzle-migrations.mjs`)
verifies structural parity.

**Fitness check:** No new check warranted. The persisted-field contract is
enforced structurally by the schema/drift gate (`verify-drizzle-migrations.mjs`
+ `migration-integrity.test.ts` pin schema↔journal↔snapshot parity and that a
fresh DB materializes the columns) and by round-trip tests
(`session-versions.test.ts`, the run-plane host-stamp tests, and the MCP
`RunSummary` test). The host-owns-the-row invariant this builds on is already
guarded by the session-timing fitness check (ADR-0051/host-owned-run-timing).

**Related ADRs:** Extends the host-owned session row and the forward-compatible optional-column pattern of [ADR-0060](ADR-0060-cli-diagnostic-boundary-and-run-outcomes.md); the values reuse the report env-panel provenance introduced with `declaredInputs` ([signal-envelope.ts](././packages/contracts/src/signal-envelope.ts)).
