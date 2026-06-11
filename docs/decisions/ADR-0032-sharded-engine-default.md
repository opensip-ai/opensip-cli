---
status: superseded
last_verified: 2026-06-11
owner: opensip-tools
---

# ADR-0032: The sharded engine is the graph default; `--exact` is the opt-out

> **Superseded by [ADR-0033](./ADR-0033-cross-package-resolution-via-shared-hop.md).**
> ADR-0033 records the *corrected* cross-package resolution model — both engines
> resolve through ONE shared hop (exact = the 1-shard case), so the equivalence
> guardrail becomes a DIRECTIONAL soundness invariant (phantom / decline /
> conflict, each ratcheted) plus a pinned-corpus completeness floor, replacing
> this ADR's flat "budget toward zero" (the 2026-06-10 amendment below). The
> **default-engine policy in this ADR — sharded default, `--exact` opt-out,
> `isTTY` selects only the renderer, `mode=exact|sharded` cache stamping — is
> RETAINED unchanged** by ADR-0033; only the equivalence/guardrail model is
> replaced.

```yaml
id: ADR-0032
title: The sharded engine is the graph default; `--exact` is the opt-out
date: 2026-06-09
status: superseded
supersedes: [ADR-0031]
superseded_by: ADR-0033
related: [ADR-0015, ADR-0031]   # engine-version/mode cache stamping; one build/one finalize/many renderers
tags: [graph, cli, cache, determinism, performance]
enforcement: mechanizable
enforcement-reason: >
  The premise of this decision — that the sharded build is equivalent to the exact
  (single-program) build — is held by TWO layers (see Amendment 2026-06-10).
  (1) Synthetic fast PR-gate sanity checks: `equivalence-repo-scale.test.ts` builds
  the SAME medium multi-package fixture through BOTH engines and asserts full
  `CatalogEquivalence` (function set + intra/cross edges + SCCs), modulo the
  wall-clock `builtAt` field. (2) The LOAD-BEARING real-repo guardrail:
  `graph-equivalence-check` (CI, every PR) builds this repository through both
  engines and enforces `.config/graph-equivalence-budget.json` as a RATCHET —
  `functionsOnly{Exact,Sharded}` MUST be 0 (hard fail), production resolved-edge
  and SCC divergences must not EXCEED the budgeted residual (exceed → fail;
  decrease → pass with a hint to tighten; budget unreadable → fail loud).
  The engine-selection POLICY is pinned by `graph-execute.test.ts` (bare `graph` →
  sharded when shardable; `--exact` → single-program; a non-shardable project →
  exact fallback; `process.stdout.isTTY` does NOT affect the engine choice) and the
  cache-mode collision test in `engine-version.test.ts` (`mode=exact` vs
  `mode=sharded` keys never clobber). Determinism (cold == warm) is held by the
  merge-order tests in `determinism.test.ts`, the cold-vs-warm leg of
  `equivalence-repo-scale.test.ts`, and the datastore-backed warm-fragment leg in
  `sharded-graph.test.ts`.
```

**Decision:** The **sharded** build engine is the **default** for `graph`, and
`--exact` is the explicit opt-out to the single-program engine. The build engine is
still chosen by a deterministic policy that never reads `process.stdout.isTTY`: a
bare `graph` builds with the **sharded** engine **when the project is shardable**
(resolves to more than one non-empty shard); it builds with the **exact** engine
when `--exact` is passed OR the project isn't shardable (single-package / flat /
discovery failure — the natural exact fallback). `isTTY` continues to select only
the **renderer** (the Ink live view, which drives the exact engine and is therefore
eligible only under `--exact`, vs the static text/JSON path). The catalog cache key
continues to carry the engine mode (`mode=exact|sharded`) so the two engines keep
independent cache lineages and never overwrite each other's row.

This supersedes ADR-0031's **interim** choice of exact-as-default. ADR-0031 made
exact the default precisely *because sharded was not yet proven equivalent* and
deferred reconciliation as "a perf follow-up, not a blocker." That premise is now
removed: the reconciliation work landed and is held by the equivalence guardrails —
full equivalence on the synthetic fixture, and a characterized, budgeted residual on
the real repo (see Amendment 2026-06-10) enforced as a CI ratchet. ADR-0031's
**one build → one finalize → many renderers** invariant (the typed `FinalizedSignals`
suppression seam, and `isTTY` selecting only the renderer) is **retained unchanged**;
this ADR only flips which engine the deterministic policy selects by default.

**Alternatives:**
- *Keep exact as the default (status quo / ADR-0031).* Rejected: exact-as-default was
  explicitly an interim stance pending equivalence proof. With sharded equivalent
  within the budgeted, ratcheted residual (function-set parity is a hard zero),
  keeping exact as the default leaves the slower engine on the hot path (CI
  `graph --gate-save`, cold local runs) for no material correctness benefit.
