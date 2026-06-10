---
status: active
last_verified: 2026-06-09
owner: opensip-tools
---

# ADR-0032: The sharded engine is the graph default; `--exact` is the opt-out

```yaml
id: ADR-0032
title: The sharded engine is the graph default; `--exact` is the opt-out
date: 2026-06-09
status: active
supersedes: [ADR-0031]
superseded_by: null
related: [ADR-0015, ADR-0031]   # engine-version/mode cache stamping; one build/one finalize/many renderers
tags: [graph, cli, cache, determinism, performance]
enforcement: mechanizable
enforcement-reason: >
  The premise of this decision — that the sharded build is byte-equivalent to the
  exact (single-program) build — is held by a repo-scale guardrail in the PR gate:
  `equivalence-repo-scale.test.ts` builds the SAME medium multi-package fixture
  through BOTH engines and asserts full `CatalogEquivalence` (function set +
  intra/cross edges + SCCs), modulo the wall-clock `builtAt` field; if it goes red,
  the default is no longer safe. The engine-selection POLICY is pinned by
  `graph-execute.test.ts` (bare `graph` → sharded when shardable; `--exact` →
  single-program; a non-shardable project → exact fallback; `process.stdout.isTTY`
  does NOT affect the engine choice) and the cache-mode collision test in
  `engine-version.test.ts` (`mode=exact` vs `mode=sharded` keys never clobber).
  Determinism (cold == warm) is held by the merge-order tests in `determinism.test.ts`
  and the cold-vs-warm leg of `equivalence-repo-scale.test.ts`.
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
removed: the reconciliation work landed and is proven by the repo-scale equivalence
guardrail, so the accurate engine and the fast engine are the same catalog. ADR-0031's
**one build → one finalize → many renderers** invariant (the typed `FinalizedSignals`
suppression seam, and `isTTY` selecting only the renderer) is **retained unchanged**;
this ADR only flips which engine the deterministic policy selects by default.

**Alternatives:**
- *Keep exact as the default (status quo / ADR-0031).* Rejected: exact-as-default was
  explicitly an interim stance pending equivalence proof. With sharded proven
  byte-equivalent, keeping exact as the default leaves the slower engine on the hot
  path (CI `graph --gate-save`, cold local runs) for no correctness benefit —
  quality-over-speed no longer requires it, because the fast engine *is* the accurate
  engine.
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
partitioned identically across shards. The repo-scale guardrail proves the result is
byte-equivalent to exact on a fixture that exercises the real divergence classes
(deep cross-package chains, cross-package cycles, relative/intra-file edges, root and
test-tree files). With equivalence proven, the default should be the **fast**
engine — speed is now free, not a trade against accuracy.

**Consequences:**
- A bare `graph` builds with the sharded engine on shardable repos (the common
  monorepo case), so cold CI `graph --gate-save` and `pnpm graph` are faster than the
  exact-default they replace — and still byte-equivalent, so findings are unchanged.
- `--sharded` is **removed** (it was the opt-in for the now-default engine); `--exact`
  is **added** as the opt-out. This is a breaking CLI change: scripts passing
  `--sharded` must drop it (it is now the default); scripts that need the
  single-program engine pass `--exact`.
- Small / single-package / flat repos that can't shard transparently use the exact
  engine — no flag required, no failure; `--exact` is only needed to force exact on a
  repo that *would* shard.
- The equivalence guardrail (`equivalence-repo-scale.test.ts`) is now load-bearing for
  the default: if a future change diverges sharded from exact, the PR gate goes red
  and the default must be re-examined (or the divergence fixed) before merge.
- ADR-0031's suppression seam, the typed `FinalizedSignals` contract, the
  renderer-by-TTY rule, and the `mode=exact|sharded` cache stamping are all unchanged.

**Related specs / ADRs:** Supersedes ADR-0031 (graph determinism — one build, one
finalize, many renderers), retaining all of its invariants except the default-engine
choice. Builds on ADR-0015 (engine-version + mode cache stamping). Implements the
flip tracked in `docs/plans/graph-sharded-exact-parity*` (local).
