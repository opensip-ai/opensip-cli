# Architecture audit — graph

**Date:** 2026-05-27
**Scope:** packages/graph/engine, packages/graph/graph-typescript, graph-python, graph-rust, graph-go, graph-java
**Auditor:** Claude

## Summary

The graph namespace has a well-shaped façade. `GraphLanguageAdapter` is a clean Strategy contract, six methods, opaque parsed-project type, with documented invariants. The engine's orchestrator is straight-line code over that contract, the rule registry is a plain array (intentional, not over-engineered), and edge truncation / mutable-stats helpers were correctly extracted into `lang-adapter/edge-helpers.ts` after the duplicated-function-body rule itself flagged the duplication.

That said, the audit surfaces one significant correctness bug, several substantial DRY violations across the four tree-sitter adapters, a leaky-abstraction problem at the `CallSiteRecord` boundary, and a layer violation on the SARIF path. The correctness bug (F1) is the headline: the orchestrator never threads `RuleHints` into rule evaluation, so every non-TypeScript adapter silently degrades to TypeScript-shaped regex fallbacks for `no-side-effect-path` and `always-throws-branch` even though each adapter carefully populates its hints. Several places where polymorphism is the right answer use repeated `if`-ladder dispatch instead.

The Strategy pattern is the dominant pattern here; opportunities exist to apply Template Method (parse), extract a shared `TreeSitterAdapterBase` (parse + comment-strip skeleton), and extract a `ResolveByName` strategy (the name-index + 0/1/N confidence ladder).

## Findings

### F1 — Orchestrator never threads `RuleHints` into rule evaluation

- **Files:** `packages/graph/engine/src/cli/orchestrate.ts:189-201`, `packages/graph/engine/src/types.ts:224-234`, `packages/graph/engine/src/rules/no-side-effect-path.ts:71`, `packages/graph/engine/src/rules/always-throws-branch.ts:35-36`
- **Principle/Pattern:** Strategy (contract); Open-Closed; correctness
- **Status:** Problematic
- **Evidence:**
  ```
  // orchestrate.ts:189-201
  const signals: Signal[] = runStage(
    'rules', input.onProgress, monitor,
    () => {
      const collected: Signal[] = [];
      for (const rule of ruleSet) {
        const out = rule.evaluate(catalog, indexes, config);  // ← no hints
        collected.push(...out);
      }
      return collected;
    },
    ...
  );
  ```
  Rule signature (`types.ts:228`) is `evaluate(catalog, indexes, config, hints?)`. Adapter packs (`graph-python/src/rule-hints.ts`, `graph-rust/src/rule-hints.ts`, `graph-go/src/rule-hints.ts`) populate `sideEffectPrimitives`, `throwSyntaxRegex`, `generatedFilePatterns`, `isTestFile`. None of those reach the rule. `no-side-effect-path.ts:50` and `always-throws-branch.ts:36` both fall back to TypeScript-shaped regex (`/console|logger|fs\.|fetch|process\.exit|throw\s+new/` and `/^\s*throw\s+(?:new\s+)?[A-Z]\w*/`) whenever `hints` is undefined — which is always, in production.
- **Why it matters:** The whole adapter contract advertises `ruleHints` as the cross-language fidelity mechanism (`types.ts:135-144`, plan doc cited from `02-rules-and-gating.md`). Without threading, Python projects get TypeScript heuristics for "is this a side-effecting call" and "is this a throw" — silently wrong findings on language A while pretending to support language B. This invalidates a core advertised contract invariant and would be very hard to detect because the rule fires "something." The fallback comments even say "the rule keeps firing on the language it was originally authored for" — that's a bug, not a graceful degradation.
- **Recommendation:** Pass `adapter.ruleHints` down through `runGraph` to the rule loop. In `runGraph`, capture `adapter` from `pickAdapter`, pull `ruleHints`, and pass it as the fourth arg: `rule.evaluate(catalog, indexes, config, adapter.ruleHints)`. Add a `graph-catalog-drift` style invariant test that asserts every rule supporting hints receives them in the orchestrator path (the test file `graph-catalog-drift.test.ts` is a good location).

