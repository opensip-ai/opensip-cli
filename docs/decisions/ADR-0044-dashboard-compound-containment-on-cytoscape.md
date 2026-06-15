---
status: active
last_verified: 2026-06-12
owner: opensip-cli
---

# ADR-0044: Dashboard graph containment via compound nodes on the existing Cytoscape substrate

```yaml
id: ADR-0044
title: Dashboard graph containment via compound nodes on the existing Cytoscape substrate
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0006]
tags: [dashboard, graph, visualization, vendoring, guardrails]
enforcement: mechanizable
enforcement-reason: >
  Every clause has a gate: the widened `dashboard-no-ui-framework` depcruise
  rule (`.config/dependency-cruiser.cjs`) blocks src/ imports of cytoscape AND
  cytoscape-* plugins; the vendor + bundle-weight tests
  (`dashboard-cytoscape-vendor.test.ts`, `dashboard-bundle-weight.test.ts`)
  pin the 700 KB budget, the six stamped sources, and the per-element blob
  budgets; the offline integration test pins zero network at view time; the
  strict-mode dogfood test pins zero GraphIssues on this repo's own catalog.
```

**Decision:** Upgrade the dashboard's existing Code Paths Visualization view
(`packages/dashboard/src/code-paths/view-graph.ts`, view id `graph`) to a
**two-level compound (containment) model** on the Cytoscape substrate it
already ships: packages become compound parent nodes, function occurrences
become slim child nodes, **collapsed by default**, with cross-package edges
pre-aggregated one-per-directed-pair. No new visualization stack is adopted.
The two new plugins — `cytoscape-expand-collapse` and `cytoscape-fcose` (plus
fcose's transitive `cose-base` and `layout-base`; all four MIT) — enter
exclusively through the vendored-UMD transport
(`packages/dashboard/scripts/vendor-cytoscape.mjs` → committed
`src/vendor/cytoscape-bundle.js`), never as `src/` imports. The vendor budget
is deliberately raised **600 → 700 KB raw** with vendor-time minification of
unminified upstream dists. The catalog→view-model projection gains a
**`GraphIssue` validate→repair→report ingestion pass** — strict-throw in
dev/tests, repair+report in prod.

**Alternatives:**

- *Adopt React Flow (`@xyflow/react`) + elkjs — the stack the borrowed recipe
  ships on.* Rejected: it is a React component library, so adopting it means
  shipping a React app inside the static report — a delivery-model rewrite
  that violates the `dashboard-no-ui-framework` depcruise rule, the offline
  single-file-HTML guarantee, and the bundle-weight gate, not a view upgrade.
  elkjs is additionally EPL-2.0, a licensing question we do not need to take
  on: compound nodes are *native* to Cytoscape, `cytoscape-expand-collapse`
  exists, and fcose (MIT) handles compound layout. (This stack was proposed in
  the original combined plan and dropped in review.) `cytoscape-elk` survives
  only as the last rung of the layout fallback ladder — fcose → dagre
  top-level + per-container child layout → cytoscape-elk — and that rung is
  gated on an explicit future EPL-2.0 license review and a separate ADR; it is
  not part of this feature.
- *Keep the flat package-level view + the bolted-on "Level = function" mode.*
  Rejected: function-level catalogs contain thousands of nodes — unusable in a
  flat layout — so today's `gvBuildFunctionElements` workaround shows one
  package's functions at a time. Containment closes the gap structurally: the
  visible set stays small *by construction* (collapsed parents), and function
  granularity is reachable everywhere via expand-in-place.
- *Import the plugins normally and bundle at build time.* Rejected: `src/`
  imports of visualization libraries are exactly what
  `dashboard-no-ui-framework` forbids; the vendored-UMD transport (committed,
  version-stamp-bannered, auditable file read via `node:fs`) is the
  established delivery mechanism and keeps the dashboard a string-template
  HTML generator. The rule's regex (`cytoscape(/|$)`) did not actually match
  `cytoscape-*` plugin names — this decision **widens it** to
  `cytoscape(-[^/]+)?`, closing the gap rather than exploiting it.
- *Hold the 600 KB budget (drop fcose or expand-collapse).* Rejected: the
  measured addition is ~152 KB even after minifying the three unminified
  upstream dists (layout-base 147,958 → 59,151 B; cose-base 118,906 →
  44,857 B; cytoscape-fcose 57,239 → 20,585 B; expand-collapse already
  minified at 31,284 B), landing the bundle at ~649 KB. 700 KB preserves the
  gate's purpose — catching *careless* growth — with ~50 KB headroom, and the
  raise follows the "raise BUDGET_KB with justification" path the vendor
  script itself documents. Minification determinism comes from exact-pinned
  esbuild + exact-pinned source versions.
- *Skip the GraphIssue pass (our catalog is deterministic, so trust the
  projection).* Rejected: determinism is precisely why the pass pays off —
  any issue indicates *our* bug, so strict mode turns projection bugs into
  test failures instead of silently-broken reports, while repair mode
  guarantees an end user's `dashboard` run never throws (repairs applied,
  slim summary embedded, details surfaced via `onGraphViewModelIssue` to the
  CLI's scope logger).

**Rationale:** The recipe is borrowed from the Understand-Anything dashboard
evaluation (2026-06-10): containment + expand/collapse + inter-container edge
aggregation + the `GraphIssue` pre-layout validate→repair→report idiom is
what makes 1000+-node graphs workable (their design doc: readable ≤100
nodes/layer, workable to 1000+ via containment). Their graph *construction*
layer was rejected outright — LLM-asserted name-based edges with zero
resolution, a schema that coerces malformed input, and an LLM-ID repair merge:
the guess-then-repair phantom-edge anti-pattern our decline-beats-guess engine
exists to prevent. Nothing from that layer is adopted; we take the rendering
recipe and the integrity idiom, on our deterministic catalog. The recipe is
also already half-implemented here: `GraphViewModelEdge.weight` is exactly the
per-package-pair aggregation it needs. This is a view upgrade inside existing
guardrails, not a platform change: projection stays at report-generation time
as an embedded JSON blob (recompute-not-materialize, never persisted back —
ADR-0006's decoupled-reader posture is preserved, with `graph-view-model.ts`
remaining the bundle-size budget enforcement point), and nothing in
`@opensip-cli/graph` or the `GraphCatalog` contract changes.

**Consequences:**

- The vendor bundle grows to six stamped sources in load-bearing order
  (`cytoscape`, `cytoscape-dagre`, `layout-base`, `cose-base`,
  `cytoscape-fcose`, `cytoscape-expand-collapse` — fcose's UMD global chain
  is order-sensitive); `BUDGET_KB` is 700 in the script and both gate tests,
  with the measured table above as the recorded justification. esbuild joins
  `@opensip-cli/dashboard` as an exact-pinned devDependency.
- The `dashboard-no-ui-framework` regex covers `cytoscape-*` plugins; the
  offline test additionally asserts the new globals resolve with zero
  `<script src>`/CDN.
- `GraphViewModel` becomes a two-level compound shape with per-element byte
  budgets enforced in CI (children carry ordinal id, label, file:line,
  bodyHash join key, kind index, test flag, feature scalars — the report
  ships the projection, not the catalog). The legacy `Level`/`Package`
  two-mode control surface is retired; expand-in-place subsumes it. View id
  `'graph'` and deep-link hashes stay stable.
- `projectCatalogToGraphViewModel` gains `issuePolicy: 'strict' | 'repair'`
  (explicit option > env override > test-env detection > default repair);
  this repo's own catalog must project strict-clean as a dogfood gate.
- Adopting `cytoscape-elk` ever requires an EPL-2.0 license review and a new
  ADR first; a layout web worker, if measurement ever demands one, must be a
  Blob-URL worker (single-file HTML constraint).

**Related specs / ADRs:**
`docs/plans/specs/dashboard-graph-containment-upgrade.md` (local-only;
implements this decision);
`docs/plans/backlog/dashboard-graph-containment-upgrade/plan.md` (local-only;
provenance + the React Flow rejection);
[ADR-0006](./ADR-0006-derived-data-persistence-policy.md) (the dashboard
stays a decoupled reader; the projection is the sanctioned
materialized-for-the-decoupled-consumer view, recomputed per report and never
persisted back).
