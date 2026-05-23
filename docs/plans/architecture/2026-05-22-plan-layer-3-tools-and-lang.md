---
status: current
last_verified: 2026-05-22
title: "Layer 3 (tools + lang adapters) — remediation plan"
audience: [contributors, architects]
related-audits:
  - ./2026-05-22-architecture-fitness.md
  - ./2026-05-22-architecture-simulation.md
  - ./2026-05-22-architecture-graph.md
  - ./2026-05-22-architecture-lang-typescript.md
  - ./2026-05-22-architecture-lang-rust.md
  - ./2026-05-22-architecture-lang-python.md
  - ./2026-05-22-architecture-lang-java.md
  - ./2026-05-22-architecture-lang-go.md
  - ./2026-05-22-architecture-lang-cpp.md
related-plans:
  - ./2026-05-22-plan-layer-1-core.md
---
# Layer 3 (tools + lang adapters) — remediation plan

## Summary

Layer 3 hosts nine packages: three tool engines (`@opensip-tools/fitness`,
`@opensip-tools/simulation`, `@opensip-tools/graph`) and six language
adapters (`lang-typescript`, `lang-rust`, `lang-python`, `lang-java`,
`lang-go`, `lang-cpp`). Across all nine, the audit surfaces 78 findings.
The architectural shapes are largely sound — Adapter, Registry, Strategy,
Pipeline and Template Method are all used correctly in the right places —
but the layer carries four real correctness bugs in the lang-pack
lexers (Java text-block escapes, Python raw-string quote escapes,
unbounded char-literal scans in Java/Go, lang-cpp aliases that pass
validation but fail scope matching), one significant promise-versus-
implementation gap in graph (`RuleHints` declared on every adapter,
consumed by zero rules), and three large
single-responsibility violations (`executeFit`'s 612-line action
handler, the orchestrator's 320-line incremental-rebuild stuffed inside
`obtainCatalog`, the parallel-vs-sequential per-check lifecycle copied
twice in fitness's recipe service).

The largest sources of accumulated drift are the C-family lexer
duplication across four packs (`lang-java`/`lang-go`/`lang-cpp`/partial
`lang-rust`) and the half-extracted `appendEdge` abstraction in graph
(used by tree-sitter adapters, not by the TypeScript adapter). Both are
addressable once Layer 1 (`core`) gains the right shared primitives.
Several low-leverage findings are deliberately deferred — chaos-as-load-
composition rework, fitness's recipe-config-via-globalThis migration, and
the graph third-party-adapter public surface — because they require
contract decisions that should land deliberately, not opportunistically.

## Sequencing rationale

The layer is sequenced **correctness first, then refactor, then
consistency**.

Group A (P0) closes the four lang-pack correctness bugs and the graph
`RuleHints` disconnect. These are real defects that produce wrong
results today: a Java text block containing `\"""` is silently
mis-tokenized; a Python `r"\""` raw string mis-terminates; a
`languages: ['c']` scope in `opensip-tools.config.yml` matches no
checks even though validation accepts it; a `no-side-effect-path` rule
running on Python source uses a TypeScript-biased regex because the
adapter's `sideEffectPrimitives` hint is dropped on the floor. None of
these blocks compilation, none surface as crashes, all land as
silently-wrong analysis output. They go first.

Group B is the C-family lexer consolidation. It depends on Layer 1
extracting `scanLineComment` and `scanBlockCommentNonNesting` into
`core/src/languages/strip-utils.ts`. Once those land, four packs adopt
them in a single coordinated phase.

Group C tackles the graph engine's three architectural levers in the
order they enable each other: wire `RuleHints` (also Group A's F-1
fix), then deduplicate `resolveEdges` / `resolveCallSites`, then
extract `cache/incremental.ts` from the orchestrator. Each makes the
next smaller.

Group D is fitness's largest single-responsibility cleanup
(`executeFit`, parallel/sequential lifecycle dedup, content-filter
relocation, severity-mapping table) plus the SARIF-builder typing.
These don't change behavior; they make the package contributor-
tractable.

Group E reconciles simulation's two metric-key resolvers (a divergence
that produces different assertion results depending on which path
runs), extracts `runWindow`, and consolidates the per-kind validation
boilerplate.

Cross-cutting consistency work (registry promotion to core, MVP
text-tree shared interface, barrel-surface trimming) is folded into
Group B and the deferred section.

## Group A — Lang-pack and graph correctness fixes (P0)

These are real bugs, ordered by user-visible impact.

### Phase A1 — Fix lang-pack lexer correctness bugs ✅ partially closed by Wave 1

**Status:** Mostly shipped in Wave 1 — see commits `4254e72`
(lang-java text-block escape, char-literal bound, branch-order
comment), `b900843` (lang-python raw-string escape, empty-triple
disambiguation pin), `d92bbb7` (lang-cpp `u8` prefix, char-literal
bound, line continuation), `e6eb358` (lang-go regression tests for
raw strings, unterminated literals, runes). Open items remaining
under this phase: lang-python F4 (single-string newline-as-terminator
test pin — minor) and lang-go F1/F3 (parse.ts `null`-return type
honesty, also tracked under Phase B1 / Layer 1 Phase 3). See the
consistency pass (`./2026-05-22-plan-consistency-pass.md`)
Conflict 7 for the full table.

**Goal:** Close the four lang-pack lexer correctness bugs that
silently produce wrong tokenization on conforming source.

**Closes findings:** lang-java F1 (text-block escape), lang-java F2
(unbounded char-literal scan), lang-python F1 (raw-string quote
escape), lang-go F4 (rune-literal permissiveness — regression test
only), lang-cpp F4 (`u8'` opener missing, unbounded char scan).

**Files touched:**
- `packages/languages/lang-java/src/strip.ts` — text-block scanner
  (lines 60–88), char-literal scanner (lines 99–126).
- `packages/languages/lang-python/src/strip.ts` — `scanSingleString`
  (lines 127–156), `scanTripleString` (lines 102–125).
- `packages/languages/lang-go/src/strip.ts` — rune-literal scanner
  (lines 73–96): regression test only, no source change.
- `packages/languages/lang-cpp/src/strip.ts` — char-literal opener
  set (lines 98–117), maxScan bound.
- Test files: `__tests__/strip.test.ts` for each pack.