### F2 — Massive duplication across four tree-sitter `parseProject` implementations

- **Files:** `packages/graph/graph-python/src/parse.ts`, `packages/graph/graph-rust/src/parse.ts`, `packages/graph/graph-go/src/parse.ts`, `packages/graph/graph-java/src/parse.ts`
- **Principle/Pattern:** DRY; Template Method; SRP
- **Status:** Problematic
- **Evidence:** All four files are ~88 lines and structurally identical: same `ParsedFile { tree, source }` shape, same `Map<absolute, ParsedFile>` project shape, same read-then-parse loop, same `hasError` ParseError emission, same `as unknown as Parser.Language` cast, same log event shape (only the `module` string differs). Compare `graph-python/src/parse.ts:37-90` to `graph-rust/src/parse.ts:34-87` to `graph-go/src/parse.ts:34-87` to `graph-java/src/parse.ts:33-83` — diff is the language module import, the module log string, and the type name.
- **Why it matters:** Every new tree-sitter language adapter copies ~90 lines of boilerplate. Changes to parse-error handling (e.g., capturing error positions, batching warnings) require touching N files. Fixing a memory leak in tree-sitter parser instances would require coordinated changes across every adapter pack. The duplication is exactly the duplicated-function-body rule's target — yet the rule's own pack ships a counter-example.
- **Recommendation:** Extract `createTreeSitterParser<P>(language: Parser.Language, module: string)` into a small shared utility, either inside the engine's `lang-adapter/` (sibling to `edge-helpers.ts`) or a new tiny `@opensip-tools/graph-tree-sitter-shared` package. Each adapter then calls `createTreeSitterParser(Python, 'graph:parse:python')` and exports a `ParsedFile`/`ParsedProject` alias. ~350 lines collapse to ~30.

### F3 — Massive duplication across `resolveCallSites` implementations (name-based resolution ladder)

- **Files:** `packages/graph/graph-python/src/resolve.ts`, `packages/graph/graph-go/src/resolve.ts`, `packages/graph/graph-java/src/resolve.ts`, `packages/graph/graph-rust/src/resolve.ts`
- **Principle/Pattern:** DRY; Strategy / Template Method; SRP
- **Status:** Problematic
- **Evidence:** Compare:
  - Python `buildPythonCallEdge` (`graph-python/src/resolve.ts:145-161`), Go `buildGoCallEdge` (`graph-go/src/resolve.ts:135-151`), Java `buildJavaCallEdge` (`graph-java/src/resolve.ts:135-151`): byte-identical 0/1/N confidence ladder.
  - `buildNameIndex` (Python `:98-112`, Go `:90-102`, Java `:90-102`): structurally identical — same `name.startsWith('<')` skip, same per-occurrence push.
  - `pushCallEdge` (Python `:114-136`, Go `:104-126`, Java `:104-126`): same shape: bump totalCallSites, extract target, build edge, apply stats.
  - `isReturnValueDiscarded` (Python `:185-195`, Go `:177-192`, Java `:199-210`): same parent-walk pattern; only the terminal node-type list differs (Python: `expression_statement`; Go: `expression_statement | go_statement | defer_statement`; Java: `expression_statement`).
  - The "creation kind dispatcher head" (Python `:70-79`, Go `:67-76`, Java `:67-76`): identical.
- **Why it matters:** The name-based resolver is a Strategy whose only language-specific behavior is the `extractCallTargetName` AST decoder. Today every adapter duplicates the orchestration (the iteration, the index, the ladder, the stats, the creation-edge passthrough) just to call its own one-function decoder. This is the textbook Template-Method scenario.
- **Recommendation:** Extract a `nameResolveCallSites<F, P>` helper into `graph-engine` (or a `graph-tree-sitter-shared` companion) that takes a small strategy object:
  ```ts
  interface NameResolverStrategy<F> {
    moduleTag: string;                       // 'graph:edges:python'
    position(node, file): EdgePosition;
    extractTargetName(node): string | null;  // per-language only piece
    isReturnDiscarded(node): boolean;        // per-language only piece
  }
  ```
  Python/Go/Java collapse to ~40 lines each (just the AST decoder); Rust remains custom because of its impl-block receiver narrowing, but even Rust's `pushCallEdge` could share the orchestration if `extractTargetName` returns a richer `CallTarget` shape.

