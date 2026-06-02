---
status: active
last_verified: 2026-06-01
owner: opensip-tools
---

# ADR-0003: A body hash is not an occurrence identity — edges and reachability key per occurrence

```yaml
id: ADR-0003
title: A body hash is not an occurrence identity — edges and reachability key per occurrence
date: 2026-06-01
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0002]
tags: [graph, edges, reachability, adjacency, catalog, correctness]
enforcement: not-mechanizable
enforcement-reason: >
  An identity invariant across the catalog's derived graphs; guarded by tests
  (body-twin regressions), not a lintable pattern.
```

**Decision:** A content `bodyHash` identifies a *body*, not an *occurrence* —
identical bodies in different files (a "body-twin") share one hash by design (it
is what `duplicated-function-body` relies on). Therefore **no derived graph may be
keyed or built off the `byBodyHash` (last-writer-wins) collapse**; anything that
attributes edges to, or traverses edges from, a function must operate per
occurrence. Two concrete applications:

1. **Edge stitching** (shipped 2.4.2). Call/dependency edges are bucketed by their
   owning occurrence — `ownerEdgeKey(bodyHash, filePath)`, not `bodyHash` alone —
   at every stitch point: the TypeScript resolver (`edges.ts`), the engine
   `stitchEdges`, the adapter `rebuildCatalog`/`collectByOwner`, the incremental
   merge, and dependency attachment. The `filePath` component is byte-identical to
   `FunctionOccurrence.filePath` so the lookup hits.
2. **Reachability adjacency** (specced, pending — `orphan-subtree-sharpening`). The
   `callees`/`callers` adjacency in `buildAdjacency` is built from
   `byBodyHash.values()` (one *winner* occurrence per hash), so a losing twin's
   out-edges are erased from the graph. Reachability rules (`orphan-subtree`,
   `test-only-reachable`) then BFS over a lossy graph and report **false orphans**.
   The fix: build adjacency by **unioning every occurrence's out-edges per hash**
   (from `occurrencesByHash`), not the winner's only.

**Alternatives:**
- **(A) Key by `bodyHash` alone (prior behavior).** Rejected: two functions with
  identical bodies in different files (a "body-twin," e.g. `stripStrings`
  duplicated across the five language adapters) share a hash, so a hash-only bucket
  **unions their edges** — each twin then appears to call every twin's callees,
  inventing phantom cross-package coupling (20 false `lang-*→lang-*` edges, hidden
  in the old `languages` diagonal until per-package bucketing exposed them).
- **(B) Carry a unique occurrence id (e.g. qualifiedName) on the edge model.**
  Architecturally cleaner but a deeper change to the `CallEdge`/catalog contract
  and many readers. Achieved the same correctness additively via the composite
  bucket key instead.
- **(C) Post-hoc span filter** — keep only edges whose line falls within the
  occurrence's `[line, endLine]`. Rejected as a band-aid: heuristic (fails when
  two twins start at the same absolute line) and doesn't fix the root keying.

- **(D) Build reachability adjacency from `byBodyHash` winners (prior behavior).**
  Rejected for application 2: it silently drops losing twins' out-edges. Proven on
  this repo — `analyze` in `api-contract-validation.ts` is a body-twin with
  `api-response-validation.ts`; `byBodyHash` kept the latter, so the former's
  `analyze → analyzeFile → …` chain is invisible and ~16 functions in that one
  file are reported as false orphans (plus the `lang-*` `scan`/strip body-twins).
  Unioning all twins' out-edges per hash over-approximates reachability, which is
  the *safe* direction for orphan detection (fewer false positives).

**Rationale:** A content hash is not an occurrence identity by design (identical
bodies share it, which `duplicated-function-body` relies on). So both *writing*
edges (which occurrence owns this edge) and *reading* edges (which edges leave
this occurrence) must be per occurrence — `(bodyHash, filePath)` for stitching,
and a per-occurrence union for adjacency — never the `byBodyHash` winner. The same
single root cause (collapse loses twins) produced two visible bugs: phantom
cross-package coupling edges, and false orphans.

**Consequences:**
- **Edge stitching:** `ownerEdgeKey` helper, used at all stitch points; regression
  covered by `body-twin-edges.test.ts`. Shipped in 2.4.2 alongside per-package
  bucketing ([ADR-0002]). Specced in
  [`graph-per-package-coupling`](../specs/graph-per-package-coupling.md).
- **Reachability adjacency (pending):** `buildAdjacency` must union per occurrence
  (from `occurrencesByHash`), not iterate `byBodyHash.values()`. This fixes
  `graph:orphan-subtree` *and* `graph:test-only-reachable` (shared machinery).
  Specced in
  [`orphan-subtree-sharpening`](../specs/orphan-subtree-sharpening.md).
- Cross-shard merge already deduped occurrences by `(bodyHash, filePath, line)`,
  so it is unaffected by either application.
