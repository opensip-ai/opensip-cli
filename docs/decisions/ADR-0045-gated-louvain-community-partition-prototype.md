---
status: active
last_verified: 2026-06-12
owner: opensip-tools
---

# ADR-0045: Run a gated Louvain import-community shard-partitioning prototype

```yaml
id: ADR-0045
title: Run a gated Louvain import-community shard-partitioning prototype
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0031, ADR-0033]
tags: [graph, sharding, partitioning, determinism, performance, prototype]
enforcement: mechanizable
enforcement-reason: >
  Three mechanical gates. (1) Determinism is pinned by the prototype's own test
  suite (`orchestrate/__tests__/community-partition.test.ts`: byte-identity
  run-to-run AND under seeded input shuffling, totality/disjointness, guard-rail
  bounds, unique ids, cold==warm shard ids + fingerprint inputs) — shipped WITH
  the prototype, not after it — plus exact (no-caret) version pins on
  `graphology`/`graphology-communities-louvain`. (2) Soundness is held by the
  ADR-0033 differential guardrail: `graph-equivalence-check` directional floors
  (all 0 in `.config/graph-equivalence-budget.json`) on this repo's CI every PR,
  plus a fixture-level equivalence run with `graph.partitionStrategy: community`
  configured, plus the pinned-corpus completeness floor and merge-determinism
  tests — all green on every prototype commit. (3) The adopt-or-discard verdict
  is a NUMERIC gate (thresholds below), recorded in this ADR's Outcome section
  either way.
```