### F4 — `CallSiteRecord.nodeRef`/`sourceFileRef` is a leaky abstraction enforced by `unknown` + per-adapter cast

- **Files:** `packages/graph/engine/src/lang-adapter/types.ts:91-103`, `packages/graph/graph-typescript/src/index.ts:107-134`, `packages/graph/graph-python/src/resolve.ts:71-72`, `packages/graph/graph-rust/src/resolve.ts:88-89`, `packages/graph/graph-go/src/resolve.ts:68-69`, `packages/graph/graph-java/src/resolve.ts:68-69`
- **Principle/Pattern:** Strategy contract / type safety; Interface Segregation
- **Status:** Problematic
- **Evidence:** `CallSiteRecord` declares `nodeRef: unknown; sourceFileRef: unknown;` so the engine doesn't introspect them. But TypeScript packs translate twice: walk emits an internal record (`graph-typescript/src/walk.ts:49-70`) with `{ node: ts.Node, sourceFile: ts.SourceFile }`, then `walkProjectAdapter` re-shapes it into `{ nodeRef, sourceFileRef }` (`graph-typescript/src/index.ts:109-115`), then `resolveCallSitesAdapter` casts them back (`:128-134`). Each tree-sitter adapter casts at the top of its resolve loop: `r.nodeRef as Parser.SyntaxNode; r.sourceFileRef as <Lang>ParsedFile`. The `unknown` type is asserting "I trust the caller" — but the caller is the same package, which means the contract is paying no safety dividend for the boilerplate.
- **Why it matters:** Every adapter has an ad-hoc unsafe cast at the I/O boundary. A future contract change (say, adding a `nodeKind: string` field) would need to be re-synthesized in every walk + un-synthesized in every resolve. The generic parameter `P` on `GraphLanguageAdapter<P>` already threads parsed-project through walk → resolve; the same generic could carry per-adapter `Node` and `File` types if `CallSiteRecord` were generic.
- **Recommendation:** Parameterize the record: `CallSiteRecord<N = unknown, F = unknown>` and surface it on the adapter as `GraphLanguageAdapter<P, N = unknown, F = unknown>`. The engine still consumes `CallSiteRecord<unknown, unknown>` through the contract, but each adapter declares its concrete types and the casts disappear. Migration is mechanical and additive — the unknown defaults preserve today's contract.

### F5 — `pickAdapter` glob-scans the project on every call

- **Files:** `packages/graph/engine/src/lang-adapter/registry.ts:89-116`, `packages/graph/engine/src/cli/heap-preflight.ts:94-105`, `packages/graph/engine/src/cli/orchestrate.ts:161`
- **Principle/Pattern:** Single Responsibility; performance / SRP
- **Status:** Problematic
- **Evidence:** `pickAdapter` runs a `globSync('**/*.{ext}', { cwd })` per registered extension whenever it's called (registry.ts:103-110). The preflight calls `pickAdapter` and then `discoverFiles` (heap-preflight.ts:100-104); the orchestrator independently calls `pickAdapter` again (orchestrate.ts:161). On a large repo with three registered adapters that's six full-tree glob walks plus `discoverFiles`'s own walk — for the same answer. Worse, the orchestrator and preflight may disagree if the file set changed mid-run (unlikely but undefined).
- **Why it matters:** Heuristic adapter selection is one of those things that "feels free" but isn't — it duplicates work `discoverFiles` already does once. And it's the dominant per-invocation cost on a cold start.
- **Recommendation:** Memoize per (cwd, registered-adapter-set) inside the registry, or have the CLI pick the adapter once at bootstrap and pass it down. Better still, plumb a `--language` CLI flag (the comment at `registry.ts:43` already says this is the long-term answer) and skip the heuristic when the user has been explicit.