**Steps:**
1. Lang-java text-block escape (F1): track an `escape` flag in the
   text-block body scan, mirroring the regular-string scanner. Add
   tests for `"""\n a \\\" \"\"\" """` and `"""\n \\\\ """`.
2. Lang-java char-literal bound (F2): cap the scan at
   `Math.min(i + 8, len)` matching lang-cpp/lang-rust. On overflow,
   advance `i` by one and treat the apostrophe as code.
3. Lang-python raw-string quote escape (F1): in `scanSingleString` and
   `scanTripleString`, when `isRaw === true`, advance `i += 2` for
   `\"`, `\'`, and `\\` (do not turn this into a full escape parser —
   the existing 2-char skip is sufficient). Add regression tests for
   `r'\\\''` and the triple-raw analogue. Also add tests called out
   in lang-python F2 (empty triple `""""""`, paired empty `"" ""`)
   and F4 (line continuation, unterminated single string).
4. Lang-go rune-literal regression test (F4): add a test that
   `'abc' // comment` does not have its `'…'` mis-treated as a single
   rune span. No source change required today; the test pins behavior
   for finding 2's future extraction.
5. Lang-cpp char-literal opener (F4): add `u8'` to the char-literal
   opener set; remove the `maxScan` cap and replicate the
   bounded-by-newline pattern from lang-java/lang-go (stop at
   unescaped `'` or unescaped `\n`).

**Acceptance:**
- Each pack's `strip.test.ts` includes the new regression cases and
  passes.
- `pnpm --filter=@opensip-tools/lang-java test`,
  `pnpm --filter=@opensip-tools/lang-python test`,
  `pnpm --filter=@opensip-tools/lang-go test`,
  `pnpm --filter=@opensip-tools/lang-cpp test` all green.
- Length-preservation invariant (`out.length === src.length`) still
  holds for every test in each pack.

### Phase A2 — Fix lang-cpp alias-matching trap

**Goal:** Close the architectural trap where `aliases: ['c', 'c++']`
passes config validation but never matches scope intersection — a
silent "no checks ran" failure that the user has no way to detect.

**Closes findings:** lang-cpp F1 (aliases-not-matched), with parallel
implications for lang-rust `['rs']` and lang-go `['golang']`.

**Files touched:**
- `packages/core/src/languages/registry.ts` — add a `canonicalize(id)`
  helper that maps any registered alias to the canonical adapter id.
- `packages/fitness/engine/src/targets/target-registry.ts` —
  `findByScope` (lines 80–99) routes `target.config.languages` and
  `scope.languages` through `canonicalize` before `Array.includes`.
- `packages/fitness/engine/src/framework/define-check.ts` — same
  canonicalization at scope-intake.
- Tests: a fitness recipe-resolution test that asserts a target with
  `languages: ['c']` matches a check with `scope: { languages: ['cpp'] }`,
  and a corresponding test for `['rs']` ↔ `['rust']` and
  `['golang']` ↔ `['go']`.

**Steps:**
1. Add `canonicalize(id: string): string | undefined` on the kernel's
   default language registry. Returns the canonical adapter id for any
   matching alias, `undefined` if nothing matches.
2. Update `findByScope` to canonicalize both sides of the comparison.
3. Update `define-check.ts`'s scope intake to canonicalize on
   declaration so the registry's `byLanguage` indices use canonical
   keys.
4. Add the cross-pack regression tests.

**Acceptance:**
- A target with `languages: ['c']` correctly matches `cpp`-scoped
  checks; same for `rs`/`rust` and `golang`/`go`.
- Existing tests pass unchanged (the canonicalization is a no-op on
  already-canonical inputs).
- No test asserts the previous broken behavior.

### Phase A3 — Wire graph `RuleHints` into rule evaluation ✅ closed by Wave 1

**Status:** Shipped in Wave 1 — commit `8010c2e`. Added an optional
fourth `hints?: RuleHints` parameter to `Rule.evaluate`. Wired
`no-side-effect-path` and `always-throws-branch` to consume the
adapter's hints with TypeScript-shaped fallback. 13 new integration
tests cover Python and Rust fixtures. See the consistency pass
(`./2026-05-22-plan-consistency-pass.md`) Conflict 8.

**Goal:** Close the contract-versus-implementation gap where every
graph adapter declares populated `ruleHints` and zero rules consume
them. Restore the documented per-language fidelity story.

**Closes findings:** graph F-1 (`ruleHints` zero consumers).

**Files touched:**
- `packages/graph/engine/src/rules/types.ts` (or wherever `Rule` is
  defined) — extend `Rule.evaluate` to accept a fourth argument
  (`RuleHints` or a typed projection).
- `packages/graph/engine/src/cli/orchestrate.ts` — `runGraph` passes
  `pickAdapter(cwd).ruleHints ?? {}` into the rule loop.
- `packages/graph/engine/src/rules/no-side-effect-path.ts` — replace
  the hardcoded `SIDE_EFFECT_TEXTUAL` regex with a regex composed
  from the adapter's `sideEffectPrimitives` (with the existing
  hardcoded list as the fallback when hints are absent).
- `packages/graph/engine/src/rules/always-throws-branch.ts` — replace
  the hardcoded `THROW_PATTERN` with `ruleHints.throwSyntaxRegex` when
  available.
- Rules `orphan-subtree.ts` and `test-only-reachable.ts` — wire
  `ruleHints.isTestFile` / `generatedFilePatterns` if either rule
  benefits from them; otherwise document why not.

**Steps:**
1. Extend `Rule.evaluate(catalog, indexes, config, hints)`. Update
   the rule registry's iteration site in `cli/orchestrate.ts` to
   thread the active adapter's hints.
2. Convert `no-side-effect-path` to consume
   `hints.sideEffectPrimitives` (build a regex per-run from the
   string list).
3. Convert `always-throws-branch` to consume `hints.throwSyntaxRegex`.
4. Add regression tests that assert: running on a Python project
   detects `print(` as a side-effect primitive; running on a Rust
   project detects `println!`; running on a TypeScript project still
   matches the existing baseline.

**Acceptance:**
- `pnpm --filter=@opensip-tools/graph test` green.
- A new contract test asserts `Rule.evaluate` receives non-empty
  hints when an adapter populates them.
