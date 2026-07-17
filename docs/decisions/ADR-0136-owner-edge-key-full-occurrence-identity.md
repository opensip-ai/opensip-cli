---
status: active
last_verified: 2026-07-07
owner: opensip-cli
---

# ADR-0136: The owner-edge key is full occurrence identity, not (bodyHash, filePath)

```yaml
id: ADR-0136
title: The owner-edge key is full occurrence identity, not (bodyHash, filePath)
date: 2026-07-07
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0003]       # refines ADR-0003 application #1 (edge stitching)
tags: [graph, edges, catalog, correctness]
enforcement: not-mechanizable
enforcement-reason: >
  An identity invariant across the catalog's derived edge graph, guarded by
  tests (the same-file body-twin no-smear cases in edge-identity.test.ts and
  cross-shard-resolve.test.ts), not a lintable pattern. The existing
  `no-bodyhash-keying-outside-identity` fitness check keeps all owner keying
  routed through `ownerEdgeKey`; this ADR only widens what `ownerEdgeKey` hashes.

**Decision:** The owner-edge key is **full occurrence identity** —
`ownerEdgeKey(bodyHash, filePath, line, column)` — replacing the ADR-0003
2-tuple `ownerEdgeKey(bodyHash, filePath)`. Line and column are the owning
`FunctionOccurrence`'s 1-based declaration line and 0-based column. Every
bucketing/stitch site in `packages/graph` (the engine's `edge-identity`,
`catalog-builder.stitchEdges`, `incremental-merge`, `cross-shard-resolve`, and
the TypeScript adapter's `edges`/`edges-dispatch`/`boundary`/`resolveDependencies`/
`collectByOwner`) keys through this 4-tuple. This refines ADR-0003 application
#1 (edge stitching) without altering its broader principle that a `bodyHash` is
not an occurrence identity, nor its application #2 (reachability adjacency).

**Alternatives:**
- **(A) Keep the `(bodyHash, filePath)` 2-tuple (ADR-0003, prior behavior).**
  Rejected: it still collides when a `bodyHash` appears **twice in one file** —
  two byte-identical arrows on a single source line
  (`a.some((p) => p.test(x)) || b.some((p) => p.test(x))`) share a content hash
  and a file, so a 2-tuple bucket **unions their edges**. Only `column`
  distinguishes them. This is the exact residual ADR-0003 itself flagged when it
  rejected the span-filter alternative "fails when two twins start at the same
  absolute line."
- **(B) Add `column` only when `line` collides (a conditional key).** Rejected:
  branchy, and it desynchronizes the write key from the read key unless both
  sides re-derive the same collision test. A single always-full key is simpler
  and matches the occurrence identity the rest of the pipeline already uses.
- **(C) Carry a synthesized occurrence id on the edge/record model.**
  Rejected for the same reason ADR-0003 rejected its option (B): a deeper change
  to the `CallEdge`/record contract and many readers, when a wider composite
  bucket key achieves the same correctness additively.

**Rationale:** `(filePath, line, column)` is already the canonical occurrence
identity everywhere else in the graph: `Indexes.byOccId` keys occurrences on
`filePath:line:column`, and `mergeShardFragments`'s occurrence dedup keys on
`(bodyHash, filePath, line, column)` (Phase 3 added `column` precisely to keep
same-line body-twins distinct). Keying the owner-edge bucket on the same tuple
aligns edge attribution with occurrence identity, so no two distinct occurrences
can ever share a bucket. The key is a **build-time bucketing key only** — it is
never serialized, so the catalog stays schema version `3.0` and there is no
datastore migration. Cache correctness is automatic: `ENGINE_VERSION` is folded
into every catalog/shard-fragment cacheKey, so the next release version bump
invalidates stale catalogs and forces one cold rebuild with the corrected edges.
The equivalence gate is strengthened in lockstep: `diffCatalogsByEdge`'s
per-edge key moves from `bodyHash@line:col` to the owner-occurrence identity
`filePath:line:column@line:col`, so a same-file-twin collision-class divergence
is gate-visible instead of collapsed last-writer-wins.

**Consequences:**
- The `CrossBoundaryCall` cross-shard descriptor gains **required** `ownerLine`/
  `ownerColumn` fields (the owning occurrence's position, distinct from the
  call-site `line`/`column`). It is TypeScript-adapter-produced only, so this is
  a closed, non-polyglot surface.
- The engine's contract `CallSiteRecord`/`DependencySiteRecord`
  (`lang-adapter/types.ts`) gain **optional** `ownerLine`/`ownerColumn`. They are
  optional — not required — because the polyglot adapters (graph-go/java/rust/
  python) construct these records and key `edgesByOwner`/`dependenciesByOwner` by
  **bare `ownerHash`**, never through `ownerEdgeKey`. That is a **pre-existing**
  inconsistency with the engine's `ownerEdgeKey`-based stitch (unchanged since
  v0.1.0 and not exercised by any e2e polyglot build test); this ADR neither
  fixes nor worsens it. Migrating the polyglot adapters to full occurrence-keying
  (and then tightening these fields to required) is a separate, deferred item.
- The TypeScript adapter always populates both fields; its `walk` threads the
  owning occurrence's `(line, column)` alongside `ownerHash`, and the
  contract→internal round-trip asserts their presence.

**Related ADRs:** ADR-0003 (per-occurrence edge keying).