### F6 — SARIF render imports across the peer-layer line into `@opensip-tools/fitness`

- **Files:** `packages/graph/engine/src/render/sarif.ts:11-19`
- **Principle/Pattern:** Dependency direction / layering; SRP
- **Status:** Problematic
- **Evidence:** `import { buildSarifLog } from '@opensip-tools/fitness';` and `export { reportToCloud } from '@opensip-tools/fitness';`. The file acknowledges this is a documented exception (line 7) and the dep-cruiser config presumably allowlists it. Per the repo's CLAUDE.md: "fitness / simulation must NOT import from cli (would create a cycle)" — graph importing from fitness isn't outright forbidden but creates a tight peer-to-peer coupling that the project plan-of-record calls out for a future `@opensip-tools/sarif` extraction.
- **Why it matters:** SARIF is a generic output format, not a fitness concept. The cross-peer import means graph can't be packaged without fitness, even though graph has no logical dependency on the fitness engine. It also means a fitness API change can ripple through to graph's render path.
- **Recommendation:** Make the planned extraction concrete: pull `buildSarifLog` and `reportToCloud` from `packages/fitness/engine` into a new `packages/sarif` (or back-port into `packages/contracts` since both fitness and graph consume `CliOutput` from contracts). The current `sarif.ts` file already explicitly says "the wrapper exists so the future @opensip-tools/sarif extraction is mechanical" — this is the time.

### F7 — Datastore is `unknown` at the CliContext boundary and cast inline at every consumer

- **Files:** `packages/graph/engine/src/cli/graph.ts:132,159,534`, `packages/graph/engine/src/tool.ts:90,207`
- **Principle/Pattern:** Interface Segregation; type safety
- **Status:** Problematic
- **Evidence:** Five separate `cli.datastore as DataStore` (and `... | undefined`) casts: `graph.ts:132`, `graph.ts:159`, `graph.ts:534`, `tool.ts:90`, `tool.ts:207`. The `ToolCliContext` interface (from `@opensip-tools/core`) presumably types `datastore` as `unknown` to avoid forcing core to know about `@opensip-tools/datastore`.
- **Why it matters:** Every tool that uses the datastore reproduces the cast. The cast asserts a runtime invariant ("the CLI wired us a real DataStore") that's never validated. A future kind-mismatch (e.g., wrapping the datastore with a tracing decorator that drops a method) will be discovered at runtime, not at compile time.
- **Recommendation:** Either (a) generic `ToolCliContext<TDataStore = unknown>` in core so each tool can narrow at registration, or (b) make the cast a single helper inside the graph package — `requireDataStore(cli): DataStore` — that runtime-validates once and throws a `ConfigurationError` if missing. (a) is cleaner; (b) is a quick local win.

### F8 — `isReturnValueDiscarded` is a per-adapter "what makes a call discard its return" check duplicated four times

- **Files:** `packages/graph/graph-python/src/resolve.ts:185-195`, `packages/graph/graph-go/src/resolve.ts:177-192`, `packages/graph/graph-rust/src/resolve.ts:280-290`, `packages/graph/graph-java/src/resolve.ts:199-210`
- **Principle/Pattern:** DRY; Strategy
- **Status:** Problematic
- **Evidence:** Identical control-flow pattern in each adapter: walk parent chain, skip parenthesized wrappers, then test against a per-language node-type set. The only language-specific data is the terminal node-type tuple — `expression_statement` everywhere, plus Go adds `go_statement` and `defer_statement`. The tree-sitter "skip parenthesized_expression" is universal; Python also skips `await`.
- **Why it matters:** This logic is what populates `CallEdge.discarded`, which `no-side-effect-path` keys on. A change to the predicate (e.g., new tree-sitter version renames `parenthesized_expression`) needs to be made in all four files.
- **Recommendation:** A small shared helper:
  ```ts
  function isDiscardedAt(node, opts: { skip: ReadonlySet<string>; terminals: ReadonlySet<string> }): boolean;
  ```
  with each adapter passing its node-type sets. Or fold it into the `NameResolverStrategy` from F3.

