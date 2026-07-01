---
status: active
last_verified: 2026-07-01
owner: opensip-cli
---

# ADR-0104: Defer the host-owned run pipeline behind contract conformance

```yaml
id: ADR-0104
title: Defer the host-owned run pipeline behind contract conformance
date: 2026-07-01
status: active
supersedes: []
superseded_by: null
related: [ADR-0051, ADR-0060, ADR-0065, ADR-0093]
tags: [cli, tools, run-pipeline, diagnostics, gates]
enforcement: mechanizable
enforcement-reason: >
  The project-local fitness check deferred-run-pipeline-boundary reserves
  RunCommandPipeline, defineAnalysisRunCommand, readToolConfig,
  readOptionalToolConfig, and the planned lifecycle event type names in
  production TypeScript until this ADR is promoted into an implementation spec
  and the approved package boundary is named.
```

**Decision:** Defer the host-owned run pipeline as a single architecture epic.
Do not introduce `RunCommandPipeline`, `defineAnalysisRunCommand`, production
`readToolConfig`, or typed lifecycle event APIs opportunistically. First finish
the assessment contract-conformance fixes, then promote this ADR into a concrete
implementation spec with `yagni` as the first migration target.

**Alternatives:**

- *Start with a broad pipeline rewrite now.* Rejected: fit, graph, sim, yagni,
  external scanners, sessions, gates, SARIF, report opening, live rendering, and
  cloud delivery already have several active conformance fixes in flight. A broad
  rewrite before those contracts settle would mix behavior repair with platform
  extraction.
- *Let each tool keep local run orchestration indefinitely.* Rejected:
  host-owned policies remain spread across tool command handlers, so gate exit
  behavior, report opening, session contribution assembly, diagnostics, and JSON
  dispatch can drift again.
- *Add small helper APIs as needed and converge later.* Rejected: ad hoc names
  become public seams before the host/tool package boundary is designed.

**Rationale:** ADR-0051, ADR-0060, ADR-0065, and ADR-0093 already establish that
generic run lifecycle timing, diagnostics presentation, public JSON/raw-stream
policy, and suite orchestration are host-owned. The code still reflects an
earlier stage: verdict-producing tools hand-compose JSON vs human output, live
vs static dispatch, gate save/compare, `deliverSignals`, SARIF writes, report
opening, session contributions, and diagnostics events.

The right endpoint is a host-owned pipeline where tools provide domain execution
and presentation, while the host applies those policies once. The wrong endpoint
is five slightly different "run helper" shapes created during unrelated fixes.
The deferred boundary keeps the API names reserved until the package boundary,
contract, and migration sequence are intentionally specified.

**Consequences:**

- The names `RunCommandPipeline`, `defineAnalysisRunCommand`, `readToolConfig`,
  `readOptionalToolConfig`, `RunLifecycleEvent`, `UnitLifecycleEvent`,
  `DeliveryLifecycleEvent`, and `ConfigLifecycleEvent` are reserved in
  production TypeScript by the `deferred-run-pipeline-boundary` dogfood check.
- A future implementation spec must name the owning package for the pipeline API
  and update that check with the approved boundary instead of deleting it.
- `yagni` is the first migration target because it is the smallest
  verdict-producing analysis tool and now has the missing currencies: session
  replay, agent JSON filters, contract version metadata, namespaced rule IDs,
  and detector authoring validation.
- The first migration must include parity tests for JSON, raw filtered JSON,
  human output, live/static dispatch, gates, SARIF, report opening, and session
  persistence.
- This ADR does not change the sanctioned raw-stream exceptions for MCP stdio,
  worker IPC, file exports, completion scripts, session raw replay, or diagnostic
  gates.

**Related specs / ADRs:** ADR-0051 (host-owned run lifecycle timing), ADR-0060
(diagnostic boundary and run outcomes), ADR-0065 (public JSON and raw-stream
policy), ADR-0093 (suite plane). The implementation spec is intentionally not
created in the committed tree yet; `docs/plans/` remains local-only planning
scratch until a promoted plan has an owner and scope.
