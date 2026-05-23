---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/graph"
package: "@opensip-tools/graph"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/graph

## Summary

`@opensip-tools/graph` is a six-stage static call-graph engine with a
language-pluggable front end. The architecture is unusually clean for
its size: stages are pure-data-in/pure-data-out, the
`GraphLanguageAdapter` boundary cleanly separates parser-specific code
from language-agnostic engine code, dependency-cruiser enforces nine
named architectural rules at build time, and tests assert nine
behavioral invariants (I-1 … I-9) at the contract surface. The five
rules are properly isolated from each other (zero cross-rule imports
verified) and consume only the frozen `(catalog, indexes, config)`
triple. The pipeline is a textbook Pipeline / Template Method
composition; the language adapters are textbook Adapter + Strategy.

The audit nonetheless surfaces a meaningful set of design tensions:
several places where the abstraction shape doesn't quite match what
it was nominally designed to be (rule-hints declared but unused;
`appendEdge` extracted as the only multi-adapter helper despite three
near-identical resolver functions in each adapter). A handful of
small SOLID drifts in `cli/graph.ts` and `cli/orchestrate.ts`
(orchestrator owns three jobs at once, error-handling wired via
`instanceof` ladder rather than typed dispatch). And one strategic
design choice that's correct today but constrains future work: the
public barrel does not re-export the adapter contract, so
"third-party language adapter" is not a first-class extension point
yet.

This audit lists 13 substantive findings and several non-findings
considered and dismissed.

## Existing patterns (correct usage)

The package uses a coherent set of GoF and SOLID patterns. Several are
unusually well-executed and worth calling out before the findings list
so reviewers can recognize the existing strengths.

- **Adapter (correct).** `GraphLanguageAdapter` in
  `packages/graph/engine/src/lang-adapter/types.ts` is a textbook
  Adapter pattern: a six-method interface (plus `ruleHints` and three
  identity fields) over heterogeneous parser back ends. The orchestrator
  in `cli/orchestrate.ts` only ever sees the contract surface; never a
  `ts.Program` or `Parser.Tree`. The contract carries `P = unknown`
  parse-state and uses opaque `nodeRef` / `sourceFileRef` handles in
  `CallSiteRecord` so the engine can thread parser state through
  `parseProject → walkProject → resolveCallSites` without introspecting.
  Nine behavioral invariants (I-1 … I-9) are documented on the
  interface JSDoc and asserted by the contract test suite.
- **Strategy (correct, multi-axis).** Three independent Strategy axes:
  language adapters (`lang-typescript` / `lang-python` / `lang-rust`,
  selected by `pickAdapter` at runtime), edge resolvers (six in the
  TypeScript adapter, dispatched per-call-shape in `dispatchCall` /
  `computeVerdict`), and renderers (`renderTable` / `renderJson` /
  `renderSarif`, selected by a switch in `cli/graph.ts`).