- Architecture doc in
  `docs/architecture/40-the-graph-loop/02-rules-and-gating.md`
  remains accurate (the promise it makes is now honored, not
  extended).

## Group B — Lang-pack scaffolding consolidation

### Phase B1 — Adopt core's extracted C-family scanners

**Depends on:** Layer 1 plan extraction of `scanLineComment` and
`scanBlockCommentNonNesting` into
`packages/core/src/languages/strip-utils.ts`. **Do not duplicate that
work here** — this phase consumes the helpers Layer 1 ships.

**Goal:** Eliminate the byte-identical line-comment and non-nesting
block-comment scanners across `lang-java`, `lang-go`, `lang-cpp`. Drop
lang-rust's privately-duplicated `scanRegularString`. Drop the matching
`sonarjs/cognitive-complexity` suppressions where they cease to be
needed.

**Closes findings:** lang-cpp F4 (scanner duplication across
lang-cpp/lang-java/lang-go), lang-java F3 (lexer scaffolding
duplication across four packs), lang-go F2 (cross-pack scanner
scaffold duplicated four times), lang-rust F1 (privately-duplicated
`scanRegularString`), lang-rust F6 (cognitive-complexity suppression
that becomes unnecessary), lang-go F6 (`parse.ts` and `adapter.ts`
carry zero language-specific information — paired here for the
text-tree consolidation), lang-rust F4 (`RustTree` shape duplicates an
unwritten `MinimalTextTree` core type).

**Files touched:**
- `packages/languages/lang-java/src/strip.ts` — replace inline
  line-comment / non-nesting block-comment scans with calls to the
  Layer-1-extracted helpers.
- `packages/languages/lang-go/src/strip.ts` — same.
- `packages/languages/lang-cpp/src/strip.ts` — same.
- `packages/languages/lang-rust/src/strip.ts` — drop the local
  `scanRegularString` (lines 170–198) and import the core helper.
  This requires Layer 1 to ship `scanRegularString` with an
  `{ allowMultiline?: boolean }` option (already noted in lang-rust
  F1 recommendation; flag for Layer 1 if not already specified).
- `packages/core/src/languages/text-tree.ts` (new) or extend
  `strip-utils.ts` — add a shared `MinimalTextTree` interface
  (`{ source; filePath; lineStarts }`) and a `buildMinimalTextTree`
  factory. Each MVP pack's `parse.ts` becomes a one-line wrapper
  branding the result as its named type alias (`GoTree`, `JavaTree`,
  `RustTree`, `PythonTree`).
- Each pack's `parse.ts` — collapse to the wrapper shape.
- ESLint suppressions: drop the now-unnecessary
  `sonarjs/cognitive-complexity` disable on the deleted/shrunk
  scanner functions; keep the suppression on remaining
  language-specific scanners with the existing rationale.

**Steps:**
1. Wait on Layer 1 to land `scanLineComment`,
   `scanBlockCommentNonNesting`, the `allowMultiline` option on
   `scanRegularString`, and `MinimalTextTree` /
   `buildMinimalTextTree`.
2. Per-pack: replace the inline scan with the core helper. Run the
   pack's tests; they should pass unchanged because the helpers
   preserve byte-length and region semantics.
3. For the `parse.ts` consolidation: each pack's `parse.ts` becomes
   essentially `return buildMinimalTextTree(content, filePath) as XTree;`
   with the brand alias preserving distinct adapter generic
   parameters.
4. Drop the cognitive-complexity suppression from each shrunk
   function; keep it on the language-specific outer `scan` function
   in each pack with the existing rationale.
5. Verify dependency-cruiser still passes (no new layering
   violations).

**Acceptance:**
- All lang-pack tests pass.
- Each shrunk `strip.ts` is meaningfully smaller (target: ~30 lines of
  language-specific prefix handling vs. ~100 today).
- Each MVP `parse.ts` is a one-line wrapper.
- `pnpm typecheck && pnpm test && pnpm lint` clean.

## Group C — Graph engine

### Phase C1 — Deduplicate `resolveEdges` / `resolveEdgesFromRecords`

**Goal:** Eliminate the parallel-path duplication in
`lang-typescript/edges.ts`. After Phase 4 of the perf plan, the legacy
`resolveEdges` was kept for "tests and external callers" but is dead
in production. Both paths must currently be kept in lock-step.

**Closes findings:** graph F-3 (duplicate resolver implementations),
graph F-4 (TypeScript adapter's deep subdir layout — refinement
finding, fully closed by C1).

**Files touched:**
- `packages/graph/engine/src/lang-typescript/edges.ts` — collapse
  `resolveEdges` (lines 165–211) into a thin wrapper that runs its
  AST descent to produce `CallSiteRecord[]` and delegates to
  `resolveEdgesFromRecords`. Delete `pushEdge` (lines 340–368) in
  favor of `pushEdgeFromRecord` (lines 135–163), or vice versa
  (one survives).
- Test files referencing `resolveEdges` directly — keep the test
  contract; the wrapper preserves it.

**Steps:**
1. Audit external callers of `resolveEdges` (it's not exported through
   the package barrel; `lang-typescript/index.ts` re-exports it
   alongside `resolveEdgesFromRecords`). If no external caller exists
   in this workspace, mark `resolveEdges` deprecated and route through
   the new wrapper.
2. Refactor `resolveEdges` to: (a) run its AST descent producing
   records, (b) call `resolveEdgesFromRecords(records, ...)`. The
   helper functions shared by both paths collapse into one
   implementation.
3. Drop the duplicated `pushEdge` (or `pushEdgeFromRecord` — one
   name wins).
4. Verify graph tests pass and the `duplicated-function-body` rule no
   longer fires on these two helpers.

**Acceptance:**
- `pnpm --filter=@opensip-tools/graph test` green.
- `edges.ts` line count materially reduced; the two `pushEdge*`
  helpers collapse to one.
- Graph fitness check `duplicated-function-body` no longer flags this
  pair.

### Phase C2 — Extract `cache/incremental.ts`

**Goal:** Promote 320 lines of closure-fixpoint reasoning out of the
orchestrator into a dedicated cache module so the orchestrator stays
focused on stage wiring.

**Closes findings:** graph F-9 (incremental rebuild in one large
function), graph F-7 (orchestrator `obtainCatalog` mixes three
concerns — partially: F-7's classify-cache-as-stage promotion is
folded into this phase too).

