---
status: active
last_verified: 2026-06-05
owner: opensip-tools
---

# ADR-0018: Sim is a real BYO-target resilience/load harness

```yaml
id: ADR-0018
title: Sim is a real BYO-target resilience/load harness
date: 2026-06-05
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0011]       # signals = the universal OUTPUT currency (the sibling)
tags: [sim, chaos, load, harness]
enforcement: not-mechanizable
enforcement-reason: >
  A framework/contract decision (the Target seam + client-side fault model).
  There is no single fitness check that proves "the driver issues real
  requests"; the behaviour is enforced by the simulation test suites
  (run-load-window / fault-model / per-kind executor) and the test:coverage gate.
```

**Decision:** The `sim` tool's `load` and `chaos` kinds drive a **user-supplied
`Target`** (an async function the shared load-window driver calls once per
request, throwing on failure) and measure **real** outcomes. `chaos` injects
**client-side** faults (`latency` / `abort` / `drop`) at a configured probability
over a steady-state window, then runs a recovery window with faults lifted, and
asserts measured SLOs in each. The `Target` is the only seam to the outside
world; the harness ships **no** runtime, demo server, or third-party target.

**Alternatives:**
- *Keep the synthetic model.* Rejected: the prior driver issued no requests —
  per-tick latency was `Math.random()*50+1` and success a `Math.random()<0.95`
  roll — so a green run asserted a property of the RNG, not of any system. It
  measured nothing; shipping it (even as `[experimental]`) was dishonest.
- *Remove `sim` entirely.* Rejected: BYO-target resilience/load testing is
  genuinely useful and was the tool's original intent; removing it abandons real
  value to dodge effort.
- *Ship server-side fault injection (kill pods, force 500s).* Rejected: that
  cannot be done honestly from the client without a controllable target. It is
  delivered as a **documented** pattern (point the `Target` at a fault-injectable
  endpoint you control, e.g. a Toxiproxy proxy) rather than bundled.
- *A chaos-only real driver, leaving `load` synthetic.* Rejected: both kinds
  share `runLoadWindow`, so a real driver makes `load` real in the same stroke;
  two drivers would leave `load` lying.

**Rationale:** The lifecycle of the load-window driver (ramp-up, RPS pacing,
abort, `LatencyTracker`, the steady→recovery structure, the assertion engine)
was sound and reusable; only the per-request *body* was synthetic. Replacing that
body with a real `Target` call is a transplant, not a rewrite. The neutral
`Workload` (`{ rps, concurrency?, rampUp? }`) replaces the parent-SaaS persona
model (buyer/seller/admin `spawnRate`), which the driver only ever collapsed into
one RPS number. The fault vocabulary is narrowed to what is injectable honestly
client-side; the rich-but-unused `ChaosConfig` (rate-limit, data-corruption, …),
the `findings_generated` always-0 metric, and the one-shot custom-`execute` hook
are removed. This keeps the surface honest — the through-line of the 2026-06-05
audits was removing capabilities that look wired but aren't.

**Consequences:**
- A `sim` scenario now requires a user-supplied `target` (use `httpTarget({ url })`
  for HTTP). `sim` will not ship until this lands — it is no longer synthetic.
- Removed public surface: the persona model (`persona`, `PERSONAS`,
  `getEstimatedRps`, `PersonaConfig`, `PersonaType`), `ChaosConfig`/`ChaosType`'s
  rich variants, `CustomExecuteFn`, and the `findings_generated` metric key.
- Added public surface: `Target`/`TargetContext`, `Workload`, `Fault`/`FaultKind`/
  `FaultSpec`, `httpTarget`, and the `fault.*` builders.
- Server-side fault injection remains BYO-and-documented; a future ADR may add a
  first-party fault-injection integration if demand warrants.

**Related specs / ADRs:** Implements the local spec
`docs/plans/specs/chaos-resilience-harness.md`. Sibling to **ADR-0011** (signals
as the universal *output* currency — this is the *input/driver* side).