- **Registry (correct, two instances).** `lang-adapter/registry.ts`
  hosts a process-global `Map<string, GraphLanguageAdapter>` populated
  at module load via `bootstrap.ts`'s side-effect imports.
  `rules/registry.ts` is a static `readonly Rule[]` — the rule registry
  is intentionally *not* a Map (commented in the source as "v0.2 ships
  five built-in rules; runtime rule loading is deferred to v0.3 per
  DEC-6"). The asymmetry is deliberate.
- **Template Method (correct, per-rule).** Every rule conforms to
  `(catalog, indexes, config) → readonly Signal[]` and is registered
  in `rules/registry.ts`. The orchestrator iterates the registry and
  collects signals; nothing rule-specific lives outside each rule's
  file. Rules consume frozen data only — verified by the
  `graph-rules-no-parser` dep-cruiser rule and by inspection (zero
  cross-rule imports between any two of `orphan-subtree`,
  `duplicated-function-body`, `no-side-effect-path`,
  `test-only-reachable`, `always-throws-branch`).
- **Pipeline / Chain of Responsibility (correct).** Stages pass typed
  outputs forward only; no stage reads back into a predecessor's
  intermediate state. The `runStage<T>` helper in `cli/orchestrate.ts`
  uniformly wraps each stage with progress callbacks, monitor checks,
  and timing. `GRAPH_STAGES: readonly GraphStage[]` is the canonical
  ordering — exported so the live view can render the checklist.
- **Layering enforced at build time.** Nine named dep-cruiser rules
  (lines 204–358 of `.dependency-cruiser.cjs`) enforce: no CLI imports
  from graph; no check-pack imports from graph; rules don't import
  parser/pipeline/lang-typescript; renderers don't import
  pipeline/rules/lang-typescript; visitors and resolvers are mutually
  disjoint; only `lang-typescript/` imports `'typescript'`; only
  `lang-python` / `lang-rust` import `tree-sitter`; pipeline / cache /
  rules / render don't import any `lang-*`; CLI doesn't directly
  import any `lang-*` (with `bootstrap.ts` and `tool.ts` as named
  exceptions); SARIF reuse from fitness is restricted to
  `render/sarif.ts`. This is a much stronger enforcement story than
  most internal package boundaries get.

## Findings

### F-1 — `ruleHints` is contract surface area with zero consumers

- **Files / code:** `packages/graph/engine/src/lang-adapter/types.ts`
  (lines 142–151, 169), all three `lang-*/rule-hints.ts` files, all
  three `lang-*/index.ts` adapter exports, plus
  `packages/graph/engine/src/rules/no-side-effect-path.ts:26` and
  `packages/graph/engine/src/rules/always-throws-branch.ts:20`.
- **Pattern / principle:** Interface Segregation, YAGNI, contract honesty.
- **Status:** Substantive design issue. The `RuleHints` interface
  declares `isTestFile`, `generatedFilePatterns`, `sideEffectPrimitives`,
  and `throwSyntaxRegex`. All three first-party adapters supply
  populated `ruleHints` objects (TypeScript inline; Python and Rust in
  dedicated `rule-hints.ts` modules). A grep across the rules directory
  finds zero references to `ruleHints` from any rule. The
  `no-side-effect-path` rule uses a hardcoded
  `SIDE_EFFECT_TEXTUAL = /\b(?:console|logger|fs\.|http\.|fetch|process\.exit|throw\s+new)\b/`
  regex; the `always-throws-branch` rule uses a hardcoded
  `THROW_PATTERN = /^\s*throw\s+(?:new\s+)?[A-Z]\w*/` regex.
- **Why it matters:** The architecture docs
  (`docs/architecture/40-the-graph-loop/02-rules-and-gating.md`,
  fidelity matrix and adapter-hints paragraph) explicitly promise that
  adapter-supplied `ruleHints` configure the per-rule inputs and that
  rules degrade silently when hints are absent. The promise is
  unfulfilled: every adapter's `sideEffectPrimitives` and
  `throwSyntaxRegex` are dead. The TypeScript-biased hardcoded regex
  works on TypeScript source by accident (it doesn't match Python
  `print(` or Rust `println!`, the very primitives the Python/Rust
  adapters declare). A user running `graph` on a pure Python or Rust
  project gets a degraded `no-side-effect-path` and
  `always-throws-branch` not because of intrinsic tree-sitter
  limitations but because the rules ignore the hint surface.
- **Recommendation:** Either (a) wire the rules through the registered
  adapter's `ruleHints` (add a fourth argument to `Rule.evaluate` —
  `RuleHints` or a typed projection — and have `runGraph` pass
  `pickAdapter(cwd).ruleHints ?? {}`), or (b) delete the unused fields
  and document the rules as language-aware-by-textual-heuristic only.
  Option (a) restores the intended polymorphism; option (b) shrinks
  the contract to what it actually does. Either way, contract surface
  and engine behavior should agree.

### F-2 — Dispatch in `walk.ts:dispatchVisitor` is branch-on-type, not Visitor-pattern polymorphism

- **Files / code:**
  `packages/graph/engine/src/lang-typescript/walk.ts:192-201` —
  `dispatchVisitor(node, ctx)` is an if-ladder over
  `ts.isFunctionDeclaration` / `ts.isArrowFunction` /
  `ts.isMethodDeclaration` / `ts.isConstructorDeclaration` /
  `ts.isGetAccessor || ts.isSetAccessor` / `ts.isFunctionExpression` /
  `ts.isClassStaticBlockDeclaration`. Each branch hand-routes to its
  matching `visitX` from `inventory-visitors/`.
- **Pattern / principle:** GoF Visitor / Open–Closed Principle.
- **Status:** Pragmatic but not polymorphic. The seven inventory
  visitors share a uniform shape (`InventoryVisitor<N extends ts.Node>`)
  and live one-per-file under `inventory-visitors/` — the file layout
  *suggests* a Visitor table. The dispatcher does not use a table; it
  uses a literal if-ladder. Adding a new visitor requires editing
  `walk.ts`. The `inventory-visitors/types.ts` JSDoc explicitly
  acknowledges that `module-init` is the deliberate outlier, but the
  other six conform to the same callable shape.