### F9 — `cacheKey` boilerplate duplicated across four non-TypeScript adapters

- **Files:** `packages/graph/graph-rust/src/cache-key.ts`, `packages/graph/graph-go/src/cache-key.ts`, `packages/graph/graph-java/src/cache-key.ts`, `packages/graph/graph-python/src/cache-key.ts`
- **Principle/Pattern:** DRY
- **Status:** Problematic
- **Evidence:** Rust, Go, and Java cache-keys are functionally identical (`hashConfig` is byte-identical except for the missing/unreadable prefix strings — all read the file, sha256, slice 16 chars). Python adds the `requires-python` extraction but the post-hash logic is the same.
- **Why it matters:** Adding the next adapter (Swift, Kotlin, etc.) means copy-pasting the same 16-line file. Trivial individually, but representative of the pattern across this namespace.
- **Recommendation:** Extract `hashConfigFile(path?: string): string` as a shared helper (in `lang-adapter/`). Each adapter becomes:
  ```ts
  export const cacheKey = (i: CacheKeyInput): string => `rs-${hashConfigFile(i.configPathAbs)}`;
  ```
  Python keeps its own `readConfig` for the version extraction but uses the helper for the hash portion.

### F10 — `MutableStats.apply` mutates `this`; consumers can also mutate `totalCallSites` directly, splitting the invariant

- **Files:** `packages/graph/engine/src/lang-adapter/edge-helpers.ts:95-128`, `packages/graph/graph-python/src/resolve.ts:122,135`, `packages/graph/graph-rust/src/resolve.ts:141,153`
- **Principle/Pattern:** Encapsulation; SRP; invariants
- **Status:** Problematic
- **Evidence:** The interface (`edge-helpers.ts:95-108`) intentionally exposes `totalCallSites`, `resolvedHigh`, etc. as writable so resolvers can bump `totalCallSites` directly (Python `:122`, Rust `:141`) while delegating per-confidence classification to `apply(edge)`. The doc on `apply` (`:101-106`) explicitly says "Does NOT touch totalCallSites — call sites include unresolved-by-shape decisions that don't always produce an edge."
- **Why it matters:** The invariant "totalCallSites === resolvedHigh + resolvedMedium + resolvedLow + unresolved" is implicit and enforced by convention across N adapters. A new resolver author who calls `apply(edge)` without bumping `totalCallSites` will silently undercount; one who bumps `totalCallSites` for unresolved-by-shape decisions without producing an edge will over-count `unresolved` if they later call `apply` on a related edge. The contract isn't expressible in the type.
- **Recommendation:** Provide a single combined entry point: `recordCallSite(edge | null)` that bumps `totalCallSites` and (if non-null) calls the right confidence counter. Adapters that decide "this site has no edge" pass `null`. Keep the individual counters readonly. This collapses the convention into the type.

### F11 — `runGraph` synchronously calls `pickAdapter(input.cwd)` after the orchestrator has already been told which adapter to use via preflight

- **Files:** `packages/graph/engine/src/cli/heap-preflight.ts:100`, `packages/graph/engine/src/cli/orchestrate.ts:161`
- **Principle/Pattern:** Dependency injection; single source of truth
- **Status:** Problematic
- **Evidence:** Both heap preflight and `runGraph` call `pickAdapter` independently. They're guaranteed to agree only by virtue of the registry being process-global and immutable between calls. The heuristic could in principle pick differently between calls (e.g., if the preflight ran with `cwd = repo root`, then `runGraph` is called with `cwd = sub-package`).
- **Why it matters:** Adapter identity is a single decision per run, but it's being made multiple times. The preflight's discovery is used only for file-count, then thrown away; `runGraph` rediscovers the adapter and re-runs discovery. Beyond performance (F5), this is a single-source-of-truth violation: which decision wins if they disagree?
- **Recommendation:** Decide once at the CLI layer. `executeGraph` (`cli/graph.ts`) should call `pickAdapter(opts.cwd)` once, pass the chosen adapter (or its id) into both the heap preflight and `runGraph`. The orchestrator's `RunGraphInput` gains an optional `adapter` override; preflight takes an `adapter` argument instead of looking it up.