**Files touched:**
- `packages/graph/engine/src/cache/incremental.ts` (new) — exports
  `runIncremental({ adapter, discovery, cachedCatalog, changedFiles })`
  returning `{ catalog, resolutionStats }`. Move
  `buildAndResolveCatalogIncremental`, `expandClosureToFixpoint`,
  `expandClosureOnce`, `collectHashesFromOccurrences`,
  `collectStaleHashes`, `groupCachedHashesByFile`,
  `findEdgeDependents`, `occHasEdgeIntoStale`, `mergeOccurrences`,
  `pushOccurrence`, `mergeResolvedAndCachedEdges` here.
- `packages/graph/engine/src/cli/orchestrate.ts` — delete those 320
  lines; `obtainCatalog` (or its successor) calls
  `runIncremental(...)` for the `'incremental'` verdict path.
- Move unit tests for the closure-fixpoint algorithms to live next to
  the new module.

**Steps:**
1. Move the 11 helper functions to `cache/incremental.ts`. The
   public entry is `runIncremental(...)`.
2. Update `cli/orchestrate.ts` to import and delegate.
3. Move existing closure-related tests to a new
   `cache/incremental.test.ts`.
4. Verify the dependency-cruiser graph rules still hold (the
   cache directory shouldn't import from any `lang-*` pack — it
   takes a `GraphLanguageAdapter` parameter, exactly as the
   orchestrator does today).

**Acceptance:**
- `cli/orchestrate.ts` shrinks from ~724 lines toward ~400.
- All existing graph tests green.
- The new module's unit tests pass; the orchestrator's tests cover
  only the orchestration responsibility.

### Phase C3 — Visitor / resolver tabularization and shared edge helpers

**Goal:** Convert the dispatcher if-ladders in
`lang-typescript/walk.ts` and `edges.ts` into data tables; and finish
the `appendEdge` extraction so all adapters use it uniformly. The
`functionLikeFromDeclaration` duplication across five resolver files
becomes one helper with a shape mask.

**Closes findings:** graph F-2 (`dispatchVisitor` if-ladder),
graph F-6 (`appendEdge` half-extracted; resolver-shaped duplication),
graph F-13 (`functionLikeFromDeclaration` duplicated across five
resolvers).

**Files touched:**
- `packages/graph/engine/src/lang-typescript/walk.ts` — replace the
  if-ladder in `dispatchVisitor` (lines 192–201) with a table-driven
  dispatch. Same for `computeVerdict` in `edges.ts` (lines 301–316).
- `packages/graph/engine/src/lang-typescript/edges.ts` — adopt
  `appendEdge` from `lang-adapter/edge-helpers.ts` at the four sites
  that currently inline the `get-or-create-list-and-push` pattern
  (lines 128–130, 156–158, 358–363, 285–290).
- `packages/graph/engine/src/lang-adapter/edge-helpers.ts` — extend
  with `pushCreationEdge<NodeRef, FileRef>` (factory taking a
  `getStartLineColText` callback) and a `MutableStats` object with
  `apply(edge)` consolidating per-confidence stat increments.
- `packages/graph/engine/src/lang-typescript/edge-helpers/declaration-to-node.ts`
  (new) — single `functionLikeFromDeclaration(d, accept: DeclShape)`
  with a bitmask of acceptable shapes. Five resolver files
  (`direct-call.ts`, `jsx-element.ts`, `property-access.ts`,
  `polymorphic.ts`, `new-expression.ts`) call it with their
  specific masks.

**Steps:**
1. Build the visitor table in `walk.ts`: an array of
   `[predicate, visitor]` pairs (or `Map<ts.SyntaxKind, Visitor>`
   for the unique-kind cases). Iterate it in `dispatchVisitor`.
   `module-init`'s synthesizer remains called separately by the
   walker initializer (per `inventory-visitors/types.ts`).
2. Build the resolver dispatch table in `edges.ts`'s
   `computeVerdict`. Same shape.
3. Migrate `lang-typescript`'s four `appendEdge`-shaped sites to call
   the helper directly. Add `pushCreationEdge` and `MutableStats` to
   `lang-adapter/edge-helpers.ts` and migrate `lang-python` and
   `lang-rust` to use them.
4. Extract `functionLikeFromDeclaration` into the shared helper with
   `DeclShape` bitmask. Update each of the five resolver files to
   call the shared helper with its specific mask.

**Acceptance:**
- Adding a new visitor or edge resolver no longer requires editing
  the dispatcher (the table absorbs new entries).
- All three lang-* adapters' resolvers use `appendEdge`,
  `pushCreationEdge`, and `MutableStats` from the shared
  `edge-helpers.ts`.
- The `duplicated-function-body` rule no longer fires on the five
  `functionLikeFromDeclaration` copies.
- Graph tests green.

## Group D — Fitness engine

### Phase D1 — Decompose `executeFit`

**Goal:** Reduce the 612-line `executeFit` to an orchestration shell
of ~80 lines by extracting its 14 named phases into helpers. Each
helper has one reason to change.

**Closes findings:** fitness #3 (`executeFit` is 612 lines doing eight
things), fitness #8 (`fitnessTool.register` symmetric decomposition).

