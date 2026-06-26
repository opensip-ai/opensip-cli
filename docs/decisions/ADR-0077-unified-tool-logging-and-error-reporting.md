---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0077: Unified tool logging and command-failure reporting

```yaml
id: ADR-0077
title: Unified tool logging and command-failure reporting
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0053, ADR-0060, ADR-0076]
tags: [tools, logging, errors, cli]
enforcement: mechanizable
enforcement-reason: >
  Fitness check `tool-engine-no-direct-stderr-command-errors` ratchets first-party
  tool engine CLI handlers away from direct command-error stderr writes.
```

**Decision:** Expose `ToolCliContext.reportFailure(detail)` and `createToolLogger(module)`
from `@opensip-cli/core`; bind `cli.logger` to the per-run scope logger; implement
resolution and effectful fan-out in `packages/cli`; keep exit-code policy in
`@opensip-cli/contracts`; serialize worker failures as plain `reportedFailure` data
for ADR-0054 replay.

**Alternatives:**

- **Per-tool helpers** (e.g. fitness `emitFitCommandError`) — rejected; duplicates host
  routing and drifts across tools.
- **`ReportFailureDetail` in contracts** — rejected; would force core to import contracts
  or prevent naming core `ToolError` / `CliDiagnostic`.
- **Silent `ToolError` catch** — rejected; users saw exit codes without customer messages.

**Rationale:** Primitives existed (`Logger`, `emitError`, `DiagnosticsBus`) but authors
had no single API. External workers already used `scope.logger`; in-process tools often
hit the captured singleton. `mountCommandSpec` caught `ToolError` and set exit code only.
Layering: core types/helpers, contracts exit policy, CLI fan-out preserves the DAG.

**Consequences:**

- Handler-time failures call `reportFailure` or throw `ToolError` (host renders).
- Findings remain `SignalEnvelope` / `deliverSignals` — unchanged.
- Worker IPC carries `reportedFailure` wire payloads, never live `Error` instances.
- Tool-engine command-error stderr is forbidden outside documented allowlists.

**Fitness check:** `tool-engine-no-direct-stderr-command-errors` — path-gated to
`packages/{fitness,graph,simulation,yagni}/engine/src/cli/`; allows progress/worker
transport stderr (heap preflight, shard worker, fit warnings). Bootstrap and host CLI
paths remain governed by existing checks.

**Related specs / ADRs:** Plan 06 spec
`docs/plans/specs/unified-tool-logging-and-error-reporting.md`; ADR-0060 bootstrap
diagnostics; ADR-0053 per-run logger scope; ADR-0054 worker dispatch replay.