### F12 — `obtainCatalog` recomputes `adapter.cacheKey` twice when a rebuild is needed

- **Files:** `packages/graph/engine/src/cli/orchestrate.ts:280-297,343-391`
- **Principle/Pattern:** DRY; performance / SRP
- **Status:** Problematic (minor)
- **Evidence:** `obtainCatalog` calls `cacheKey(...)` at `:346`. If the verdict is `invalid` and we go down the `buildAndResolveCatalog` path, `assembleCatalog` (`:280-297`) calls `cacheKey` again at `:290`. Same input, same output, but `cacheKey` reads the config file from disk every time (cache-key.ts variants `readFileSync` + sha256).
- **Why it matters:** Trivial perf cost on a single run; conceptually it's a sign that catalog assembly knows too much (it knows how to derive the cache key, but the cache key is owned by the verdict-checking pipeline). A future change to the cache-key inputs needs to be made in both places.
- **Recommendation:** Compute `currentCacheKey` once at the top of `obtainCatalog`, pass it as a parameter to `assembleCatalog`. The assemble call already takes the discovery + occurrences — adding a third parameter is straightforward.

### F13 — Incremental rebuild path silently falls back to full rebuild via `verdict.kind !== 'incremental'` but `cachedCatalog` is missing

- **Files:** `packages/graph/engine/src/cli/orchestrate.ts:367-376`
- **Principle/Pattern:** Defensive programming / clarity; null-checks vs branch logic
- **Status:** Problematic (minor)
- **Evidence:** `built = verdict.kind === 'incremental' && cachedCatalog ? buildAndResolveCatalogIncremental(...) : buildAndResolveCatalog(...)`. The `&& cachedCatalog` looks defensive but is dead code: `classifyCatalog` (`cache/invalidate.ts:48-89`) returns `incremental` only after dereferencing `cached.filesFingerprint`, so `cachedCatalog` is provably non-null inside that arm. The two-line ternary obscures that intent.
- **Why it matters:** The reader is forced to reason about whether incremental-with-no-cache is reachable. It isn't, but proving it requires reading another module.
- **Recommendation:** Make the type system carry the invariant — `CatalogVerdict.incremental` could include the cached catalog itself:
  ```ts
  | { kind: 'incremental', changedFiles, cachedCatalog: Catalog }
  ```
  Then the ternary becomes a clean `if (verdict.kind === 'incremental')` and the dead null check is gone.

### F14 — `executeGraph` is a 400-line god function juggling six output modes via flag conditionals

- **Files:** `packages/graph/engine/src/cli/graph.ts:99-233`
- **Principle/Pattern:** SRP; Strategy / Command
- **Status:** Problematic
- **Evidence:** `executeGraph` handles: gate-save, gate-compare, report-to-cloud, json output, table output, packages-fan-out. Each is selected by a chain of `if`s on option flags (`:105-114`, `:134-148`). The branches are mostly disjoint output modes that pre-commit to different terminal behavior (different exit codes, different render targets, different persistence).
- **Why it matters:** Adding a seventh output mode means adding another branch in a function that already does N things. The mutual-exclusion checks (`--gate-save` + `--gate-compare`, `--package` + `--packages`) are scattered inline rather than centralized.
- **Recommendation:** Introduce an `OutputMode` strategy enum and a small dispatch table:
  ```ts
  type OutputMode = 'gate-save' | 'gate-compare' | 'report' | 'json' | 'table' | 'packages';
  const handlers: Record<OutputMode, (opts, result, cli) => Promise<void>> = { ... };
  ```
  A `resolveOutputMode(opts)` function consolidates the conditional logic and rejects illegal combinations once. Each handler is ~20 lines.

