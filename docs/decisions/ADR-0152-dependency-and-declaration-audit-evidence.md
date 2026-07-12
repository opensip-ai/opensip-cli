---
status: active
last_verified: 2026-07-11
owner: opensip-cli
---

# ADR-0152: Preserve dependency and declaration audit evidence

```yaml
id: ADR-0152
title: Preserve dependency and declaration audit evidence
date: 2026-07-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0003, ADR-0015, ADR-0147, ADR-0148, ADR-0149, ADR-0153]
tags: [graph, catalog, dependency, declaration, audit, mcp]
enforcement: mechanizable
enforced-by: ['script:depends-on-emission.test.ts', 'script:semantic-reference-facts.test.ts', 'script:catalog-repo.test.ts', 'script:semantic-fact-payload.test.ts', 'script:catalog-builder-incremental.test.ts', 'script:cross-shard-resolve.test.ts', 'script:engine-version.test.ts', 'script:read-declaration-reference-view.test.ts', 'script:lang-adapter-contract.test.ts']
enforcement-reason: >
  Adapter emission, CatalogRepo payload validation, independent cache ABI
  segments, incremental/sharded merge, and public graph/read views enforce the
  absence-sensitive dependency and optional semantic-fact contracts.
```

**Decision:** Exact graph catalogs preserve **absence-sensitive** module
dependency evidence and an optional, bounded **declaration/reference** semantic
plane without a catalog-version or SQLite schema migration.

- **Dependencies (three-state):** An **absent** `dependencies` field means the
  adapter/tier did not produce dependency evidence. A **present empty** array
  means the module was inspected and has no imports. A **populated** array
  carries orthogonal form + role + target-kind + basis classification with a
  closed valid form→role map. External/unresolved edges omit only
  `resolvedPackage` while retaining a complete atomic classification.
- **Workspace attribution:** Unique workspace bare-specifier targets that
  resolve through declaration-file entries are attributed via the workspace
  manifest with labelled basis/confidence. Ambiguous candidates fail closed
  (unresolved) rather than picking an arbitrary package.
- **Semantic facts (optional):** Exact TypeScript may emit
  `semanticFacts` with `referenceScope: 'cross-file'`, separate declaration IDs
  (`d1|…`), and cross-file reference sites. Same-file and declaration-file
  reference sites are deliberately omitted. Fast mode, polyglot adapters, and
  pre-feature catalogs leave the plane absent and report unsupported/partial
  inventory rather than inventing empty-complete evidence.
- **Integrity:** CatalogRepo re-validates on load (dangling target IDs,
  impossible form/role, path/control safety). Referential closure/downgrade runs
  at shard merge. No SQL migration; old catalogs remain readable with absent
  fields.
- **Cache ABI:** Dependency classification and semantic-fact planes use
  **independent** producer cache ABI segments so one plane can advance without
  overloading the other; old cold/warm/incremental/shard caches miss when the
  relevant segment changes.

**Alternatives:**
- Treat absent dependencies as empty — rejected: cannot distinguish “supported
  and empty” from “adapter/tier unsupported,” which corrupts package import
  coverage.
- New SQL tables or catalog-version bump for declarations — rejected:
  unnecessary migration surface; optional JSON payload with absent semantics is
  the established forward path (ADR-0148).
- IDE-style find-all-references indexing (same-file + declaration files) —
  rejected: unbounded volume and wrong product scope; this is audit evidence,
  not an IDE reference service.
- Fold non-callables into `search_symbols` — rejected: would corrupt the
  callable occurrence contract used by traversal tools.

**Rationale:** Modular audits need honest import completeness and a bounded way
to answer “where is this type declared / referenced?” without turning MCP into
an unbounded symbol index. Orthogonal labels keep call, import, declaration, and
runtime evidence distinct. Optional payloads preserve old catalogs and avoid
SQLite churn.

**Consequences:**
- Exact TypeScript must emit `dependencies: []` on supported empty module-inits.
- Adapters that omit a plane report unsupported coverage, never complete-empty.
- Public reads expose `search_declarations` / `references_to` separately from
  callable `search_symbols`.
- Production caps (e.g. 100k declarations / 500k references / per-declaration
  soft bounds) and path containment apply at the producer; tests pin constants
  and use injected small limits rather than full-size fixtures.

**Fitness check:** No check warranted — this is an absence-sensitive
runtime/persistence/equivalence invariant; a source-text fitness rule cannot
prove it.

**Related specs / ADRs:** ADR-0148 (generation/freshness, optional payload);
ADR-0149/0153 (MCP query protocol over this evidence); ADR-0147 (public
`graph/read` boundary).
