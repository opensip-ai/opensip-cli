---
status: active
last_verified: 2026-06-02
owner: opensip-tools
---

# ADR-0006: Derived-data persistence policy — materialize only when forced

```yaml
id: ADR-0006
title: Derived-data persistence policy — materialize only when forced
date: 2026-06-02
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0005, ADR-0001]
tags: [graph, persistence, datastore, performance, architecture]
enforcement: not-mechanizable
enforcement-reason: >
  A judgment about whether a derived field earns a stored copy. Partially
  observable (a reviewer can ask "can a rule recompute this cheaply in-engine?
  then don't persist it"), but there is no lint for it.
```

**Decision:** Derived data is a **plain recomputed view by default**.
**Materialize** it (store a copy in the persisted catalog document) **only when
recompute is expensive _or_ a decoupled consumer cannot run the query.**
Otherwise recompute it on read. We use **no SQL or DB (materialized) views** —
both patterns are hand-rolled in the engine.

**Alternatives:**
- **(A) Always materialize derived data.** Rejected: storage bloat and staleness
  for data that is cheap to recompute (e.g. the call adjacency `indexes`), and it
  enlarges every persisted artifact even for runs that never use the field.
- **(B) Never materialize — always recompute on read.** Rejected: a **decoupled
  consumer cannot recompute.** The dashboard reads a static catalog blob and
  imports no engine code; the gate/baseline likewise. Re-parsing source to
  rebuild the catalog on every read is also prohibitively expensive.
- **(C) Use SQL views / materialized views.** Rejected for now: the catalog is
  persisted as a single denormalized JSON document
  (`packages/graph/engine/src/persistence/schema.ts`, `graph_catalog.payload`,
  `mode: 'json'`), not normalized tables — there are no columns for a view to
  project. Revisit after the `graph-catalog-perf` normalization
  (`schema.ts` follow-up note) makes per-row tables, at which point real SQL
  views become viable.

**Rationale:** This ratifies the practice the codebase **already follows**
(audited 2026-06-02):

| Derived data | Pattern | Mechanism |
| --- | --- | --- |
| **Catalog** (parsed inventory) | **Materialized** | Computed once, stored as a JSON row, refreshed when the file-fingerprint cache key changes (`catalog-repo.ts` `replaceAll`). Parsing is expensive; the dashboard/gate can't re-parse. |
| **Shard fragments** | **Materialized** (partial) | Per-shard stored projections feeding the merged catalog (`sharded-graph.ts:120` `upsertShardFragment`). |
| **Indexes** (callers/callees) | **Plain view** | `buildIndexes(catalog)` recomputes on every load; never stored. Cheap once the catalog is in memory. |

The one sanctioned **duplication** in the system — the sharded build persisting
*both* per-shard fragments *and* the merged full catalog
(`packages/graph/engine/src/cli/orchestrate/sharded-graph.ts:120-124`: *"persist
each rebuilt shard's fragment … and the unified full catalog so whole-catalog
consumers still work"*) — earns its place by exactly this rule: whole-catalog
consumers (`loadFullCatalog`/`loadCatalogContract` → dashboard, baseline,
`lookup`, `symbol-index`) **cannot re-merge fragments**, so the merged view is
materialized for them.

**Consequences:**
- The **feature layer** ([ADR-0005](./ADR-0005-symmetric-tool-architecture-graph-rules-as-dataset-queries.md),
  Phase C) follows this policy: features are a **plain view** computed on demand
  for in-engine rules, and **materialized into the catalog JSON only for the
  columns the decoupled dashboard renders** (blast, SCC, package coupling) — the
  same justification as the catalog's own materialization. This is the **second**
  sanctioned duplication; do not materialize a feature any rule can cheaply
  recompute in-engine.
- Any future stored copy of derived data must name which half of the rule it
  satisfies (expensive recompute, or a decoupled consumer) in its spec/PR.
- Consistent with [ADR-0001](./ADR-0001-graph-rules-actionable-precise-bounded.md)'s
  corollary that rankings/metrics are dashboard insights: those metrics are
  materialized *for the dashboard*, not gated.
- **Revisit trigger:** when `graph-catalog-perf` normalizes the catalog blob into
  per-row tables, real SQL/materialized views become possible and this policy
  should be re-evaluated against them.

**Related specs / ADRs:**
[ADR-0005](./ADR-0005-symmetric-tool-architecture-graph-rules-as-dataset-queries.md)
(applies this to the feature layer);
[ADR-0001](./ADR-0001-graph-rules-actionable-precise-bounded.md) (rankings are
dashboard insights). Implemented detail in `docs/plans/specs/03-graph-feature-layer.md`
(local-only).