- **Why it matters:** OCP — adding a new node-shape visitor (e.g. for
  decorator factories, JSX fragments, or some future TypeScript syntax)
  should be additive: one new file under `inventory-visitors/`. Today
  it requires editing the dispatcher too. The same critique applies
  symmetrically to `computeVerdict` in `edges.ts:301-316`, which is
  another if-ladder dispatching over `ts.isCallExpression` /
  `ts.isNewExpression` / `ts.isJsxOpeningElement` /
  `ts.isShorthandPropertyAssignment` / `ts.isIdentifier`.
- **Recommendation:** Promote the inventory-visitor table to data —
  e.g. an array of `[predicate, visitor]` pairs (or a `Map` keyed by
  a small set of `ts.SyntaxKind` values for the leaf cases that have
  unique kinds) declared at the top of `walk.ts`. The same pattern
  for resolver dispatch in `edges.ts`. Each new visitor or resolver
  then registers itself in one place near its definition; the
  dispatcher iterates the table. This also removes the
  cross-references that today force `inventory-visitors/types.ts` to
  document `module-init` as an exception (it would simply not appear
  in the table; `synthesizeModuleInit` is called separately in the
  walker initializer).

### F-3 — `resolveCallSites` and `resolveEdges` are duplicate implementations of the same logic

