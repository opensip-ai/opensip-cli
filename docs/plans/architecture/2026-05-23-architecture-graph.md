---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/graph"
package: "@opensip-tools/graph"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-graph.md
remediation-plan: ./2026-05-22-plan-layer-3-tools-and-lang.md
---
# Architecture audit (delta) — @opensip-tools/graph

## Summary

Waves 1–4 closed the substantive shapes from the 2026-05-22 audit:
F-1 (`RuleHints` wired), F-3 (`resolveEdges` collapsed), F-9
(incremental rebuild extracted), F-2 (visitor/verdict tables),
F-6 (shared edge helpers across all adapters), F-13
(`functionLikeFromDeclaration` consolidated). `cli/orchestrate.ts`
is now 388 lines (down from 724); `cache/incremental.ts` carries
the 320 lines that used to live in the orchestrator. None of the
prior findings regressed.

The delta surfaces three NET-NEW findings (one substantive — N-1,
the live-view double-key shape introduced by Wave 4 wiring), and
one MISSED finding the prior audit overlooked (M-1: `inventory.ts`
duplicates `walk.ts`'s file-walking scaffolding — symmetric to the
F-3 problem on the resolver side, only the resolver got the fix).
Three prior findings remain partially closed by deliberate scope
(F-7 stage promotion, F-9 test-relocation, F-12 `_entry-points`
move).

## Prior-finding status

Each entry cites the commit that landed the fix. Line numbers refer
to the current source.

### F-1 — `RuleHints` wired into rule evaluation — **CLOSED** (`8010c2e`)

`Rule.evaluate` (`types.ts:208-218`) takes an optional fourth
`hints?: RuleHints`; `runGraph` threads `adapter.ruleHints` at
`cli/orchestrate.ts:183-197`. `rules/no-side-effect-path.ts:47-66`
builds a detector from `hints.sideEffectPrimitives` with the
TS-shaped regex preserved as fallback (`:35-36`).
`rules/always-throws-branch.ts:36` reads `hints?.throwSyntaxRegex`
with the same fallback shape. The TypeScript adapter populates
both hints in `lang-typescript/index.ts:103-123,218-222`.

### F-2 — Visitor / verdict if-ladders — **CLOSED** (tabularization)

`walk.ts:201-209` declares `VISITOR_TABLE` (seven entries) iterated
in `dispatchVisitor` (`:217-222`). `edges.ts:267-288` declares
`VERDICT_TABLE` (five entries) iterated in `computeVerdict`
(`:291-296`). Adding a new entry is one line at the table site.

### F-3 — `resolveEdges` parallel path — **CLOSED** (`d703171`)

`edges.ts:174-191` is now a 17-line wrapper: `resolveEdges`
runs `collectCallSites` to produce a flat `CallSiteRecord[]` and
delegates to `resolveEdgesFromRecords`. The `pushEdge` /
`pushEdgeFromRecord` divergence is gone — only `pushCallEdge`
(`:142-163`) remains, using the shared
`appendEdge` / `MutableStats.apply`. Two tests still call
`resolveEdges` directly (`__tests__/inventory-property-tests.test.ts:31`,
`__tests__/acceptance/_fixture-runner.ts:13`); the wrapper preserves
the contract.

### F-4 — TypeScript adapter subdir layout — **CLOSED** (refinement)

`edges.ts` shed its second resolver entry and the `walkFileForEdges`
fallback; the deep-TS / flat-Python / flat-Rust asymmetry now mirrors
the per-adapter fidelity asymmetry. No action.

### F-5 — Verdict-kind dispatch — **NO CHANGE**

`obtainCatalog` (`cli/orchestrate.ts:355-372`) discriminated-union
dispatch is intact and idiomatic.

### F-6 — `appendEdge` half-extraction — **CLOSED**

`lang-adapter/edge-helpers.ts:23-31,41-74,103-126` exports
`appendEdge`, `MutableStats` (`createMutableStats`), and a generic
`pushCreationEdge<NodeRef, FileRef>`. All three adapters use them:
`lang-typescript/edges.ts:20-25,93,98-106`,
`lang-python/resolve.ts:35-39,63,70`,
`lang-rust/resolve.ts:45-49,80,87`. The per-adapter `tsPosition`,
`pythonPosition`, `rustPosition` callbacks are the parser-specific
bridge the helper was designed for.