### F15 — `inferEntryPoints` takes a `Catalog` parameter it never uses; the contract is misleading

- **Files:** `packages/graph/engine/src/rules/_entry-points.ts:32-43`
- **Principle/Pattern:** Interface Segregation; honest signatures
- **Status:** Problematic (minor)
- **Evidence:** Signature is `(catalog: Catalog, indexes: Indexes)`. Body does `void catalog;` and only consults `indexes`. Comment at `:41` admits this and points at "rules merge it with config.entryPointHashes."
- **Why it matters:** Two consumers (`orphan-subtree.ts:57`, `test-only-reachable.ts:61`, `cli/graph.ts:422`) pass both arguments. Anyone reading the signature has to guess which is load-bearing. Future refactors might add behavior that uses `catalog` based on a misreading of the contract.
- **Recommendation:** Drop the parameter, or replace the `void catalog;` with an actual use (e.g., consulting `catalog.functions` to honor decorator-based entry-point heuristics — the v0.3 doc-comment hints at this). If the param is truly future-reserved, document that explicitly.

### F16 — `noSideEffectPathRule.computeSideEffecting` is O(occurrences × calls) per invocation

- **Files:** `packages/graph/engine/src/rules/no-side-effect-path.ts:157-176`
- **Principle/Pattern:** Performance / appropriate caching
- **Status:** Problematic (minor)
- **Evidence:** For every occurrence, `textualSideEffect` iterates the edges and tests each against the detector. The detector itself iterates the primitive list per edge text (line 60-65). So the rule is O(N occurrences × E edges × P primitives). Building a single regex once from the primitives (joined with `|`, escaped) would collapse the inner loop to O(1) per edge.
- **Why it matters:** With ~20 primitives × thousands of edges × thousands of occurrences, this is the rule that's most likely to show up in profiling. The cost is hidden by being called once per rule, but it scales with project size.
- **Recommendation:** When `sideEffectPrimitives` is supplied, build a single anchored alternation regex once at `buildSideEffectDetector` time. Fall back to substring test only when the primitive list contains regex metacharacters (currently none do).

### F17 — TypeScript adapter's `index.ts` re-translates `CallSiteRecord` between two structurally identical shapes

- **Files:** `packages/graph/graph-typescript/src/index.ts:100-145`, `packages/graph/graph-typescript/src/walk.ts:49-70`
- **Principle/Pattern:** YAGNI; DRY
- **Status:** Problematic
- **Evidence:** `walkProgram` emits `CallSiteRecord { node, sourceFile, ownerHash, kind, childHash? }`. The contract requires `CallSiteRecord { nodeRef, sourceFileRef, ownerHash, kind, childHash? }`. The adapter façade re-maps `node → nodeRef` and `sourceFile → sourceFileRef` on every record (`index.ts:109-115`), then re-maps in the opposite direction at the start of `resolveCallSitesAdapter` (`:128-134`). This is pure boilerplate.
- **Why it matters:** Hot-path copy (every call site, every run) for a rename. It also splits the type definition — the TS adapter has its own `CallSiteRecord` (`walk.ts:49-70`) and the engine has another. The duplication compounds F4.
- **Recommendation:** Have `walkProgram` emit the contract's record shape directly. Drop the second `CallSiteRecord` type. The fix is mechanical, dependent on F4 being addressed first (so the casts go away).

### F18 — Two `discoverFiles` parameter-name conventions: `projectDir`/`tsConfigPath` vs `cwd`/`configPathOverride`