**Files touched:**
- `packages/fitness/engine/src/cli/fit.ts` — `executeFit` (lines
  327–612) extracted into named helpers: `loadFitConfig`,
  `validateLanguagesAgainstAdapters`, `selectRecipe`, `buildCliOutput`,
  `buildFitDoneResult` (per the audit's own recommendation list).
- `packages/fitness/engine/src/tool.ts` — `register()` (lines 92–217)
  and `runGateMode` (lines 223–278) split into one
  `registerXxxCommand(program, cli)` per subcommand
  (`registerFitCommand`, `registerDashboardCommand`,
  `registerListCommand`, `registerRecipesCommand`); add sibling mode
  helpers (`runListMode`, `runRecipesMode`, `runJsonMode`,
  `runLiveMode`) alongside the existing `runGateMode`.

**Steps:**
1. Extract `loadFitConfig(args, cwd)` returning the
   `{ signalersConfig, targetsConfig, targetRegistry }` triple with
   the shared error-result early-return.
2. Extract `validateLanguagesAgainstAdapters(targetRegistry,
   langRegistry)` for the warning block.
3. Extract `selectRecipe(args, recipeName)` for ad-hoc-vs-named
   selection (returns `FitnessRecipe | { error: ErrorResult }`).
4. Extract `buildCliOutput` and `buildFitDoneResult`.
5. `executeFit` becomes the orchestration shell calling these
   in order. The `// eslint-disable-next-line
   sonarjs/cognitive-complexity` directive at the top should drop
   along with the cognitive complexity.
6. Split `register()` along the four subcommands.

**Acceptance:**
- `executeFit` is under ~100 lines.
- The `sonarjs/cognitive-complexity` suppression on `executeFit` is
  removed.
- All fitness tests pass; the public surfaces (`fitnessTool.register`,
  CLI behavior) are unchanged.

### Phase D2 — Unify per-check execution lifecycle

**Goal:** Eliminate the parallel/sequential duplication of per-check
timeout, retry, and error/success dispatch by extracting `runOneCheck`.
Both executors become scheduling shells.

**Closes findings:** fitness #5 (parallel and sequential executors
duplicate the per-check lifecycle).

**Files touched:**
- `packages/fitness/engine/src/recipes/run-one-check.ts` (new) —
  exports `runOneCheck(check, opts, ctx): Promise<RunOutcome>` with
  `RunOutcome = { kind: 'success' | 'error', ... }`.
- `packages/fitness/engine/src/recipes/parallel-execution.ts` —
  delegate per-check to `runOneCheck`; keep only the sliding-window
  scheduling.
- `packages/fitness/engine/src/recipes/sequential-execution.ts` —
  delegate per-check to `runOneCheck`; keep only the `for-of` loop.

**Steps:**
1. Lift the shared per-check lifecycle (build `ProcessorContext`, set
   up `AbortController`, set `setTimeout` for the timeout, wrap
   `check.run(...)` in `executeWithRetry`, dispatch to
   `processSuccessResult` / `processErrorResult` based on
   abort/result state, return `shouldStop`) into `runOneCheck`.
2. Reconcile the divergent abort-path semantics between parallel
   (`signal.aborted` checked after `executeWithRetry` resolves) and
   sequential (separate `timedOut` flag): pick one canonical shape
   and use it in `runOneCheck`. Document the decision.
3. Both schedulers now: (a) await `runOneCheck`, (b) forward to
   `processSuccessResult` / `processErrorResult`, (c) honor
   `shouldStop`.

**Acceptance:**
- A bug fix to per-check timeout/abort/retry semantics now lands in
  one place.
- Both `parallel-execution.test.ts` and
  `sequential-execution.test.ts` pass without changes.
- Behavior parity between the two schedulers is preserved (any
  pre-existing divergence noted in the audit is consciously
  reconciled, not preserved).

### Phase D3 — Move `filterContent` out of fitness; remove the lang-typescript back-edge

**Goal:** Pay down the documented `lang-no-fitness-except-typescript`
exception by moving `filterContent` to the layer where it belongs
(lang-typescript or core), inverting the cycle. Once moved, the
dep-cruiser exception is deleted; future contributors don't see "lower
layer reaches up" as precedent.

**Closes findings:** lang-typescript #5 (`filterContent` is in the
wrong package), lang-typescript #7 (`ts` namespace re-export
duplicated between lang-typescript and fitness — paired because they
have the same shape and the same fix), fitness #14 partial (the LRU
cache duplication is touched here only insofar as the `filterCache`
move, broader cache consolidation is deferred).

**Files touched:**
- `packages/languages/lang-typescript/src/filter.ts` (new) — moved
  from `packages/fitness/engine/src/framework/content-filter.ts`. The
  symbols `filterContent`, `clearFilterCache`, `FilteredContent`
  move; the timer-based cache moves with them.
- `packages/fitness/engine/src/framework/content-filter.ts` —
  becomes a thin re-export shim for backwards compat (or is deleted if
  no external consumer remains; check first).
- `packages/languages/lang-typescript/src/strip.ts` — drop the
  `import { filterContent } from '@opensip-tools/fitness'` and the
  re-export.
- `packages/languages/lang-typescript/src/index.ts` — top-level export
  for `ts` namespace (currently only via `./ast-utilities`).
- `packages/fitness/engine/src/index.ts` (lines 33–36) — drop the
  `ts` re-export. Migrate the ~5 consumer checks that import `ts`
  from fitness to import from `@opensip-tools/lang-typescript`.
- `.dependency-cruiser.cjs` — delete the
  `lang-no-fitness-except-typescript` rule (lines 187–199).
- `CLAUDE.md` — update the layering exception note to reflect the
  paid-down exception.

**Steps:**
1. Move `filterContent`, `clearFilterCache`, `FilteredContent` from
   `fitness/engine/src/framework/content-filter.ts` to
   `lang-typescript/src/filter.ts`. The fitness file remains as a
   re-export only if other internal fitness callers depend on it; in
   that case the re-export is internal-only and the dep-cruiser rule
   still goes away because the import direction is now top-down.
2. Delete the `import` in `lang-typescript/src/strip.ts`.
3. Add `export * as ts from 'typescript'` (or equivalent) at the top
   of `lang-typescript/src/index.ts`. Migrate fitness's ~5 consumer
   checks (sql-injection, etc., per the audit).
4. Drop the `ts` re-export from `fitness/engine/src/index.ts`.
5. Delete the `lang-no-fitness-except-typescript` dep-cruiser rule.
6. Audit `framework/strip-literals.ts`'s `stripStringLiterals` /
   `stripStringsAndComments` against the moved `filterContent` — pick
   one stripper and retire the other (lang-typescript audit Finding 5
   recommendation).

**Acceptance:**
- `pnpm lint` (which runs dep-cruiser) passes after the rule is
  deleted.
- No package on the lang-* side imports from `@opensip-tools/fitness`.
- `CLAUDE.md`'s "documented exception" paragraph is updated to
  reflect that the exception has been paid down.

### Phase D4 — Severity-mapping table, gate identity strategy, SARIF builder typing

**Goal:** Three small, disconnected fitness cleanups grouped because
they're each ~1-day refactors with similar shape (replace inline
construction or string-keyed dispatch with a typed table or
parameterized strategy).