### F-7 — `obtainCatalog` mixed concerns — **PARTIALLY CLOSED**

The 320 lines of incremental rebuild moved to `cache/incremental.ts`
(F-9). What remains in `obtainCatalog` (`cli/orchestrate.ts:338-386`)
is ~50 lines and does two of the three prior-flagged jobs:
(1) read+classify the cache, (2) dispatch full vs incremental
rebuild + write. **The C2 plan's secondary recommendation did not
land:** classify-cache was not promoted to its own stage.
`GRAPH_STAGES` (`:87-94`) is unchanged; the `'stage-cached'`
retrofit on parse/walk/resolve (`:358-360`) remains. The "cache
logic isn't truly a pipeline stage" critique is unresolved but
the size pressure is gone.

### F-8 — Heap preflight + pressure monitor — **NO CHANGE**

`runStage` (`:110-133`) still does three concerns; the new
`monitor.setStage(stage)` call (`:117`) is part of the existing
monitor concern, not a fourth.

### F-9 — Incremental rebuild locality — **CLOSED** (`cfdcd73`)

`cache/incremental.ts` (398 lines, `runIncremental`) holds every
helper the prior audit listed: `expandClosureToFixpoint`
(`:168-201`), `expandClosureOnce` (`:203-233`),
`collectHashesFromOccurrences` (`:235-244`), `collectStaleHashes`
(`:246-260`), `groupCachedHashesByFile` (`:262-276`),
`findEdgeDependents` (`:284-299`), `occHasEdgeIntoStale` (`:301-311`),
`mergeOccurrences` (`:319-342`), `pushOccurrence` (`:344-355`),
`mergeResolvedAndCachedEdges` (`:362-398`). The orchestrator
dispatches at `:363-372` through a `StageRunner` callback so
`cache/` never imports from `cli/`; the module is parameterized
over `GraphLanguageAdapter` and never imports a specific lang
pack. **Minor acceptance gap:** the plan asked for incremental
tests to relocate to `cache/incremental.test.ts`; they remain in
`__tests__/cli/orchestrate.test.ts:134`.

### F-10 — Public barrel adapter exports — **DEFERRED** (intentional)

`src/index.ts:11-46` still does not re-export
`GraphLanguageAdapter`, `registerAdapter`, or `pickAdapter`. Per
`docs/architecture/40-the-graph-loop/03-adding-a-language.md` §3.

### F-11 — SARIF reuse from fitness — **NO CHANGE**

`render/sarif.ts:11-19` unchanged; dep-cruiser rule
`graph-may-import-fitness-sarif` still applies.

### F-12 — `_entry-points.ts` location — **DEFERRED**

Still at `rules/_entry-points.ts`. Imported by `orphan-subtree.ts:13`,
`test-only-reachable.ts:10`, `cli/graph.ts:26`.

### F-13 — `functionLikeFromDeclaration` duplication — **CLOSED**

`lang-typescript/edge-helpers/declaration-to-node.ts` (104 lines)
owns the lookup. Five resolver files consume it via `DeclShape`
bitmask: `direct-call.ts:10,22-29,41`,
`property-access.ts:10,22-30,42`, `polymorphic.ts:11,22-31,67`,
`jsx-element.ts:14,26-30,47`, plus `new-expression.ts` which uses
`findCatalogEntry` directly for the constructor case. The bitmask
is a `Record<string, number>` with `as const` (`:25-46`); avoids
`isolatedModules`'s const-enum trap.

## NET-NEW findings (Wave 1–4 introductions)

### N-1 — `tool.ts` looks up by tool id, registers by string key, silently warns on miss

- **Files / code:** `packages/graph/engine/src/tool.ts:39,48-57`;
  cross-reference `packages/core/src/tools/types.ts:117-143`,
  `packages/cli/src/cli-context.ts:84-121`.
- **Pattern / principle:** Strategy / Adapter contract honesty;
  Tell-Don't-Ask.
