---
status: superseded
last_verified: 2026-06-24
owner: opensip-cli
---

# ADR-0063: YAGNI as a freshness-gating reduction coordinator, not an analysis engine

> **Superseded by [ADR-0064](ADR-0064-shared-clone-detection-substrate.md)
> (2026-06-24).** The coordinator remedy below correctly diagnosed the 430-vs-0
> divergence but mis-prescribed the fix: making yagni reuse graph's evidence
> re-creates a tool→peer-tool internal dependency (it fails the "what if graph is
> uninstalled?" test and breaks the plugin-independence invariant), and it rested on
> a worker-bootstrap premise a spike later refuted. ADR-0064 single-sources duplicate
> detection in a shared `@opensip-cli/clone-detection` substrate that graph and yagni
> both depend on — so yagni re-owns duplicate detection independently, with no peer
> dependency and no divergence. Track 1 (the v0.1.12 detector deletion this ADR
> motivated) stands as the correct interim.

```yaml
id: ADR-0063
title: YAGNI as a freshness-gating reduction coordinator, not an analysis engine
date: 2026-06-24
status: superseded
supersedes: [ADR-0057]
superseded_by: ADR-0064
related: [ADR-0036, ADR-0062]
tags: [yagni, graph, fitness, tools, architecture]
enforcement: mechanizable
enforcement-reason: >
  Structural half is enforceable: `duplicate-body-candidate` is deleted (no file),
  a dependency-cruiser rule forbids yagni from owning detection that duplicates a
  graph rule or fitness check, and the `graph-evidence` seam stops building
  unconditionally. The freshness/coherence half is guarded by a test that asserts
  yagni reuses a content-valid cached catalog (no rebuild) and refuses
  time-stale persisted evidence — a behavioural test, not a static rule.
```

**Decision:** `yagni` owns **no detection logic of its own**. It becomes a
**reduction coordinator**: it produces the reduction audit by running graph rules
and fitness checks (tagged `reduction`) against **one content-coherent code
snapshot**, reusing each tool's **content-addressed cache when valid** and
recomputing only when the code changed — never re-implementing their detection and
never aggregating **time-stale** persisted findings. Concretely: delete
`yagni:duplicate-body-candidate` (a divergent re-implementation of
`graph:duplicated-function-body`) and re-home `yagni:unused-config-surface` to a
fitness check (it is a TS-AST config check that already "subsumes"
`fitness:unused-config-options`).

**Alternatives:**

- **Keep yagni as today (own engine, ADR-0057)** — rejected: both its detectors
  re-implement analyses that live in graph/fitness, and the duplicate detector
  *diverges* — on this repo it reports **430** warnings where
  `graph:duplicated-function-body` reports **0** (same `bodyHash` groups, different
  filters: yagni includes test files and uses a 5-*line* floor vs graph's
  production-only, 200-*character* floor). Two tools giving contradictory answers to
  the same question is a correctness defect, not just redundancy.
- **Passive view / recipe over persisted findings** — rejected: a reduction audit's
  advice is "delete this," so it is only safe if every finding describes the *same,
  current* code. If graph/fitness were never run the audit is empty; if they ran
  *days apart* it aggregates incoherent snapshots and can recommend deleting code
  that is now used (a bug-causing recommendation). Trusting whatever sits in the
  datastore is unsafe for this tool.
- **Fold yagni entirely into graph** — rejected: `unused-config-surface` is a
  TS-AST/config-schema + `package.json#exports`-reachability concern with
  `requiresGraph: false`; it has no call-graph content and belongs in fitness, not a
  call-graph kernel.

**Rationale:** ADR-0057 justified yagni-the-engine on "call-graph body-hash
grouping is proven machinery." That machinery already *is* a graph rule; yagni
re-implemented it and drifted. Examining the second detector showed it is
fitness-shaped (same `getSharedSourceFile`/`isInPublicApiSurface` primitives as
`checks-typescript`). So yagni owns **no unique mechanism** — only a *framing*
("what can I safely remove") and a confidence model. The freshness questions then
rule out a passive view: correctness depends on coherent, current evidence. The
only design that keeps coherence (today's one real strength), removes the
redundancy and the 430-vs-0 divergence, and removes the unconditional ~40s in-process
graph rebuild is a **coordinator** that reuses each tool's analysis + content-addressed
cache against a single snapshot. Graph's catalog cache is already content-keyed
(ADR-0062 machinery), so "ran days ago" is safe when the code is unchanged (cache
hit) and self-heals when it changed (cache miss).

**Consequences:**

- `packages/yagni/engine/src/detectors/duplicate-body-candidate.ts` is **deleted**,
  along with its registry entry, tests, and fixtures. Reduction-of-duplicates is
  graph's (`graph:duplicated-function-body` + `graph:near-duplicate-function-body`).
- `unused-config-surface` moves to a fitness check (folding in its
  exports-reachability scoping); the older `fitness:unused-config-options` it
  subsumes is retired in the same change. yagni stops owning config analysis.
- With no graph-backed detector, yagni no longer calls `runGraph` to **build**;
  `graph-evidence.ts` may only **reuse** a content-valid cached catalog (or trigger
  graph's own cached build), never an unconditional rebuild. The
  `requiresGraph`/`skippedDetectors` plumbing from ADR-0057 is removed or reframed.
- yagni's surface becomes a **reduction recipe + coordinator**: it selects
  `reduction`-tagged graph rules and fitness checks, ensures one coherent snapshot,
  and applies the confidence/presentation model. The live-view freeze (the symptom
  that started this) disappears because there is no in-process build to animate.
- The graph-evidence layering allowance from ADR-0057 narrows from "build" to
  "reuse-or-trigger-cached"; the dependency-cruiser allowlist for
  `@opensip-cli/graph/internal` stays but its permitted call set shrinks.
- A `reduction` tag/taxonomy is added to the graph-rule and fitness-check metadata
  so the coordinator can discover its inputs without hard-coding them.

**Related specs / ADRs:** `docs/plans/specs/yagni-reduction-coordinator.md`
(implementation + dead-code removal), supersedes ADR-0057 (yagni as an engine),
related ADR-0062 (near-clone detection — the duplicate work that belongs in graph),
ADR-0036 (baseline fingerprints — the content-addressed machinery reuse relies on).