**Closes findings:** fitness #2 (severity-mapping primitive obsession),
fitness #6 (gate hashing strategy hard-coded), fitness #7 (SARIF
"builder" is an inline walker).

**Files touched:**
- `packages/fitness/engine/src/framework/severity-mapping.ts` —
  replace the 7-arm `switch` with a frozen
  `TAG_TO_CATEGORY: Record<string, SignalCategory>` lookup. Add a
  warn-once log when a check's tags contain none of the known
  categories so the silent fallback surfaces at startup.
- `packages/fitness/engine/src/gate.ts` — extract `hashViolation`
  (lines 243–245) into a `ViolationIdentity` strategy parameter on
  `compareToBaseline` (default unchanged).
- `packages/fitness/engine/src/sarif/types.ts` (new) — shared typed
  `SarifResult` interface (mirroring the consumer type at
  `gate.ts:265–275`). Producer (`sarif.ts`) and consumer (`gate.ts`)
  agree by construction.
- `packages/fitness/engine/src/sarif.ts` — `buildSarifRuns` (lines
  33–86) and `chunkSarifRuns` (98–139) consume the typed interface;
  introduce a `SarifResultBuilder` with `withLocation`, `withFix`,
  `withSeverity`, `build()`.

**Steps:**
1. Severity-mapping table: replace the switch; add the warn-once
   diagnostic.
2. Gate identity: parameterize `compareToBaseline` (and
   `extractViolationsFromCliOutput` /
   `extractViolationsFromSarif`) with a `ViolationIdentity` callback.
   Default preserves today's `(filePath, ruleId, message)` semantics.
3. SARIF builder: hoist the duplicated typed `SarifResult` from the
   gate consumer into a shared `sarif/types.ts`. Convert
   `buildSarifRuns` to a `SarifResultBuilder` per result; chunker
   consumes the typed shape (no more `r.ruleId as string` casts).

**Acceptance:**
- Severity-mapping unit tests assert the table lookup; a misspelled
  tag triggers the warn-once.
- Gate tests with the default identity pass unchanged; a new test
  exercises a custom identity (e.g. `(filePath, ruleId)` only).
- SARIF tests assert the typed shape; chunker no longer casts.

### Phase D6 — Introduce `defineRegexListCheck` Template helper

**Goal:** Add a `defineRegexListCheck` Template helper to
`@opensip-tools/fitness` so the ~13 sites in `checks-universal` (and a
handful in `checks-typescript`) that reimplement the
"for line; for pattern; if match push violation" loop can collapse
into ~30-line declarative configs. The helper's per-pattern UUID +
sub-slug shape mirrors the existing `no-console-log.ts` pattern, which
becomes the helper's default. Layer 4 Phase C6 consumes this.

**Closes findings:** none in the fitness audit directly (this is the
Layer-3-side prerequisite for Layer 4's checks-universal F4 closure).

**Files touched:**
- `packages/fitness/engine/src/framework/define-regex-list-check.ts`
  (new) — exports `defineRegexListCheck({ id, slug, description,
  tags, scope, contentFilter, patterns, options })` returning a
  `Check` via `defineCheck`.
- `packages/fitness/engine/src/framework/__tests__/define-regex-list-check.test.ts`
  (new) — unit tests for the per-pattern UUID + sub-slug emission,
  comment-skip option, test-file-skip option, and `lastIndex` reset
  semantics.
- `packages/fitness/engine/src/index.ts` — export
  `defineRegexListCheck` from the public barrel.

**Steps:**
1. Sketch the API by inspecting `no-console-log.ts`'s shape — that
   check defines a `CONSOLE_PATTERNS` array with `{ id, slug, regex,
   message, suggestion }` per pattern. Promote that shape to the
   helper's `patterns` parameter.
2. Wrap the existing `defineCheck` API. The helper's `analyze` callback
   loops over lines, applies the optional `isCommentLine` /
   `isTestFile` skip predicates, then loops over each pattern and emits
   one violation per match (resetting `lastIndex` between matches —
   the audit calls out that several existing sites get this wrong).
3. Per-match violation shape: emit one violation with
   `metadata.subSlug` set to the pattern's slug; the framework's
   directive resolver should already handle sub-slug suppression
   (verify; if not, that's a separate small fitness change).
4. Add unit tests. Document the helper in the framework barrel JSDoc.

**Acceptance:**
- `defineRegexListCheck` is exported from `@opensip-tools/fitness`.
- Unit tests cover per-pattern emission, skip predicates, and
  `lastIndex` reset.
- A migrated reference implementation (e.g. `no-window-alert.ts` or
  another small site identified by Layer 4 Phase C6) compiles and
  passes its existing tests after migration.

**Risk / dependencies:** None for the helper itself. Layer 4 Phase C6
consumes it; that adoption is owned by the Layer 4 plan.

### Phase D5 — Minor fitness consolidations

**Goal:** A grab bag of small fitness cleanups deferred from D1–D4:
rename `getLineNumber` to remove the duplicate-name footgun, share the
comment-opener table between the two directive parsers, extend
`SignalersConfigSchema` to absorb the `dashboard.editor` value (drop
the hand-rolled YAML extractor), and document the `CheckSelector`
typed-switch decision.

**Closes findings:** fitness #11 (directive parsers re-implement
comment-opener detection), fitness #13 (hand-rolled YAML extractor in
`dashboard.ts`), fitness #15 (two `getLineNumber` exports), fitness #9
(documentation-only — `CheckSelector` typed-switch trade-off).

**Files touched:**
- `packages/fitness/engine/src/framework/ast-utilities.ts` — rename
  `getLineNumber` to `getASTLineNumber` directly. The barrel re-export
  becomes a plain `export from`.
- `packages/fitness/engine/src/framework/comment-openers.ts` (new) —
  shared `COMMENT_OPENERS` table (line, block, HTML, hash). Consumed
  by `directive-parsing.ts` and `directive-inventory.ts`.
- `packages/fitness/engine/src/framework/directive-inventory.ts` —
  consume the shared table; widen the inventory to surface
  HTML/hash directives (the current bug — silently misses them).
- `packages/fitness/engine/src/signalers/loader.ts` — extend
  `SignalersConfigSchema` to include
  `dashboard: z.object({ editor: z.string().optional() }).optional()`.