- **Severity:** P2.
- **Status:** Wave 4 introduced live-view registration. The shape:
  ```ts
  const GRAPH_LIVE_VIEW_KEY = 'graph';
  const graphRenderer = cli.builtinLiveViews.get(graphTool.metadata.id);
  if (graphRenderer) cli.registerLiveView(GRAPH_LIVE_VIEW_KEY, graphRenderer);
  ```
  Two issues. First, the key the tool registers under
  (`GRAPH_LIVE_VIEW_KEY = 'graph'`) is not the same identifier it
  looks up under (`graphTool.metadata.id`, also `'graph'`). Both
  literals live in this file; they're equal today by convention,
  not contract. Second, the tool reaches into `builtinLiveViews` to
  fetch its own renderer and hand it back to the CLI under a key
  the CLI doesn't know about — the CLI already knows
  `graphTool.metadata.id`'s renderer (it put it there). Third, the
  miss path (`:52-57`) downgrades to `cli.logger.warn`, so a
  misconfigured CLI silently produces a tool whose interactive mode
  throws `UnknownLiveViewError` only on first use.
- **Why it matters:** New tools copying graph as a template
  reproduce this shape. If a future tool's preferred live-view key
  diverges from its metadata id, the lookup-by-id-but-register-by-key
  pattern masks the mismatch. The silent warn-on-miss is the bigger
  smell — interactive mode is the default UX path; a missing
  renderer is a configuration error, not a soft warning.
- **Recommendation:** Either (a) collapse the contract — CLI
  auto-registers built-in live views by tool id; the tool's
  `register()` reaches in only for non-default renderers; or
  (b) keep the current shape and add a key-equality assertion:
  ```ts
  if (GRAPH_LIVE_VIEW_KEY !== graphTool.metadata.id) {
    throw new ConfigurationError(
      `live-view key '${GRAPH_LIVE_VIEW_KEY}' must equal tool id '${graphTool.metadata.id}'`,
    );
  }
  ```
  Promote the renderer-missing branch from `warn` to a hard throw
  under option (b).

### N-2 — Truncation constants scattered across four files

- **Files / code:** `lang-adapter/edge-helpers.ts:113` (70/67),
  `lang-typescript/edges.ts:158` (80/77),
  `lang-python/resolve.ts:120` (80/77),
  `lang-rust/resolve.ts:139` (80/77).
- **Pattern / principle:** DRY, contract honesty.
- **Severity:** P3.
- **Status:** The shared `pushCreationEdge` truncates at 70 chars
  (with `[creates] ` prefix — total target ≤80); per-adapter
  call-edge truncation is 80. Correct intent; constants scattered.
  `CallEdge.text` contract (`types.ts:65-66`) is "≤ 80 chars" — a
  producer-side promise enforced by four files with three magic
  numbers.
- **Why it matters:** A new resolver helper added next year will
  pick whichever it sees first; drift between creation-edge and
  call-edge truncation widens silently.
- **Recommendation:** Add a constants block in
  `lang-adapter/edge-helpers.ts`:
  ```ts
  export const CALL_EDGE_TEXT_MAX = 80;
  export const CREATION_EDGE_PREFIX = '[creates] ';
  export const CREATION_EDGE_TEXT_MAX =
    CALL_EDGE_TEXT_MAX - CREATION_EDGE_PREFIX.length;
  ```
  Expose `truncateForCallEdge(text)`; all three adapters route
  through it. Three sites collapse; the contract literally lives
  next to the helper.

### N-3 — `StageRunner`'s stage-name union duplicates `GraphStage`

- **Files / code:** `cache/incremental.ts:53-57,69`,
  `cli/orchestrate.ts:78-94,368-371`.
- **Pattern / principle:** Dependency Inversion / abstraction shape.
- **Severity:** P3.
- **Status:** The C2 extraction had to thread `runStage` as a
  callback so `runIncremental` inherits orchestrator instrumentation
  without importing from `cli/`. The signature is right; the smell
  is that `StageRunner`'s hardcoded `'parse' | 'walk' | 'resolve'`
  union (`:54`) duplicates the orchestrator's `GraphStage` literally,
  scoped to a subset. If a future stage joins the rebuild path,
  the unions drift.
- **Why it matters:** The cache module knows three of six pipeline
  stages by literal-string. Today the relationship is implicit;
  tomorrow's rename lands in two places.
- **Recommendation:** Hoist the stage-name vocabulary to a shared
  module (`pipeline/stages.ts`) that both `cli/orchestrate.ts` and
  `cache/incremental.ts` import. The cache module's `StageRunner`
  becomes:
  ```ts
  export type RebuildStage = Extract<GraphStage, 'parse' | 'walk' | 'resolve'>;
  ```
  One import, type-safe coupling, no cli/cache layering exception.