- **Files:** `packages/graph/graph-typescript/src/index.ts:87-98`, `packages/graph/graph-typescript/src/discover.ts` (legacy signature)
- **Principle/Pattern:** Consistency; Interface Segregation
- **Status:** Problematic (minor)
- **Evidence:** The contract defines `DiscoverInput { cwd, configPathOverride }`. The TS adapter's legacy `discoverFiles` (`discover.ts`) takes `{ projectDir, tsConfigPath }`. The adapter façade renames at the boundary (`index.ts:88-91`). The contract names are correct (a project root is conceptually a cwd if you `cd` into it before running; the override is exactly that — an override of the default lookup). The legacy names are a holdover.
- **Why it matters:** Anyone reading either side has to translate. Future changes to the parameter set need to be made in both places.
- **Recommendation:** Rename the legacy `discoverFiles` parameters to match the contract. The function is internal to the TS adapter; the rename is mechanical.

## Strengths

- **The `GraphLanguageAdapter` contract is well-designed.** Six methods, opaque `P` for parsed-project, clear invariants documented as I-1 through I-9, generic over the parsed-project type so consumers can narrow. The shape is the right Strategy for the problem.
- **Edge-text truncation constants and `MutableStats` consolidation in `lang-adapter/edge-helpers.ts`** are correct: the team noticed N×duplication, the duplicated-function-body rule flagged it, the fix lifted shared truncation/append/creation-edge logic to the contract layer. Good DRY discipline visible in the code history.
- **`runStage` wrapper in orchestrate.ts** (`:123-146`) is a clean small helper that uniformly threads progress events, pressure-monitor checks, and timing across every stage. This is the right level of abstraction.
- **`createPressureMonitor`** uses a `dispose`-style return and `unref()`s its timer (`pressure-monitor.ts:69-117`). Solid resource management.
- **Heap preflight sentinel** (`OPENSIP_HEAP_ELEVATED`) is the correct way to handle V8's startup-only heap cap; the policy table (`HEAP_TARGETS`) is data-driven and easy to tune.
- **Adapter symmetry across languages** for the six-method skeleton (every adapter has `discover.ts`, `parse.ts`, `walk.ts`, `resolve.ts`, `cache-key.ts`, `rule-hints.ts`) makes the codebase navigable. The duplication problems (F2/F3/F8/F9) are precisely because the file *shapes* are consistent — a good problem to have.
- **Catalog-cache verdict pattern** (`CatalogVerdict = valid | incremental | invalid`) is a clean tagged-union Strategy that drives the orchestrator's branching cleanly. (See F13 for a refinement.)
- **Rule registry as a plain array** (`rules/registry.ts:18-25`) is correct simplicity — the team explicitly chose this over a singleton (PR-6 / DEC-6) for v0.2. No pattern over-application.
- **Plugin discovery for adapter packs** (`graph-adapter-discovery.ts`) is a documented three-rule resolution (explicit → opt-out → auto-discover) that mirrors the fitness pack walker. Symmetry across the codebase reduces cognitive load.

## Notes

- The audit window is the graph namespace only; cross-namespace concerns (e.g., F6's SARIF dependency on `@opensip-tools/fitness`) are surfaced but their fix lives outside this scope.
- F1 is treated as the headline because it's a correctness bug visible in production output; F2/F3 are treated as substantial because together they amount to roughly 500 lines of mechanical duplication across the tree-sitter adapter packs.
- The Rust adapter's resolve.ts deliberately diverges (impl-block receiver narrowing) and that divergence is correct — it's a legitimate Strategy variation, not duplication-creep. The F3 recommendation explicitly preserves Rust's custom path.
- Three of the rule modules (`always-throws-branch`, `no-side-effect-path`, `duplicated-function-body`) explicitly take `hints` as the fourth parameter and document the TS-shaped fallback — F1's fix should land before adding any more hint-consuming rules so the contract is exercised end-to-end.
- The audit did not deeply review test files; spot checks suggest test coverage is high (each adapter has discover/parse/walk/resolve/cache-key tests), and `lang-adapter-contract.test.ts` exists in `graph-typescript` — a good sign that contract conformance is enforced. Whether other adapters have equivalent contract tests is worth a follow-up.
