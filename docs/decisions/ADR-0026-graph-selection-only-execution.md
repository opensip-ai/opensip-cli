---
status: active
last_verified: 2026-06-08
owner: opensip-tools
---

# ADR-0026: Graph recipes are selection-only (no execution substrate)

```yaml
id: ADR-0026
title: Graph recipes are selection-only (no execution substrate)
date: 2026-06-08
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0012, ADR-0024]   # signal currency; versioning; CommandOutcome/observability
tags: [graph, execution, plugin-parity, recipes]
enforcement: mechanizable
enforcement-reason: >
  The `same-recipe-semantics` fitness check (release 2.13.0) verifies that fit + sim
  run their execution through the shared substrate, and carries graph as a
  documented exception per this ADR — graph declares no `execution` block to check.
```

**Decision:** Graph recipes are **selection-only**: a `GraphRecipe` is `{ id, name,
rules, tags? }` with **no `execution` block**, and rule evaluation is a single pass
over one built catalog — NOT a scheduled per-unit workflow. The 2.13.0 execution
substrate (`WorkflowExecutionOptions`: `timeout`/`maxParallel`/`stopOnFirstFailure`/
`retry`) applies to fit and sim; it does **not** apply to graph. This is an
intentional, ADR-documented difference under the "same unless deliberately and
visibly different" rule (north-star §6.7).

**Alternatives:**

- **Force graph rules onto the per-unit substrate** (give each rule a timeout /
  parallel / retry). Rejected: a graph rule is a pure function over the already-built
  catalog — there is no per-rule unit of work to time out, parallelize, or retry.
  Inventing those fields would create exactly the silently-dead config the release
  removes from sim (§4.3) — a `timeout` that does nothing erodes trust in the whole
  config surface.
- **Run graph's rule pass through a trivial single-unit substrate invocation** for
  progress/diagnostics parity only (no `execution` block exposed). Deferred — graph
  already has its own stage pipeline + heap/shard machinery; revisit only if
  diagnostics-bus (ADR-0024) parity demands it.

**Rationale:** The expensive, schedulable work in graph is the **catalog build**
(discover → parse → walk → resolve → index), which owns its own heap-pressure
monitor and sharded execution. Rule evaluation runs once over that built catalog
(`orchestrate.ts`, the rules stage). There is no per-unit lifecycle a generic
scheduler would own. Parity does not mean homogeneity (§6.7): the platform makes the
DEFAULT path consistent (fit + sim share the substrate) so that graph's remaining
difference is a recorded decision, not an accident.

**Consequences:**

- The graph recipe type stays `{ id, name, rules, tags? }`; no `execution` block is
  added.
- `same-recipe-semantics` (release 2.13.0) enforces fit + sim run on the substrate
  and treats graph as the documented exception this ADR records.
- Graph's per-rule severity is owned by `SeverityPolicy` + `createGraphSignal`
  (release 2.13.0), not by an execution config.

**Related specs / ADRs:** Implements part of
`docs/plans/specs/release-2.13.0-execution-severity-proof.md` (north-star §5.8
Execution substrate + §6.7 Intentional non-uniformity). Related: ADR-0024
(CommandOutcome/diagnostics), ADR-0012 (versioning).