## MISSED findings (carried through Waves 1–4)

### M-1 — `inventory.ts:buildInventory` duplicates `walk.ts:walkProgram`'s file-walking scaffolding

- **Files / code:** `lang-typescript/inventory.ts:33-143` (155
  lines) vs. `lang-typescript/walk.ts:83-172`. Duplicate fixtures:
  `normalizeForCompare`, `isTestFile`, `isGeneratedFile`, the
  `record` helper, the per-file `try/catch`, the `walk()` /
  `descend()` walker.
- **Pattern / principle:** DRY — symmetric to the original F-3
  critique on the resolver path.
- **Severity:** P2.
- **Status:** Carried through Wave 1–4. Phase 4 of the perf plan
  fused inventory and walk into one AST descent in `walkProgram`,
  but `buildInventory` was kept around "for tests/external callers"
  (mirroring the resolver-side `resolveEdges` retention). F-3
  closed the resolver side by making `resolveEdges` a thin wrapper
  that delegates through `resolveEdgesFromRecords`. The inventory
  side did not get the same treatment: `buildInventory` still rolls
  its own `ts.createProgram`, `normalizeForCompare`, `isTestFile`,
  and `walk()`. The walker omits `callSites` collection but is
  otherwise a parallel copy of `walkFile`. Three test files consume
  `buildInventory` directly:
  `__tests__/inventory-differential.test.ts:22`,
  `__tests__/inventory-property-tests.test.ts:32`,
  `__tests__/inventory-shape-coverage.test.ts:23`.
- **Why it matters:** The `isTestFile` regex at `walk.ts:315` and
  the same regex at `inventory.ts:150` are two copies with no
  cross-reference. `lang-typescript/index.ts:88-93`
  `isTypescriptTestFile` (the one wired into `RuleHints.isTestFile`)
  is yet a third version, more permissive (matches `.js`, `.jsx`,
  `_test.ts`). Three test-file predicates at three layer altitudes,
  drifting silently. `RuleHints.isTestFile` is the canonical answer;
  the walk-time and inventory-time duplicates predate that hint and
  never migrated.
- **Recommendation:** Refactor `buildInventory` to delegate to
  `walkProgram`:
  ```ts
  export function buildInventory(input: InventoryInput): InventoryOutput {
    const { project: { program } } = parseProject({ ... });
    const walked = walkProgram({ program, files: input.files,
      projectDirAbs: input.projectDirAbs });
    return { catalog: assembleCatalog({ ... }, walked.functions),
      program, parseErrors: walked.parseErrors };
  }
  ```
  Tests get the production code path; `walkFile` becomes the only
  descend implementation. Then unify all three `isTestFile` shapes
  onto `ruleHints.isTestFile` — the walker passes the predicate
  down through `VisitorContext`.

### M-2 — `dispatchVisitor`'s table predicate mis-cast pattern is uniform but Type-unsafe

- **Files / code:** `lang-typescript/walk.ts:201-209` —
  every `VISITOR_TABLE` entry casts inside its `visit` lambda:
  `(n, c) => visitFunctionDeclaration(n as ts.FunctionDeclaration, c)`.
  Same for `VERDICT_TABLE` in `edges.ts:267-288`.
- **Pattern / principle:** Type safety; the cost of structural
  dispatch.
- **Status:** Minor and inherent to the predicate-table shape.
  Every entry's `predicate` is a `ts.is*` type-guard, and the
  `visit`/`resolve` callback fires only when the guard is true —
  so the cast is always sound. But TypeScript's flow analysis
  doesn't follow the predicate→callback dataflow inside the table
  literal (the predicate and visit are property values at the same
  level, not a `node.kind`-keyed switch). The current `as` casts
  are syntactically the price of this dispatch shape.
- **Why it matters:** It's a known concession with no real downside
  today. The MISSED label is to flag that the F-2 closure traded
  if-ladder polymorphism for table-driven dispatch with sound-but-
  unsound-by-typecheck casts, which is fine — but is worth
  acknowledging in a comment so a future contributor doesn't
  "fix" the casts and break the encapsulation.
