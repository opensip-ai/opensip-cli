---
status: active
last_verified: 2026-07-09
owner: opensip-cli
---

# ADR-0149: Bounded labelled MCP audit evidence

```yaml
id: ADR-0149
title: Bounded labelled MCP audit evidence
date: 2026-07-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0147, ADR-0148, ADR-0003]
tags: [mcp, graph, audit, package, runtime-wiring]
enforcement: mechanizable
enforced-by: ['script:graph-handlers', 'script:tool-descriptor', 'script:public-read-surface']
enforcement-reason: >
  Handler/port tests, exact 19-tool inventory, and graph/read surface locks prove
  occurrence defaults, package/runtime evidence labels, and protocol-only tools.
```

**Decision:** MCP audit evidence is precise by default, labelled by kind, and
bounded on every high-volume path.

- **Traversal identity** defaults to occurrence (`symbolId`). Body-twin-union is
  explicit and built by filtering both endpoints of the canonical
  `resolveCallee` occurrence edge stream before grouping by body hash — never by
  filtering global `Indexes.callers`/`callees` after union.
- **Package evidence** exposes call edges, import edges, why-depends samples, and
  edge-kind-specific package SCCs as separate labelled rows. Combined views keep
  labels; they do not invent one unlabeled count.
- **Runtime wiring** is a separate injected port projecting admitted
  registry/manifests/provenance/`CommandSpec` facts. It is not a static call
  edge and does not import CLI/Commander.
- **Paging** uses project/generation/query-bound base64url cursors; `page.nextCursor`
  and `coverage.truncated` are independent. Default page 100, max 500; walks
  depth ≤5 and ≤2,000 nodes; groups ≤500; final JSON ≤4 MiB.
- **Protocol tools only:** `package_dependencies`, `why_depends`, `package_cycles`,
  and `get_runtime_wiring` are MCP registrations inside `registerMcpTools`, not
  OpenSIP Tool plugins. Final default inventory is 19 tools.

All graph feature reads extend `@opensip-cli/graph/read` free functions returning
`Result`. MCP never imports `CatalogRepo`, raw `Indexes`, or `graph/internal` in
production.

**Alternatives:**
- Keep body-twin default for all walks — rejected: misattributes callers across twins.
- Fold runtime wiring into graph edges — rejected: confuses static and live evidence.
- Ship package tools as OpenSIP Tool plugins — rejected: no gate/signal/session surface needed.

**Consequences:**
- Architecture audits can attribute call/import/runtime evidence honestly.
- Agents page large fan-in without overflowing context.
- Spec 20 boundary remains the sole sanctioned graph consumption path.
