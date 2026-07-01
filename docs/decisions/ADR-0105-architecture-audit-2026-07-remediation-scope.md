---
status: active
last_verified: 2026-07-01
owner: opensip-cli
---

# ADR-0105: Architecture audit 2026-07 remediation scope

```yaml
id: ADR-0105
title: Architecture audit 2026-07 remediation scope
date: 2026-07-01
status: active
supersedes: []
superseded_by: null
related: [ADR-0056, ADR-0053, ADR-0023, ADR-0036, ADR-0106, ADR-0107, ADR-0108]
tags: [architecture, hygiene, dogfood, solid]
enforcement: not-mechanizable
enforcement-reason: >
  Remediation is a bounded hygiene program. Individual items are mechanized
  per-phase (fitness checks, integration tests, depcruise). The scope boundary
  ("no de-layering") is policy.
```

**Decision:** Preserve the layered plugin-host DAG unchanged. Remediate the
2026-07-01 architecture audit **P1 findings only** via targeted refactors,
fail-closed policies, and repository-boundary tightening — no package merges,
layer edge changes, or de-layering. Execution follows
`docs/plans/architecture-audit-p1-remediation/plan.md`.

**Alternatives:**

- Full audit backlog (P1–P3, 43 packages) in one program — rejected; dilutes
  focus; P2 items (display slug mismatches, `agent-filters` registry) stay in
  per-package audit docs for grooming.
- De-layer `contracts` host orchestration into `cli` — rejected; audit confirms
  facade drift is manageable; move only `runBaselineExport`-class functions when
  touched for other reasons.
- Re-litigate ADR-0056 scope — rejected; June remediation items remain valid;
  July audit adds new P1 correctness issues (concurrent profiler, slug ambiguity).

**Rationale:** Forty-three package audits (2026-07-01) confirm the architecture
is intentional: composition root, registry/strategy patterns, per-run `RunScope`,
and host-owned gate/baseline planes are correctly applied. Nine P1 findings
threaten **correctness under concurrency** (`memoryProfiler`), **CI determinism**
(bare-slug resolution), **persistence encapsulation** (`DrizzleDataStore.db`),
and **third-party extensibility** (`PluginsConfig`, `LiveRunTool`). These are
cheaper to fix now than after ecosystem opening (ADR-0061).

**Consequences:**

- Implementation follows an 8-phase PR stack (phases 0–5 parallelizable groups).
- Child ADRs record load-bearing policy decisions: ADR-0106 (slug resolution),
  ADR-0107 (datastore boundary), ADR-0108 (graph cache I-8).
- P2 backlog includes: scope-slot collision guard (core), `SessionRepo` is
  split in Phase 3 but `RunScope` growth policy remains documentation-only,
  dashboard `generator.ts` decomposition, MCP `createMcpServeStack` extraction.
- Host-plane narrow typing (ADR-0056 R2/D1) remains deferred until a Cloud
  consumer requires typed governance/audit planes.

**Related specs / ADRs:** [ADR-0056](ADR-0056-architecture-audit-remediation.md)
(June scope); audit evidence under `docs/plans/architecture/`.

---

## P1 findings index (P1-F* → phase → ADR)

| ID | Finding | Phase | ADR |
|----|---------|-------|-----|
| P1-F1 | `memoryProfiler` process-global | 0 | ADR-0053 (isolation model) |
| P1-F2 | Bare-slug recipe ambiguity | 2 | [ADR-0106](ADR-0106-fitness-bare-slug-fail-closed.md) |
| P1-F3 | `DrizzleDataStore.db` leak | 3A | [ADR-0107](ADR-0107-datastore-repository-only-boundary.md) |
| P1-F4 | `SessionRepo` SRP violation | 3B | — (refactor; no policy change) |
| P1-F5 | `PluginsConfig` closed interface | 4 | ADR-0023 (composer) |
| P1-F6 | Wide `ToolCliContext` + hook leak | 5A | ADR-0051 (documented seams) |
| P1-F7 | Closed `LiveRunTool` union | 5B | — |
| P1-F8 | Cache key omits `resolutionMode` | 1 | [ADR-0108](ADR-0108-graph-cache-key-includes-resolution-mode.md) |