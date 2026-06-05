---
status: active
last_verified: 2026-06-05
owner: opensip-tools
---

# ADR-0015: Fold the engine version into the graph cache key

```yaml
id: ADR-0015
title: Fold the engine version into the graph cache key
date: 2026-06-05
status: active
supersedes: []
superseded_by: null
related: []
tags: [graph, cache, packaging, correctness]
enforcement: not-mechanizable
enforcement-reason: >
  The contract (a differently-versioned engine must reject a cached catalog)
  is covered by unit tests in
  packages/graph/engine/src/__tests__/cache/engine-version.test.ts. That every
  engine-side cacheKey computation routes through stampEngineVersion is a
  code-review invariant — there are only three such sites and they are listed
  in the Consequences below; a missed site would surface as a stale-cache bug,
  not a type error.
```

**Decision:** The graph engine stamps its own package version onto the
`Catalog.cacheKey` (via `stampEngineVersion`, prefix `eng=<version>|`) at every
engine-side cacheKey computation, so that upgrading opensip-tools invalidates the
persisted catalog and per-shard fragment caches for **every** language adapter
and the next run rebuilds with the engine the user actually installed.

**Alternatives:**

- *Do nothing (status quo).* The cache keyed only on adapter `cacheKey` (config +
  tool-version hash) + per-file fingerprint. Rejected: a tool upgrade with
  unchanged source replays a catalog built by the old engine — the customer
  analog of running a stale compiled binary. This is exactly the failure that
  motivated the ADR.
- *Dedicated `engineVersion` field/column with a distinct `engine-version-changed`
  verdict.* Cleaner observability, but asymmetric: the full catalog rides JSON
  payload (no migration) while the shard-fragment table compares by column and
  would need a schema migration or a payload parse on the hot reuse path.
  Rejected for the asymmetry and migration cost.
- *Manual `CATALOG_BUILD_VERSION` constant, bumped on catalog-logic changes.*
  Finer-grained (a no-op release wouldn't bust caches) but fragile: a forgotten
  bump silently under-invalidates — reintroducing the exact bug. Rejected;
  safety beats granularity.

**Rationale:** Both reuse-decision paths already invalidate on `cacheKey`
mismatch — `classifyCatalog` for the full catalog and
`planShardWork`/`loadValidShardFragment` for shard fragments. Folding the engine
version into that single existing channel covers both caches with one stamp, no
new fields, and no datastore migration: a pre-stamp catalog simply mismatches the
new `eng=` prefix and rebuilds once. The stamp is applied in the
language-agnostic engine, so it is inherently polyglot — TypeScript and the
tree-sitter adapters (go/java/python/rust) all flow through the same three sites.
The version comes from `readPackageVersion(import.meta.url)` (the same helper the
CLI uses for `--version`), so every release auto-invalidates without anyone
remembering to bump a constant. Over-invalidation (a no-op release triggers one
cold rebuild) is the deliberately safe default — debt from a stale cache
compounds; a one-time rebuild does not. Verified on this repo: same version →
shard fragments reused (3.1s vs 7.4s cold); the stored keys carry
`eng=3.0.0|ts-…`.

**Consequences:**

- New module `packages/graph/engine/src/cache/engine-version.ts` exports
  `ENGINE_VERSION` and `stampEngineVersion`.
- Three engine-side cacheKey computations MUST route through `stampEngineVersion`
  (any new one must too): `assembleCatalog` (catalog-builder.ts — build-time
  stamp), `obtainCatalog` (cache-orchestrator.ts — full-catalog reuse), and
  `planShardWork` (shard-runner.ts — shard-fragment reuse). The stamped and
  compared keys must agree, so all sites use the same helper.
- First run after any opensip-tools upgrade does one cold rebuild per project;
  subsequent runs cache-hit as before.
- The fitness tool is unaffected: it re-runs all checks against current source
  each invocation and keeps no persistent analysis cache, so it has no equivalent
  stale-engine gap. The fit gate baseline is a finding ratchet, not an analysis
  cache.

**Related specs / ADRs:** None.
