---
status: active
last_verified: 2026-07-09
owner: opensip-cli
---

# ADR-0148: MCP catalog identity, auto-swap, and complete freshness

```yaml
id: ADR-0148
title: MCP catalog identity, auto-swap, and complete freshness
date: 2026-07-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0147]
tags: [mcp, graph, catalog, freshness]
enforcement: mechanizable
enforced-by: ['script:mcp-catalog-generation', 'script:sqlite-graph-read-port', 'script:e2e-stdio']
enforcement-reason: >
  Golden generation-key tests, auto-swap port tests, and built-stdio e2e prove
  g1: identity, external catalog visibility without rebuild, and refresh semantics.
```

**Decision:** MCP graph reads identify catalogs with a package-internal
`catalogGenerationKey` that returns `g1:` plus the SHA-256 of a fixed versioned
tuple over `CatalogIdentity` fields. The raw identity never appears in
responses, logs, or cursors. Before every graph query, a concrete
`GraphGenerationController` performs an O(1) identity probe through
`@opensip-cli/graph/read` and atomically swaps an immutable in-memory generation
when a newer persisted row exists. Ordinary reads never rebuild; only explicit
`refresh_graph` may rebuild, and it short-circuits to `no-op`/`reloaded` when the
loaded generation is completely verified fresh.

Catalog payloads optionally stamp `adapterSelection` (forced/auto) and
`engineMode` (exact/sharded). Freshness verification reruns selection, discovery,
and cache-key assembly via `verifyCatalogInputs` on `@opensip-cli/graph/read`.
Absence of provenance yields `verification: 'partial'` and never an unqualified
fresh claim. Verification is coalesced per identity with a 2,000 ms burst window.

Cursor binding uses separate `projectKey` (core ephemeral project digest) and
`generationKey` (`g1:`) fields plus a query digest.

**Alternatives:**
- Pin one generation for process lifetime — rejected: external `opensip graph`
  stays invisible until an expensive rebuild.
- Always rebuild on refresh — rejected: duplicates work after a successful external graph.
- Infer forced/auto selection from language alone — rejected: unsafe; partial coverage is honest.
- Persist MCP generation/cursors — rejected: derived in-memory state only.

**Consequences:**
- Connected MCP servers see externally replaced catalogs on the next read.
- Agents diagnose wrong-project vs empty-graph via response context.
- Pre-feature catalogs remain queryable with partial freshness.