- `packages/fitness/engine/src/cli/dashboard.ts` — delete
  `extractDashboardEditor` (lines 70–92); read the value from the
  loaded `signalersConfig`.
- `packages/fitness/engine/src/recipes/check-resolution.ts` — add the
  intentional-typed-switch comment per fitness #9 recommendation.

**Steps:**
1. Rename inside `ast-utilities.ts`. Update internal callers.
2. Hoist the comment-opener table; add a regression test asserting
   that a `# `, `// `, `/* `, and `<!-- ` directive all (a)
   suppress and (b) surface in the inventory.
3. Extend the signalers schema; delete the hand-rolled YAML
   extractor; route the dashboard editor through the loaded config.
4. Add the explanatory comment to `check-resolution.ts`.

**Acceptance:**
- One name, one signature: `getASTLineNumber` everywhere.
- Inventory and parser stay in sync (regression test pins this).
- Dashboard reads the editor from the same loader the rest of the
  package uses.
- Comment in `check-resolution.ts` documents the typed-switch
  trade-off.

## Group E — Simulation engine

### Phase E1 — Reconcile metric resolution

**Goal:** Eliminate the divergence between the two `getMetricValue`
implementations, which today produce different assertion results
depending on whether `validateAssertions` or the result-builder runs.
This is a quietly user-visible bug.

**Closes findings:** simulation Finding 2 (two parallel
`getMetricValue` implementations), simulation Finding 11 (primitive
obsession in `ScenarioAssertion.metric: string`).

**Files touched:**
- `packages/simulation/engine/src/framework/resolve-metric.ts` (new)
  — single `resolveMetric(metric: ScenarioMetricKey, metrics,
  durationSeconds?): number` consumed by both call sites.
- `packages/simulation/engine/src/framework/execution/execution-engine.ts`
  — delete the local `getMetricValue` (lines 166–206); call
  `resolveMetric`.
- `packages/simulation/engine/src/framework/result-builder.ts` —
  delete `METRIC_FIELD_MAP` and the local `getMetricValue` (lines
  28–41, 182–216); call `resolveMetric`.
- `packages/simulation/engine/src/types/base-types.ts` — narrow
  `ScenarioAssertion.metric` from `string` to a
  `ScenarioMetricKey` union (the intersection of keys both resolvers
  handle, plus any keys explicitly added to the canonical resolver).
- Documentation: list the supported metric keys in one place
  (probably the new `resolve-metric.ts` JSDoc).

**Steps:**
1. Reconcile the divergent edge cases. The key disagreement
   (`success_rate` on `totalRequests === 0`) needs an explicit
   decision; document it in the new file.
2. Define `ScenarioMetricKey` as the union of supported keys.
3. Both resolvers delegate to `resolveMetric`. The
   `assertion.metric: ScenarioMetricKey` typing now catches typos at
   compile time.
4. Add a regression test that asserts a chaos scenario asserting
   `recovery_rate` produces the same value via both paths.

**Acceptance:**
- A typo like `'p99-latnecy'` is a TypeScript error.
- Both code paths produce identical values for every supported key.
- Existing simulation tests pass.

### Phase E2 — Extract `runWindow` and dedupe per-kind validation

**Goal:** Eliminate the load/chaos `runWindow` duplication via a
shared `runLoadWindow` helper (Template Method shape) and consolidate
the four kinds' `validateXxxScenarioConfig` boilerplate into shared
metadata/uniqueness validators. Reconcile the four
`defineXxxScenarioWithoutRegistration` helpers.

**Closes findings:** simulation Finding 1 (`runWindow` duplicates the
load executor's loop), simulation Finding 3 (per-kind
`validateXxxScenarioConfig` boilerplate), simulation Finding 12
(`defineScenarioWithoutRegistration` family — bare-minimum validation
drift), simulation Finding 7 (chaos kind composes load via copy, not
Strategy — paired here for the documentation choice).

**Files touched:**
- `packages/simulation/engine/src/framework/execution/run-load-window.ts`
  (new) — exports `runLoadWindow(config, context, options)`. The
  chaos version passes a per-tick `injectChaos` callback.
- `packages/simulation/engine/src/kinds/load/executor.ts` — delegate
  to `runLoadWindow`.
- `packages/simulation/engine/src/kinds/chaos/executor.ts` — delegate
  to `runLoadWindow` with an `injectChaos` callback returning
  `'success' | 'failure' | 'chaos-event'` plus the optional
  `ChaosEvent`.
- `packages/simulation/engine/src/framework/validation.ts` (new) —
  `validateScenarioMetadata(config, errors)`,
  `validateScenarioUniqueness(config, errors)`,
  `throwValidationErrors(errors, kind)`.