**Decision:** Prototype a `community` value for the flat-monorepo
`partitionStrategy` (`packages/graph/engine/src/cli/orchestrate/flat-monorepo-strategy.ts`):
Louvain community detection over a file-level **import graph**, implemented
with `graphology` + `graphology-communities-louvain` (both MIT; both pinned
**exact**, no `^` — the library's iteration order is part of our behavior
surface), with max-shard-size splitting and small-community pooling as
deterministic guard rails. The prototype is opt-in via config
(`graph.partitionStrategy`, the ADR-0023 plane; `hybrid` stays the default)
and is governed by a numeric **adopt-or-discard gate**: adopt only if
`community` produces **≥ 25% fewer cross-shard boundary calls** than `hybrid`
(cold, both corpora) with **comparable shard balance** (max/median ratio
within ~1.5× of hybrid's, no shard over `maxShardSize`) and **no warm-cache
regression** (unchanged-tree warm runs fully cached and byte-identical;
single-edit `shardsBuilt` not materially worse; warm wall-time including
partition-compute overhead ≤ hybrid's). What this ADR accepts is the decision
to run the gated prototype; **the prototype plus its measurements are the
deliverable either way** — the B2 verdict and numbers are appended to the
Outcome section below, adopt or discard.

**Alternatives:**

- *Adopt community partitioning directly, no gate.* Rejected: the hypothesis is
  a performance/cache claim, not a correctness claim (divergence is already
  zero on main — ADR-0033, all directional floors at 0), so it must be
  falsifiable by measurement. An ungated flip would trade a proven-deterministic
  structural partitioner for an unproven semantic one on intuition.
- *Don't run the experiment at all (keep `hybrid` only).* Rejected: every
  cross-shard import a structural partition severs becomes a
  `CrossBoundaryCall` the main-thread linker must re-resolve post-merge, and
  the per-shard fragment cache keys on shard membership — a partitioner that
  follows the import graph plausibly shrinks both costs. The hypothesis is
  cheap to test now that ADR-0033's zero-divergence guardrail acts as a free
  regression gate (the original sequencing blocker — confounding the
  equivalence measurements — is gone).
- *Hand-roll the community detection (or pick a different algorithm).*
  Rejected: graphology + Louvain is a proven shape (provenance: the
  Understand-Anything batching layer, whose graph *construction* was rejected
  but whose partitioner idea survived scrutiny), MIT-licensed, and its
  determinism levers (`randomWalk`, `rng`, `resolution`) are documented.
  Hand-rolling moves the entire determinism burden in-house for no measured
  benefit.
- *Caret-range the new dependencies like everything else.* Rejected: Louvain's
  output depends on graph iteration order, so a patch bump can silently change
  partitions — which changes shard ids — which is fragment-cache and
  determinism behavior. Pin exact; any future bump must re-run the determinism
  suite AND the B1 measurement.
- *Scan imports with a regex inside the graph engine.* Rejected: the engine is
  deliberately parser-free (`@opensip-tools/graph` has no `typescript`
  dependency; "language-agnostic graph kernel; depends on no parser"), and a
  regex scanner is wrong on TS edge cases. Language knowledge belongs in the
  adapter — hence the `scanImports` seam (Consequences).
- *Call the TS adapter's scanner directly from `resolveSyntheticFlatShards`
  without a contract seam.* Held as fallback only: same code, no contract
  change, but a worse layering story. Default position is the seam (correct
  architecture first); it is removed on discard anyway, so its carrying cost is
  bounded by the prototype.
- *On a failed gate, keep `community` dormant behind config.* Rejected: an
  unadopted strategy is dead config surface plus two pinned runtime
  dependencies in a published package — exactly the debt class this repo's
  zero-tolerance policy exists to prevent. Full removal, with the learning
  preserved at zero carrying cost (this ADR + `results.md` + a prototype tag).

**Rationale:** Flat-large repositories (> 2500 source files, no workspace
structure) cannot build single-process, so the engine synthesizes shards via
`partitionFlatRepo` — today by purely *structural* strategies
(directory-depth / file-count-chunks / hybrid) that ignore the import graph.
Files that call each other constantly can land in different shards, and every
such call site is boundary-resolution work (`resolveCrossBoundaryCalls`) on
the cold path and partition-coupling on the warm path. **Hypothesis
(measurable):** import-community partitioning yields semantically coherent
shards → fewer cross-shard boundary calls → less boundary-resolution work per
cold build and stabler per-shard fragment-cache behavior on warm builds.
Correctness is explicitly NOT the prize — ADR-0033 already holds divergence at
zero; the same guardrail means any semantic regression the new partitioning
introduced would fail CI immediately, which is what makes a partition-layer
experiment safe to run at all. The non-negotiable constraint is determinism:
Louvain is seed- and iteration-order-sensitive, and `Shard.id` is the
fragment-cache primary key, so a partitioner that is not byte-identical
run-to-run violates the ADR-0031/ADR-0033 determinism guarantees (cold==warm,
one deterministic build) and thrashes the cache. The prototype therefore pins
determinism in three mandatory layers — no randomness (`randomWalk: false`,
plus a seeded local `mulberry32` rng as belt-and-braces, `resolution: 1` and
`fastLocalMoves: true` pinned explicitly), canonical iteration (sorted node
and edge insertion; never reliant on caller order), canonical output (numeric
Louvain labels discarded; shard ids derived from each community's
lexicographic anchor path, so ids are membership-local rather than
renumbering globally) — and ships the determinism test suite as part of the
prototype deliverable, not a follow-up.

**Consequences:**

- **New optional language-adapter seam `scanImports`** on
  `GraphLanguageAdapter`: a cheap, program-free, deterministic file→file import
  scan for partition-time use (TS implementation: `ts.preProcessFile` + cached
  `ts.resolveModuleName`, no `ts.Program`). This seam exists because discovery
  does **not** already carry an import map — `DiscoverOutput` has no
  dependency data, and per-file dependencies exist only post-build (the plan's
  "import map the discovery pass already has" did not survive code contact).
  Layering rationale: the engine consumes data, the adapter owns language
  knowledge — the engine stays parser-free (dependency-cruiser layer gates
  unchanged). The seam has no other consumer and is removed on discard.
- **Determinism obligations are load-bearing:** seeded + canonicalized +
  anchor-derived stable shard ids, byte-identical partitions for a fixed
  `(files, importEdges)`, cold==warm shard ids and fingerprint inputs on an
  unchanged tree. Honest limitation, measured not hidden: unlike `hybrid`, a
  one-file *import* edit can re-shape global community membership and
  invalidate many shards at once — this edit-stability risk (scenario W2) is a
  measured input to the "no warm-cache regression" criterion, and it is the
  most likely failure mode.
- **Continuous soundness gate:** the ADR-0033 differential guardrail
  (directional floors at 0) must stay green on every prototype commit — this
  repo's CI run exercises every shared seam the prototype touches, and a
  fixture-level `graph-equivalence-check` run **with `community` configured**
  (against an exact-oracle-feasible ~3,000-file synthetic flat fixture, hybrid
  as control) is part of verification. Any divergence is mechanically a bug in
  the prototype — fix or discard; never budget around it.
- **Discard path (zero tech debt):** on a missed gate, remove the `community`
  enum value, `community-partition.ts`, the `scanImports` seam, and both
  graphology dependencies — not dormancy. **Keep** the independently useful
  artifacts: the `graph.partitionStrategy` config knob + threading (makes the
  three existing strategies user-selectable), the profile-summary metric
  fields (`boundaryCallSites`, `shardSizes`, `shardsBuilt`/`shardsCached`,
  partition-stage timing — generally useful diagnostics), the flat-large
  fixture generator, and the bench script. Tag the last full-prototype commit
  (`prototype/louvain-partitioning`) so the code is recoverable from history.
- **Adopt path:** `selectStrategyForLayout` flips the `flat-large`
  recommendation to `community` (`hybrid` stays available via config), docs
  promote from experimental, and the config-knob promotion of
  `maxShardSize`/`minCommunitySize` is decided then.
- Either way, the measured numbers are appended to this ADR's Outcome section
  at B2 — a negative result is still the durable artifact.

## Outcome (B2 — to be appended)

**Verdict: pending orchestrator review** (B1 measured 2026-06-12; the numeric
gate is **NOT MET** — measurement recommends discard. The verdict line is
completed after the orchestrator's ruling.)

**Corpora.** (1) The seeded synthetic fixture (3,000 files, 30 import
clusters misaligned across 12 dirs, seed 0xf1a7). (2) A REAL flat repo —
**`ant-design/ant-design` @ `3442be35b8affc0dc7dc4169986a10e16f9f8c07`**: no
`workspaces`, no nested `package.json` on the detection paths, single root
`tsconfig.json`, 3,025 source files (2,785 discovered) → classifies
`flat-large`. The scaled-synthetic fallback clause was NOT needed.
Conditions: Apple M5 Max (18 cores, 128 GiB), Node v24.16.0, child heap
12,288 MB, concurrency 4, 3 cold runs (median), strategy toggled only via
`graph.partitionStrategy`.

**Measurement table** (verbatim from `results.md`, local plan dir):

Synthetic fixture (3,000 files):

| strategy | shards | boundary calls | max/median | CV | cold median ms | partition ms | W1 fully cached | W1 warm ms | W2a shardsBuilt | W2b shardsBuilt | equivalence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hybrid | 12 | 10322 | 1.00 | 0.00 | 4846 | 6 | yes | 752 | 1 | 1 | PASS |
| community | 30 | 299 | 1.00 | 0.00 | 9166 | 353 | yes | 1459 | 1 | 1 | PASS |

Real corpus (ant-design):

| strategy | shards | boundary calls | max/median | CV | cold median ms | partition ms | W1 fully cached | W1 warm ms | W2a shardsBuilt | W2b shardsBuilt | equivalence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hybrid | 91 | 27852 | 5.29 | 0.79 | 45818 | 5 | yes | 3891 | 1 | 1 | FAIL |
| community | 12 | 26538 | 7.24 | 1.24 | 8499 | 381 | yes | 2255 | 1 | 1 | FAIL |

**Gate evaluation (adopt requires ALL, on BOTH corpora):**

- *Boundary calls ≥ 25% fewer:* synthetic −97.1%; real **−4.7% → MISS**.
  Real boundary sets are dominated by call sites unresolvable in-shard
  regardless of co-location.
- *Shard balance:* PASS — max/median ratio 1.0× (synthetic) and 1.37×
  (real) of hybrid's, both ≤ ~1.5×; no shard over `maxShardSize` (2,000).
- *Warm cache:* W1 fully cached + byte-identical on both corpora (30/30 and
  12/12 `shardsCached == shardCount`); W2a = W2b = 1 shard rebuilt
  everywhere (the predicted import-edit instability never materialized);
  but warm wall-time **1.94× hybrid's on the synthetic corpus → MISS**
  (1,459 vs 752 ms — the import scan + Louvain runs on every warm build).
- *Soundness:* fixture-level `graph-equivalence-check` GREEN for both
  strategies at zero floors (the gate input as scoped). The real-corpus
  equivalence run was heap-feasible (exact oracle over 2,785 files completed
  in 12 GiB) and **FAILED for BOTH strategies including the hybrid control**
  (production divergences: hybrid 636, community 929) — a pre-existing
  sharded≢exact gap on foreign flat repos, not prototype-caused; but
  community widens it by 46%, and the layout-dependence itself shows
  ADR-0033's partition-independence invariant does not yet hold on
  foreign-repo resolution shapes (follow-up track, independent of this
  verdict).

**Headline surprise (durable learning):** cold wall-time follows SHARD
COUNT, not boundary-call volume — community was 1.9× slower with 30-vs-12
shards (synthetic) yet **5.4× faster** with 12-vs-91 shards (real:
8,499 vs 45,818 ms), while its 97% fixture boundary reduction bought no
wall-time. The real-corpus cold win is therefore capturable structurally
(shard-count cap / small-partition pooling for hybrid — the pooling rail
already exists) without graphology, the partition-time import scan, or the
warm-path overhead.

**Related specs / ADRs:** Implements
`docs/plans/specs/louvain-community-shard-partitioning.md` (local), from
`docs/plans/backlog/louvain-community-shard-partitioning/plan.md` (local).
Builds on ADR-0031 (graph determinism — one build, one finalize; cold==warm
obligations the partitioner must honor), ADR-0033 (one shared resolution hop +
the zero-divergence directional guardrail this prototype rides as its
continuous soundness gate), and ADR-0023 (the namespaced config plane carrying
`graph.partitionStrategy`).