- *Make `--sharded` opt-in but auto-engage it heuristically (e.g. by file count).*
  Rejected: ADR-0031 already rejected ambient engine selection — coupling "what we
  build" to discovery state or terminal context is the root non-determinism. The
  policy stays a pure function of explicit flags + structural shardability.
- *Drop the exact engine entirely now that they agree.* Rejected: exact remains the
  **oracle** the equivalence guardrail compares against, and the natural path for
  single-package/small repos (where there is nothing to parallelize). `--exact` keeps
  it a first-class, user-reachable escape hatch — and the safety net if a future
  change ever reopens a divergence.
- *Let `isTTY` pick the engine (route bare TTY runs to the live exact view).*
  Rejected: that would reintroduce engine-by-TTY — a developer's terminal and CI would
  run different engines. The live view drives the exact engine, so it is gated on
  `--exact`; a bare (sharded-default) run routes to the static path in a terminal or
  piped alike.

**Rationale:** ADR-0031 fixed two compounding defects (TTY-only suppression leak;
ambient engine selection) and, lacking an equivalence proof, chose the accurate
engine (exact) as the deterministic default while deferring sharded reconciliation.
The deferred work is done: the sharded merge is now a pure function of the fragment
set (canonical ordering), cross-shard boundary resolution applies the same
import-constraint pass as the single-program build, and the canonical file set is
partitioned identically across shards. The fixture guardrail proves the result is
byte-equivalent to exact on a corpus that exercises the real divergence classes
(deep cross-package chains, cross-package cycles, relative/intra-file edges, root and
test-tree files); the real-repo guardrail bounds the remaining resolver-fidelity
residual (Amendment 2026-06-10). With equivalence held and the residual ratcheted,
the default should be the **fast** engine.

**Consequences:**
- A bare `graph` builds with the sharded engine on shardable repos (the common
  monorepo case), so cold CI `graph --gate-save` and `pnpm graph` are faster than the
  exact-default they replace. Findings can differ from exact only within the
  characterized residual classes of the equivalence budget (Amendment 2026-06-10),
  which the CI ratchet holds from growing.
- `--sharded` is **removed** (it was the opt-in for the now-default engine); `--exact`
  is **added** as the opt-out. This is a breaking CLI change: scripts passing
  `--sharded` must drop it (it is now the default); scripts that need the
  single-program engine pass `--exact`.
- Small / single-package / flat repos that can't shard transparently use the exact
  engine — no flag required, no failure; `--exact` is only needed to force exact on a
  repo that *would* shard.
- The equivalence guardrails are now load-bearing for the default: the synthetic
  fixture tests (`equivalence-repo-scale.test.ts`, fast PR-gate sanity) and the
  real-repo `graph-equivalence-check` + budget ratchet. If a future change diverges
  sharded from exact beyond the budget, the PR gate goes red and the default must be
  re-examined (or the divergence fixed) before merge.
- ADR-0031's suppression seam, the typed `FinalizedSignals` contract, the
  renderer-by-TTY rule, and the `mode=exact|sharded` cache stamping are all unchanged.

**Amendment (2026-06-10) — budgeted equivalence, not strict byte-equivalence:**
Dogfooding a real-repo guardrail (`graph-equivalence-check`, run in CI on every PR)
falsified this ADR's original unqualified byte-equivalence claim: the synthetic
fixture corpus passes in full, but on this repository the engines diverge on **204
production resolved edges + 3 SCC memberships** (function-set parity IS exact —
`functionsOnly` is a hard zero). The residual is characterized
(`.config/graph-equivalence-budget.json`): ~61 sharded **over**-resolutions of
same-file/same-package simple names that exact correctly declines, ~36
column-misaligned duplicates from boundary extraction, ~1 cross-package phantom, and
~81 **under**-resolutions where exact's type checker follows re-export chains
(`export { x } from './y'`) the sharded export-index linker declines. The budget is a
**ratchet**: a run exceeding either number fails CI; a decrease passes and prints a
hint to tighten. Direction of travel: eliminate the phantom classes first (the ~61
over-resolutions and ~36 duplicates — phantom edges are the unsafe class), ratcheting
the budget toward the ~81 re-export class, which requires walk-time re-export capture
to close and is deferred. Wherever this ADR says "byte-equivalent," read: byte-equal
on the fixture corpus; equivalent within this budgeted, characterized, ratcheted
residual on real repos.

**Related specs / ADRs:** Supersedes ADR-0031 (graph determinism — one build, one
finalize, many renderers), retaining all of its invariants except the default-engine
choice. Builds on ADR-0015 (engine-version + mode cache stamping). Implements the
flip tracked in `docs/plans/graph-sharded-exact-parity*` (local). Residual diagnosis
recorded in `docs/internal/graph-false-findings-incident-log.md` and the
`graph-engine-convergence` plan notes.
