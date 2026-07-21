---
status: active
last_verified: 2026-07-20
owner: opensip-cli
---

# ADR-0176: Bootstrap diagnostics fold into the CommandOutcome diagnostics plane

```yaml
id: ADR-0176
title: Bootstrap diagnostics fold into the CommandOutcome diagnostics plane
date: 2026-07-20
status: active
supersedes: []
superseded_by: null
related: [ADR-0024, ADR-0060, ADR-0174, ADR-0175]
tags: [output, observability, diagnostics, bootstrap, cli]
enforcement: mechanizable
enforced-by: ['script:assemble-outcome.test']
enforcement-reason: >
  assemble-outcome.test proves a scope with a recorded bootstrap CliDiagnostic
  appears in CommandOutcome.diagnostics.events with data.origin === 'bootstrap'
  after outcome assembly; a clean bus+empty bootstrap stays empty-events.
```

**Decision:** The `--json` `CommandOutcome.diagnostics` plane is the single
authoritative machine view of run diagnostics. At outcome assembly
(`withDiagnostics`), the host dual-reads (1) the scope lifecycle
`DiagnosticsBus` snapshot and (2) the scope `BootstrapDiagnosticsCollector`
buffer, projecting each `CliDiagnostic` into a lifecycle `DiagnosticEvent` with
`data.origin: 'bootstrap'`. The typed bootstrap collector remains for human /
doctor / filter-for-command surfaces; it is not deleted. Origin tags stay
distinguishable: `bootstrap` (this fold), `worker` (ADR-0174 `ingest`), and
unstamped host lifecycle events.

**Alternatives:**

- *Leave two planes (status quo).* Rejected: a capability/policy diagnostic
  recorded only on `bootstrapDiagnostics` is invisible in `--json`
  `diagnostics.events`, so machine consumers and the bughunt observability
  contract see a clean bus while the human path knows otherwise.
- *Fold into the bus at every `BootstrapDiagnosticsCollector.record`.* Rejected
  as the primary design: record sites run before and after scope wiring, and
  permanent dual-write couples human filtering to lifecycle ordering; dual-read
  at the one outcome-assembly seam is the single owner and cannot double-count.
- *Put bootstrap only on `commandError` / `errors[]`.* Rejected: those slots
  carry the primary fail-closed error (ADR-0060), not the full buffered stream
  of non-fatal bootstrap warnings (trust denials, pack load skips, policy
  notes) that operators need on successful runs too.

**Rationale:** ADR-0024 put `RunDiagnostics` on every outcome; ADR-0060 put typed
`CliDiagnostic`s on a separate bootstrap buffer for command-scoped human
rendering. The worker half of observability was closed by ADR-0174 (`ingest`).
The remaining hole is the host bootstrap half: `assemble-outcome` only called
`scope.diagnostics.snapshot()`. Dual-read at assembly preserves both currencies
and one machine document.

**Consequences:**

- New pure projector `cliDiagnosticToEvent` (+ `snapshotOutcomeDiagnostics`) in
  core: maps severity → level, category → phase (`discovery` → `discover`, else
  `load`), and stamps bounded `data` with `origin: 'bootstrap'`.
- `withDiagnostics` uses the merged snapshot. Bootstrap events are ordered
  **before** lifecycle bus events (bootstrap precedes execute).
- Doctor / `tools list` keep reading `bootstrapDiagnostics` directly; no
  behaviour change for human filter-for-command.
- Complements ADR-0175 (JSON-safe data bags): projected bootstrap `data` is
  plain JSON and still passes through bus admission if ever re-emitted.

**Related ADRs:** ADR-0024 (CommandOutcome + diagnostics bus), ADR-0060 (typed
CLI diagnostics), ADR-0174 (worker fold via `ingest`), ADR-0175 (JSON-safe
diagnostic values).