- **Recommendation:** Two options. (a) Add a one-line JSDoc note
  to each table comment block: "casts are sound by predicate
  precondition; flow analysis can't see through the predicate→
  callback pairing." (b) Define a generic helper:
  ```ts
  function visitorEntry<N extends ts.Node>(
    predicate: (n: ts.Node) => n is N,
    visit: (n: N, ctx: VisitorContext) => FunctionOccurrence | null,
  ): VisitorEntry { return { predicate, visit: (n, c) => visit(n as N, c) }; }
  ```
  The `n as N` lives in one place; the table site loses the cast.
  Option (b) costs ~10 lines for a real generic, removes the casts
  from 12 entries (visitor + verdict tables), and makes adding a
  new visitor type-safe at the call site. Recommended.

## Non-findings considered and dismissed

- **`cache/incremental.ts` should depend on `cache/` only.** It
  imports `logger` from `@opensip-tools/core` (line 31) and types
  from `lang-adapter/types.ts` and `types.ts` — every other
  symbol stays inside the `cache/` directory. The
  `GraphLanguageAdapter` is a parameter, never an import of a
  specific lang-pack. Dismissed — the layering rule
  `graph-pipeline-no-lang-import` (`.dependency-cruiser.cjs:334-343`)
  covers this and passes.
- **`runStage` accumulating responsibilities.** Three concerns
  (timing, progress, monitor.check + monitor.setStage) is the same
  count as the prior audit; the `setStage` addition is part of the
  monitor concern. Dismissed.
- **`graphTool.metadata` reads version via `readPackageVersion(import.meta.url)`.**
  Uses the kernel helper; correct shape; dismissed.
- **`bootstrap.ts` registers three adapters but is the only file
  outside lang-typescript that imports it.** `bootstrap.ts:21-28`
  is the documented exception in the dep-cruiser rule
  `graph-orchestrate-no-direct-lang-import` (lines 350-368).
  `cli/orchestrate.ts:21` re-imports `'../bootstrap.js'` for its
  side effect (so unit tests that bypass `tool.ts` still get the
  adapters). The double-import is intentional and well-commented;
  dismissed.
- **`pickAdapter` reaches the filesystem (globSync) for tie-breaking.**
  `lang-adapter/registry.ts:97-124` runs `globSync` per adapter
  per `pickAdapter` call; on a multi-language repo this is one
  filesystem walk per registered adapter. Cost is bounded by the
  ignore list (`.venv`, `node_modules`, etc.) and the fact that
  `pickAdapter` runs once per `runGraph` invocation. Worth a
  cache if `--packages` fans out widely (each child invokes
  `pickAdapter` separately), but the prior audit didn't surface
  this and Wave 1–4 didn't change it; deferred to a future audit
  if `--packages` perf becomes a concern.
- **`types.ts:11` re-exports `RuleHints` from `lang-adapter/types.ts`.**
  Sanctioned by the dep-cruiser rule
  `graph-pipeline-no-lang-import` (rules/ may not import from
  `lang-*`); the re-export through `types.ts` is the explicit
  doorway. Documented at `types.ts:1-11`. Dismissed.

## Overall assessment

Waves 1–4 closed the substantive findings on schedule and without
collateral damage. The orchestrator at 388 lines is now an honest
pipeline composer; the cache module owns its 320 lines of fixpoint
reasoning behind `runIncremental(...)`; the shared edge helpers
absorb four sites of formerly-per-adapter duplication; and the
visitor/verdict tables make new-shape dispatch a one-line append.

The three NET-NEW findings are minor: N-1 is a one-line guard or
contract collapse; N-2 is one constants block; N-3 is one
type-level `Extract<>`. The interesting story is the MISSED M-1 —
`buildInventory` is the prior audit's symmetric blind spot to F-3:
both the resolver path and the inventory path were retained "for
tests/external callers"; only the resolver got the unification.
M-2 is a small type-safety concession that comes with the F-2
pattern; a 10-line generic helper closes it.

Layering remains exemplary. Nine dep-cruiser rules continue to
enforce architectural invariants; the new `cache/incremental.ts`
slots into the existing `graph-pipeline-no-lang-import` umbrella
without a special exception. Remaining deferrals (F-7 stage
promotion, F-10 third-party adapter public surface, F-12
`_entry-points` move) are deliberate-scope calls, not technical
debt.
