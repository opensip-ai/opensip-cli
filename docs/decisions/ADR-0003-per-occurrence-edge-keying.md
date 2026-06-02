---
status: active
last_verified: 2026-06-01
owner: opensip-tools
---

# ADR-0003: Call/dependency edges are keyed per occurrence, not per body hash

```yaml
id: ADR-0003
title: Call/dependency edges are keyed per occurrence, not per body hash
date: 2026-06-01
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0002]
tags: [graph, edges, catalog, correctness]
enforcement: not-mechanizable
enforcement-reason: >
  An identity/keying invariant in the edge-stitch pipeline; guarded by tests
  (body-twin regression), not a lintable pattern.
```

**Decision:** Call and dependency edges are bucketed by their **owning occurrence**
— `ownerEdgeKey(bodyHash, filePath)` — not by `bodyHash` alone, at every point in
the resolve→stitch pipeline: the TypeScript resolver (`edges.ts`), the engine
`stitchEdges`, the adapter `rebuildCatalog`/`collectByOwner`, the incremental
merge, and dependency attachment. The `filePath` component is byte-identical to
`FunctionOccurrence.filePath` so the stitch lookup hits.

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

**Rationale:** A content hash is not an occurrence identity by design (identical
bodies share it, which `duplicated-function-body` relies on). Edge ownership must
therefore key on `(bodyHash, filePath)`, the minimal unique occurrence key, so an
occurrence carries only its own edges. Cross-shard merge already deduped by
`(bodyHash, filePath, line)`, so only the single-program stitch path needed the
fix.

**Consequences:**
- `ownerEdgeKey` helper in the engine, used consistently at all stitch points.
- Regression covered by `body-twin-edges.test.ts` (a twin keeps only its own
  callee edge).
- Shipped in 2.4.2 alongside per-package bucketing ([ADR-0002]), which made the
  artifact visible. Specced in
  [`graph-per-package-coupling`](../specs/graph-per-package-coupling.md).