- `packages/simulation/engine/src/kinds/{load,chaos,invariant,fix-evaluation}/define.ts`
  — replace boilerplate with shared validator calls; keep
  kind-specific checks (chaos's recovery window, fix-evaluation's
  predicate tree, invariant's `relatesToInvariant` anchor).
- `packages/simulation/engine/src/kinds/*/define.ts` — unify the four
  `defineXxxScenarioWithoutRegistration` helpers per simulation
  Finding 12 (option (a): same validator, `{ skipRegistryCheck: true }`
  flag).
- `docs/architecture/30-the-sim-loop/01-scenarios-and-recipes.md` —
  reconcile the chaos-config doc to match implementation per
  simulation Finding 7. Choose option (b) per the audit note (the
  flattened shape is less invasive); update the doc to show the
  flattened shape rather than `baseLoad: LoadScenarioConfig`. Defer
  option (a) (proper composition) to a future major.

**Steps:**
1. Build `runLoadWindow`. Both kind executors collapse to a
   delegation plus the kind-specific tick callback.
2. Build the validation helpers; route each kind's validator
   through them.
3. Unify the test helpers via the `skipRegistryCheck` flag.
4. Update the chaos-scenario architecture doc to match the
   implementation. Note the deferred decision (composition vs.
   flattened) explicitly.

**Acceptance:**
- A change to the simulation tick loop now lands in one place.
- Validator semantics are uniform across kinds; new kind
  scaffolding is ~30 fewer lines.
- The documentation diagram in
  `docs/architecture/30-the-sim-loop/02-execution-model.md` (per
  simulation Finding 4) is also corrected here in passing — show
  `await scenario.run(ctx) /* polymorphic */` and label the case
  lines as "extension point" not "runtime dispatch".
- Test helpers go through the same gate as production validators.

### Phase E3 — Promote `RecipeRegistry<T>` to core; tighten kind/tag typing

**Goal:** Eliminate the trivial duplication between
`SimulationRecipeRegistry` and `FitnessRecipeRegistry` (registry
plumbing, `BUILT_IN_NAMES` Set, the `URCP_/RCP_/BSCP_` id-prefix
conventions) by promoting `RecipeRegistry<T>` to core. Tighten the
hardcoded `KindScenarioSelector.kinds` and `cli/sim.ts:VALID_KINDS`
to derive from `SCENARIO_KINDS` so a new kind is a one-touch addition.

**Closes findings:** simulation Finding 8 (`simulation/recipes` and
`fitness/recipes` share intent but not code), simulation Finding 4
(`_exhaustive: never` exists at one site only — the open-coded
duplicates of `SCENARIO_KINDS`).

**Files touched:**
- `packages/core/src/recipes/registry.ts` (new) — exports
  `RecipeRegistry<T extends { id: string; name: string;
  displayName: string; description: string; tags?: readonly string[] }>`
  matching the existing `GenericRegistry<T>` shape.
- `packages/fitness/engine/src/recipes/registry.ts` — replace the
  local `FitnessRecipeRegistry` with `new RecipeRegistry<FitnessRecipe>(...)`.
- `packages/simulation/engine/src/recipes/registry.ts` — same for
  `SimulationRecipeRegistry`.
- `packages/simulation/engine/src/recipes/types.ts` —
  `KindScenarioSelector.kinds: readonly ScenarioKind[]` (no string
  literal duplication).
- `packages/simulation/engine/src/cli/sim.ts` —
  `VALID_KINDS = new Set<ScenarioKind>(SCENARIO_KINDS)`.

**Steps:**
1. Promote `RecipeRegistry<T>` to core. Do **not** extract the
   recipe service or selector resolver — those legitimately diverge
   between fitness and simulation per the audit's explicit guidance.
2. Migrate both packages to consume the core registry.
3. Tighten the `KindScenarioSelector` and `VALID_KINDS` so adding a
   new kind doesn't leave them stale.

**Acceptance:**
- A new built-in scenario kind requires editing only:
  `kinds/<new>/`, the `index.ts` export, the
  `ScenarioExecutorResult` union arm, and the
  `renderScenarioResultView` case. Each (except the directory) is
  compile-time enforced.
- Registry semantics changes (e.g. how name collisions are
  detected) land in one place.
- Both packages' tests pass.

## Deferred

These findings are real but deferred — either because the contract
decision they require should land deliberately, or because the cost
exceeds the leverage at this iteration.

- **Fitness #1 (analysis-mode dispatch as Strategy/Map-of-Strategies),
  fitness #4 (`recipes/check-config.ts` `globalThis` projection),
  fitness #10 (`fitnessTool.initialize` no-op masking module-singleton
  state in `cli/fit.ts`), fitness #12 (service `start` throws vs.
  `Result<T,E>`), fitness #14 broader cache consolidation
  (`BoundedCache<K,V>` in core).** Each is a real refactor but blocked
  on a contract decision: how many tools/modes will exist long-term
  (governs whether a Strategy map pays back); whether OpenSIP's runtime
  ever runs two `FitnessRecipeService` instances in parallel (governs
  the `globalThis` removal); whether multiple tool-instance support is
  a target (governs the runtime-on-tool refactor); whether the
  `result-pattern-consistency` rule should learn service-class
  boundaries; whether the four cache-eviction policies merit a single
  shared abstraction. Land each individually when the driving
  use-case appears.

- **Lang-typescript #1–#3 partial (`ast-utilities.ts` shim split,
  `parseSource` deprecation walk, query API decision), #4 (query API
  decision), #6 (subpath exports drop).** The shim is a known migration
  surface; the subpath exports drop is a major-version break. Land
  these as a coordinated lang-typescript v2 once the platform is
  willing to ship a major. Phase D3 already migrates the highest-cost
  back-edge (`filterContent` and `ts` re-export), so the shim
  becomes purely cosmetic once D3 is in.

- **Lang-pack #4–#6 informational items: `parse()` cannot fail today
  (lang-rust F3, lang-go F1, lang-java F5, lang-python F5), tree-shape
  duplication (lang-rust F4, lang-go F6, lang-python F3), barrel
  surface trimming (lang-rust F5).** All are pinned by tree-sitter
  arrival. Add the one-line file-header comments now (per each
  audit's recommendation); the type narrowing and barrel trimming
  defer to the v2 release per the lang-pack family.

- **Lang-cpp F2 (split `cAdapter` from `cppAdapter`).** Defer until
  `checks-cpp` gains a second check that needs language-level
  granularity. The `aliases` matching fix in Phase A2 closes the
  immediate user-visible trap; the deeper architectural split waits
  for a real driver.

- **Lang-cpp F3 (preprocessor / line-continuation handling).** The
  two-line line-continuation fix in `//` is in scope; preprocessor
  awareness (`#if 0 ... #endif`) is a larger discussion. Document the
  current "regex/text checks on C/C++ are best-effort, real analysis
  via clang-tidy" stance in the adapter file's leading comment as
  part of Phase A1; defer real preprocessor masking.

- **Graph F-10 (public barrel does not re-export
  `GraphLanguageAdapter`).** Deliberate gating per
  `docs/architecture/40-the-graph-loop/03-adding-a-language.md`.
  Promote when the team is ready to ship a third-party graph-adapter
  contract publicly. The matching `plugins.graph:` config-key parallel
  to `plugins.tool` lands at the same time. No action this iteration.

- **Graph F-12 (move `_entry-points.ts` to `pipeline/`).** Cosmetic;
  bundle with C2 if the timing is convenient, otherwise defer.

- **Simulation #5–#10 (informational/dismissed-in-spirit findings):
  invariant-driver Strategy is correctly shaped (no action),
  predicate-registry singleton-scope decision (document, no code
  change), `Signal.source` accuracy (no action), `tags: readonly
  string[]` typing (deliberately open vocabulary).** Each gets a
  one-line documentation comment in the relevant file as a
  follow-up; no structural change.