- **Files / code:**
  `packages/graph/engine/src/lang-typescript/edges.ts` —
  `resolveEdgesFromRecords` (lines 66–105, used by the orchestrator)
  and `resolveEdges` (lines 165–211, retained for "tests and external
  callers"). Both build the same `callsByHash` map, both call
  `rebuildCatalog`, both emit the same logger events, both contain
  near-identical `pushEdge` / `pushCreationEdge` helpers. Only the
  source of call-site records differs (pre-located vs. mid-walk).
- **Pattern / principle:** DRY, Single Source of Truth.
- **Status:** Knowingly duplicated. The file's docstring notes "the
  legacy `resolveEdges` is retained for tests and external callers
  that want a one-shot Stage 1+2 from a catalog." Phase 4 of the perf
  plan (referenced in `walk.ts:1-23`) fused stages 1+2 — the legacy
  function was kept so existing call-sites didn't break. In effect
  the file holds two parallel paths, with two `pushEdge`-shaped
  helpers (`pushEdgeFromRecord` lines 135–163 and `pushEdge` lines
  340–368). The walker's logic in `walkFileForEdges` /
  `maybeCollectCallSite` still does call-site discovery the legacy
  way.
- **Why it matters:** The `duplicated-function-body` rule will
  legitimately fire on these (above the minimum threshold). More
  important, the second path is **dead in production** — only tests
  and undocumented external callers reach it — and dead code in a
  resolver is a future-bug factory. Both paths must be kept in lock-
  step; future resolver fixes have to land in two places.
- **Recommendation:** Refactor the legacy `resolveEdges` to delegate
  to `resolveEdgesFromRecords` after running its own AST descent to
  produce `CallSiteRecord[]`. The descent logic lives in `walk.ts`
  already (`walkProgram` produces records); legacy callers can build
  their records through that path and feed them in. Net effect: one
  resolver implementation. If "external callers" are theoretical,
  delete `resolveEdges` outright (it's not exported through the
  package barrel, only re-exported from `lang-typescript/index.ts`
  alongside `resolveEdgesFromRecords`).

### F-4 — TypeScript adapter's deep subdir layout vs. Python/Rust flat layout — asymmetry is justified, but partly a side effect of the `resolveEdges` legacy

- **Files / code:** `packages/graph/engine/src/lang-typescript/{discover,parse,walk,edges,cache-key,index}.ts` plus four subdirectories (`inventory-visitors/`, `inventory-helpers/`, `edge-resolvers/`, `edge-helpers/`); compare to `lang-python/{discover,parse,walk,resolve,cache-key,rule-hints,index}.ts` (flat) and `lang-rust/` (flat).
- **Pattern / principle:** Single Responsibility, Open–Closed.
- **Status:** The deeper layout is *largely* justified by
  TypeScript's symbol-table-driven resolution: there are six edge
  resolvers (vs. one `resolve.ts` per tree-sitter adapter) and seven
  inventory visitors (vs. an inline switch in tree-sitter walks).
  The `03-adding-a-language.md` guide explicitly addresses this
  ("the TypeScript adapter has a deeper subdir layout because its
  symbol-resolved walk is genuinely more complex"). The asymmetry
  per se is fine.
- **Why it matters (refinement):** Some of the surface-area inflation
  is artificial. The TypeScript adapter has *two* resolver entry
  points (`resolveEdges` and `resolveEdgesFromRecords`, see F-3), it
  has both an `inventory.ts` and a `walk.ts` for what is now a single
  fused stage, and `edges.ts` carries its own AST-descent fallback in
  `walkFileForEdges`. After F-3's consolidation lands, `edges.ts`
  drops to roughly the size of the corresponding `resolve.ts` files,
  and the resolver subtree is the only TypeScript-specific complexity
  worth living in subdirs. That's the right end-state and would make
  the per-adapter layout asymmetry cleanly mirror the per-adapter
  fidelity asymmetry, with no incidental complexity left over.
- **Recommendation:** Treat the asymmetry as fine after F-3 is fixed.
  No action specific to this finding. Keep the subdirs in
  `lang-typescript/` for `inventory-visitors/`, `edge-resolvers/`,
  `inventory-helpers/`, `edge-helpers/` — they're the right SRP cuts.

### F-5 — Cache verdict dispatch is if-else, not polymorphic dispatch — but discriminated union is appropriate here

- **Files / code:**
  `packages/graph/engine/src/cache/invalidate.ts:43-89` defines the
  `CatalogVerdict` discriminated union (`'valid'` | `'incremental'` |
  `'invalid'`). `cli/orchestrate.ts:333-381` in `obtainCatalog`
  branches on `verdict.kind` with an if-else ladder.
- **Pattern / principle:** Strategy, but the data shape *is* a
  discriminated union, not a dispatch surface.
- **Status:** Correct as-is. Three verdicts, three rebuild paths
  (`'valid'` → return cached, `'incremental'` →
  `buildAndResolveCatalogIncremental`, `'invalid'` →
  `buildAndResolveCatalog`). A polymorphic dispatch (e.g. each
  verdict carrying a `rebuild()` method) would over-engineer the call
  site: each rebuild path needs different upstream data (cached
  catalog, changed-files set) which a method-on-verdict pattern would
  obscure. The if-else here is "data-driven dispatch over a closed
  union" — TypeScript's exhaustiveness checking on the union is the
  right tool.
- **Why it matters:** Mentioned only because the audit prompt called
  it out. The shape is intentional and idiomatic for a closed set of
  three verdicts that share no common rebuild signature.
- **Recommendation:** No change. If the verdict set ever grows past
  ~5 cases or starts sharing a signature, revisit; until then leave
  the discriminated union and exhaustive switch.

### F-6 — `appendEdge` is a real abstraction, not just dedup — but the rest of the resolver code remains duplicated

- **Files / code:**
  `packages/graph/engine/src/lang-adapter/edge-helpers.ts:22-30`
  defines `appendEdge(edgesByOwner, ownerHash, edge)`. Used by
  `lang-python/resolve.ts:171,195` and `lang-rust/resolve.ts:148,301`.
  The `lang-typescript/edges.ts` resolver does NOT use it (it inlines
  the same shape, e.g. lines 128–130, 156–158, 358–363, 285–290).
- **Pattern / principle:** DRY, abstraction shape.
- **Status:** Half-extracted. The abstraction is sound — owner-keyed
  edge accumulation is a real concept that the engine should expose
  centrally — but the extraction is incomplete: tree-sitter adapters
  use it, the TypeScript adapter doesn't (despite having four sites
  that perform exactly the same `get-or-create-list-and-push`
  pattern). And the *real* duplication across adapters is much larger
  than `appendEdge`: each adapter's `pushCreationEdge`,
  `isReturnValueDiscarded`, and confidence-stat tracking are
  near-identical with only file-shape and node-handle types varying.
- **Why it matters:** The `duplicated-function-body` rule originally
  flagged the duplication that motivated this extraction (per the
  helper file's docstring). The same rule today, run with a lower
  `minDuplicateBodySize`, would still fire — `appendEdge` was the
  smallest dedup, not the right one.
- **Recommendation:** (a) Convert `lang-typescript/edges.ts` to call
  `appendEdge` from `lang-adapter/edge-helpers.ts` so the abstraction
  is uniform across adapters. (b) Consider adding a few more shared
  helpers to `lang-adapter/edge-helpers.ts` for the adapter-shaped
  patterns: a generic `pushCreationEdge<NodeRef, FileRef>` factory
  that takes a `getStartLineColText` callback, a `MutableStats`
  object with `apply(edge)` method that consolidates the
  per-confidence stat increments. The current per-adapter
  reimplementation of these is exactly the kind of "structurally
  identical, semantically separate" code that a small generic helper
  could absorb.

### F-7 — Orchestrator's `runGraph` is clean pipeline composition; `obtainCatalog` mixes three concerns

- **Files / code:**
  `packages/graph/engine/src/cli/orchestrate.ts:144-204` (`runGraph`)
  vs. `cli/orchestrate.ts:333-381` (`obtainCatalog`).
- **Pattern / principle:** SRP, Pipeline composition.
- **Status:** `runGraph` itself is clean — six stages wrapped uniformly
  in `runStage`, with `obtainCatalog` and `buildIndexes` and the rule
  loop as black boxes. That's the textbook Pipeline shape. The
  problem is one layer down: `obtainCatalog` does three jobs:
  (1) read+classify the on-disk cache,
  (2) decide between `'valid'` / `'incremental'` / `'invalid'` paths
      and dispatch,
  (3) compute the final fingerprint and write the cache.
  And the helper functions for (3) thread `useCache` through, while
  (1) reads `useCache` separately, while (2) needs both the discovery
  output and the cached catalog.
- **Why it matters:** The orchestrator's two-level structure
  (`runGraph` clean, `obtainCatalog` mixed) means the cache logic
  isn't truly a pipeline stage — it's a sub-orchestrator inside the
  pipeline. That's why F-9 (the incremental rebuild path) is so
  large: it's stuffed into `obtainCatalog`'s caller surface rather
  than promoted to its own stage with its own input/output contract.
- **Recommendation:** Promote cache classification to its own stage
  before parse/walk/resolve. The shape would be:
  `discover → classify-cache → (parse + walk + resolve | reuse |
  incremental) → index → rules → render`. The classify-cache stage
  consumes `(adapter, discovery, useCache)`, returns
  `CacheVerdict + cachedCatalog?`. The downstream stage selects its
  rebuild strategy based on the verdict. This makes the
  cache-incremental path no longer a sub-orchestrator inside
  `obtainCatalog` and lets the live view render "cache" as a stage
  rather than retrofitting `'stage-cached'` events for the parse /
  walk / resolve stages it skips.

### F-8 — Heap preflight + pressure monitor are well-decoupled cross-cutting concerns

- **Files / code:**
  `packages/graph/engine/src/cli/heap-preflight.ts` (200 lines, three
  pure helpers + one re-exec), `cli/pressure-monitor.ts` (130 lines,
  factory + `MemoryPressureError`).
- **Pattern / principle:** Cross-cutting concerns, Decorator-like
  wrapping.
- **Status:** Both modules are properly decoupled from the
  orchestrator. `heap-preflight.ts` is invoked exactly once from
  `tool.ts:84-87` (and skipped on `--package` runs), runs adapter
  discovery to count files, and either returns `false` (continue) or
  re-execs with elevated `--max-old-space-size` and never returns.
  The orchestrator never sees it. The pressure monitor is created in
  `runGraph` (line 149), passed into `runStage` as a parameter, and
  disposed in `finally` (line 202). `runStage` calls
  `monitor.check()` before each stage. The monitor's polling timer
  lives behind a `dispose()` returned by `createPressureMonitor` —
  the orchestrator owns the lifecycle.
- **Why it matters:** Cross-cutting concerns *can* leak into every
  stage; here they're confined to one module each, with a single
  call site each (preflight) or a single composable wrapper (monitor
  via `runStage`). Adding a future cross-cutting concern (e.g.
  cancellation tokens, telemetry) follows the same shape.
- **Recommendation:** No change. This is the right design for these
  concerns. The only minor smell is that `runStage` (lines 113–136)
  has accumulated three orthogonal responsibilities (timing,
  progress callbacks, monitor.check). If a fourth lands, factor
  `runStage` into composable wrappers: `withTiming`,
  `withProgress`, `withPressureCheck`. Today three is fine.

### F-9 — Incremental rebuild logic is large, owned by one function

- **Files / code:**
  `packages/graph/engine/src/cli/orchestrate.ts:405-724` —
  `buildAndResolveCatalogIncremental`, `expandClosureToFixpoint`,
  `expandClosureOnce`, `collectHashesFromOccurrences`,
  `collectStaleHashes`, `groupCachedHashesByFile`, `findEdgeDependents`,
  `occHasEdgeIntoStale`, `mergeOccurrences`, `pushOccurrence`,
  `mergeResolvedAndCachedEdges`. Roughly 320 lines of one of the most
  algorithmically interesting parts of the engine sit inside the
  orchestrator file (which is 724 lines total).
- **Pattern / principle:** SRP, Bounded Context.
- **Status:** Substantive locality issue. The orchestrator's job is
  "wire stage outputs to stage inputs." The incremental-rebuild logic
  is "given a cached catalog and a set of changed files, compute the
  closure of files that need re-walking, then merge cached and fresh
  occurrences." That's an algorithm with its own preconditions,
  invariants, and tests. It belongs next to `cache/invalidate.ts`
  (which already classifies the verdict) — those two files together
  are "incremental cache management."
- **Why it matters:** The orchestrator is the most trafficked file in
  the graph package, yet it's now load-bearing for 320 lines of
  closure-fixpoint reasoning. Future contributors fixing a
  closure-expansion bug have to read past the entire pipeline
  composition to find it. The locality matters: someone debugging
  "why is this file in the closure?" should be reading a file named
  for that question, not the orchestrator.
- **Recommendation:** Extract `cache/incremental.ts`. It exports
  `runIncremental({ adapter, discovery, cachedCatalog, changedFiles
  }): { catalog, resolutionStats }`. The orchestrator becomes:
  ```ts
  const built = verdict.kind === 'incremental'
    ? runIncremental({ ... })
    : buildAndResolveCatalog(...);
  ```
  The 320 lines move with their unit-test surface. `cache/` then
  cleanly owns the entire cache-lifecycle story (read, classify,
  full-rebuild handoff, incremental-rebuild, write).

### F-10 — Public barrel does not re-export `GraphLanguageAdapter` / `registerAdapter` / `pickAdapter`

- **Files / code:**
  `packages/graph/engine/src/index.ts` — re-exports `graphTool`,
  `runGraph`, the catalog/edge/index/resolver/visitor types, and
  three render-context types. Does NOT re-export
  `GraphLanguageAdapter`, `RuleHints`, `registerAdapter`,
  `pickAdapter`, or `findAdapter` from `lang-adapter/`.
- **Pattern / principle:** Interface Segregation, public-surface
  intentional design.
- **Status:** Intentional gating, documented in
  `docs/architecture/40-the-graph-loop/03-adding-a-language.md` §3:
  "A third-party graph adapter is not a first-class plugin shape
  today. The graph package's public barrel does not re-export
  `GraphLanguageAdapter`, `registerAdapter`, or `pickAdapter`, and
  there is no `plugins.graph:` config key. To ship a third-party
  adapter you currently either (a) submit a PR adding it as a
  first-party adapter alongside ..., or (b) consume the package via
  deep imports inside a workspace and call `registerAdapter` from
  your own bootstrap." So this is a deliberate decision, not an ISP
  oversight.
- **Why it matters:** The contract surface, registry, and contract
  test suite are all designed for third-party reuse — the
  `_clearAdaptersForTesting` hook, the contract test helpers, and the
  per-adapter cacheKey-prefix invariant (I-8) all assume someone
  outside this repo could ship an adapter. But the barrel is the
  promise; without the barrel re-exports, "third-party adapter" is a
  documented future, not today. The plugin loader in `core` already
  has the discovery shape (`opensipTools.kind === 'tool'`); a
  parallel `kind === 'graph-adapter'` (or just exporting the registry
  surface from the barrel) would close the loop.
- **Recommendation:** When the team is ready to commit to the contract
  publicly, add three exports to `index.ts`:
  ```ts
  export type { GraphLanguageAdapter, RuleHints } from './lang-adapter/types.js';
  export { registerAdapter, findAdapter, pickAdapter } from './lang-adapter/registry.js';
  ```
  And introduce a `plugins.graph` discovery shape parallel to
  `plugins.tool` so adapters can install via npm. Until then,
  document this finding's deliberate trade-off in
  `lang-adapter/registry.ts`'s docstring (currently it just says
  "future PRs may auto-detect the right adapter from project files").

### F-11 — SARIF reuse from `@opensip-tools/fitness` is appropriately confined

- **Files / code:**
  `packages/graph/engine/src/render/sarif.ts:11-19` —
  `import { buildSarifLog } from '@opensip-tools/fitness';` plus
  re-exports of `chunkSarifRuns` and `reportToCloud`. The
  dep-cruiser rule `graph-may-import-fitness-sarif` (lines 351–358 of
  `.dependency-cruiser.cjs`) restricts this import to exactly
  `render/sarif.ts` with severity `'info'` (recorded but not
  rejected).
- **Pattern / principle:** Layering, controlled cross-cutting
  dependency.
- **Status:** Clean. Both fitness and graph sit at the
  tools/lang peer layer — neither depends on the other under the
  layering rules in `CLAUDE.md`. The dep-cruiser rule restricts the
  import's *location* (only `render/sarif.ts`), making it impossible
  to accidentally pull more of fitness in. The wrapper exists so a
  future `@opensip-tools/sarif` extraction is mechanical (replace
  one import line, delete the rule).
- **Why it matters:** This is the right way to handle a
  cross-package dependency that's *known* to be temporary — make it
  visible (the dep-cruiser rule), confine it (one file), and document
  the future extraction. The alternative (graph re-implements SARIF
  from scratch) would create the same three-way drift problem the
  `appendEdge` extraction solved.
- **Recommendation:** No change. When `@opensip-tools/sarif` actually
  exists, replace the import in `render/sarif.ts` and remove
  `graph-may-import-fitness-sarif` from dep-cruiser. The mechanics
  are already trivial.

### F-12 — `_entry-points.ts` is not a rule but lives in `rules/` — the leading underscore is the only signal

- **Files / code:**
  `packages/graph/engine/src/rules/_entry-points.ts`. Imported by
  `rules/orphan-subtree.ts:13` and
  `rules/test-only-reachable.ts:10`. Not registered in
  `rules/registry.ts`.
- **Pattern / principle:** Conway's Law / file-organization clarity.
- **Status:** Pragmatic but mildly confusing. The leading underscore
  is the convention ("shared by rules in this directory, not a rule
  itself") — the architecture doc calls this out explicitly. But the
  module exports `inferEntryPoints`, an algorithm consumed by exactly
  two rules; there's no rule-specific reason it has to live in the
  `rules/` directory. The file genuinely belongs elsewhere — either
  promoted to a `pipeline/entry-points.ts` (it consumes
  `(catalog, indexes)` and produces a derived view, which is exactly
  what `pipeline/indexes.ts` does) or co-located with `_entry-points`
  next to its single non-rule consumer (`cli/graph.ts:enrichEntryPoints`,
  which also imports it).
- **Why it matters:** "Looks like a rule, isn't a rule" is the kind
  of organizational paper cut that future contributors stub their
  toes on. A new contributor adding a sixth rule sees five rules
  registered + a sixth file `_entry-points.ts` in the same dir, and
  the leading underscore is doing all the documentary work.
- **Recommendation:** Move to `pipeline/entry-points.ts` and import
  from there (it's already adapter-agnostic and uses only Catalog +
  Indexes). The `rules/` directory then contains exactly the five
  registered rules — registry contents and directory contents agree.
  Smaller follow-up: `inferEntryPoints` could become a stage's
  output (`Indexes & EntryPoints`) so rules don't recompute it
  each call (today both `orphan-subtree` and `test-only-reachable`
  call `inferEntryPoints` once each per run).

### F-13 — Resolvers' `functionLikeFromDeclaration` is duplicated across five files in `edge-resolvers/`

- **Files / code:** Five edge-resolver files each define a private
  `functionLikeFromDeclaration(d: ts.Declaration): ts.Node | null`:
  `direct-call.ts:41-57`, `jsx-element.ts:50-62`,
  `property-access.ts:45-64`, `polymorphic.ts:62-82`,
  `new-expression.ts` (its variant for class declarations only). The
  shapes are slightly divergent — some accept `MethodDeclaration`,
  some don't; some unwrap `PropertyAssignment`, others don't — but
  the dominant 80% is the same `function-shaped declaration → node`
  walk.
- **Pattern / principle:** DRY.
- **Status:** The `graph:duplicated-function-body` rule's primary
  use case fires on this. The variations are real (each resolver
  cares about a slightly different subset of declarations) but the
  divergence is implicit: there's no central place that documents
  "method-dispatch resolvers accept method+function shapes;
  jsx-element resolvers accept arrow+function-expression only".
- **Why it matters:** Adding a new declaration shape (e.g. when
  TypeScript adds something like the `using` syntax for callable
  resources) requires editing five files; the audit-trail for "which
  resolvers should accept which declarations" lives in five places
  by inspection only.
- **Recommendation:** Move to one shared helper in
  `edge-helpers/declaration-to-node.ts` that takes a *bitmask* of
  acceptable shapes:
  ```ts
  export const enum DeclShape {
    FunctionDeclaration = 1 << 0,
    ArrowFunction       = 1 << 1,
    FunctionExpression  = 1 << 2,
    MethodDeclaration   = 1 << 3,
    Constructor         = 1 << 4,
    Accessor            = 1 << 5,
    MethodSignature     = 1 << 6,
    PropertyDeclaration = 1 << 7,
  }
  export function functionLikeFromDeclaration(
    d: ts.Declaration,
    accept: DeclShape,
  ): ts.Node | null { ... }
  ```
  Each resolver calls it with its specific mask. The "which resolver
  accepts which declaration" question becomes a single-line
  expression at each call site. Five copies become one.

## Non-findings considered and dismissed

- **"Rules import each other."** Verified by grep across `rules/`:
  zero cross-rule imports between any of the five rules. Both
  `orphan-subtree` and `test-only-reachable` import
  `_entry-points.ts`, which is shared infrastructure, not a peer rule.
  Dismissed.
- **"`pipeline/` reaches into `lang-typescript/`."** Verified by
  inspection: `pipeline/indexes.ts` only imports from
  `@opensip-tools/core` and `../types.js`. The `graph-pipeline-no-lang-import`
  dep-cruiser rule enforces this. Dismissed.
- **"Renderers import the catalog or rules."** Verified: `render/json.ts`
  imports only `Renderer` and `CliOutput` types; `render/table.ts`
  imports only `Signal` and `Renderer`; `render/sarif.ts` imports only
  the fitness SARIF helpers + `CliOutput`. Enforced by
  `graph-renderers-no-pipeline`. Dismissed.
- **"Three-verdict cache classification should be polymorphic."** See
  F-5. Dismissed in favor of discriminated-union dispatch with
  exhaustiveness checking.
- **"`runStage` is doing too many things."** Three concerns (timing,
  progress, monitor) is fine; revisit if a fourth lands. See F-8.
  Dismissed.
- **"`tool.ts` does Commander wiring inside `register()` instead of
  declaratively."** This is the contract every Tool implements (via
  `core.Tool`); `register(cli: ToolCliContext)` is intentionally
  imperative because Commander itself is. Dismissed.
- **"Rule severity dispatch belongs on the rule, not in
  `cli/graph.ts:handleGraphError`."** The error mapping in
  `handleGraphError` is for *engine* errors (ConfigurationError,
  ValidationError, MemoryPressureError, ToolError), not rule
  severities. Rule severity is `defaultSeverity` on each rule and
  `severityOverrides` in `GraphConfig`. The two concerns are
  separate; dismissed.
- **"Synthetic occurrences for `<module-init>` and `<arrow:...>`
  pollute the catalog's namespace."** Each name starts with `<` so it
  cannot collide with a real identifier; `lang-python/resolve.ts:97-98`
  and `lang-rust/resolve.ts:108-109` skip `name.startsWith('<')` when
  building name indexes; `duplicated-function-body` skips
  `kind === 'module-init'` and `kind === 'arrow'`. The convention is
  consistent and exploited by exactly the rules that need to ignore
  these synthetics. Dismissed.
- **"Catalog v3 migration carries a backwards-compatibility hook
  (`bodySize?` and `discarded?` are optional)."** This is properly
  designed migration: old catalogs degrade silently to legacy
  behavior, the optional-field shape is documented in `types.ts:69-78`
  and `types.ts:60-65`, and the rule fallbacks
  (`hasDiscardedCaller`'s `sawDiscardedField` flag in
  `no-side-effect-path.ts:67-84` and `isInterestingForDup`'s
  `bodySize !== undefined` guard in
  `duplicated-function-body.ts:117`) are explicit. This is the right
  evolution shape for an on-disk format. Dismissed.
