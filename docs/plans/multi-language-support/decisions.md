# Multi-Language Support: Architectural Decisions Log

**Status:** In-progress, overnight implementation pass.
**Purpose:** Record non-obvious architectural choices made during Phases 4-9 implementation for morning review.

---

## D1 — Phase 3: regex-based Rust strip lexer instead of tree-sitter

**Decision:** Hand-written Rust lexer in `lang-rust/src/strip.ts` for `stripStrings` and `stripComments`, no tree-sitter dependency.

**Why:**
- Tree-sitter via `web-tree-sitter` requires WASM init, async warmup race, and ~10 MB install footprint
- Our actual checks (DART's 7 fitness checks) are text-pattern based — they consume the result of `stripStrings`/`stripComments` and walk lines via regex
- The hand-written lexer correctly handles Rust's tricky cases: nested block comments, all four string flavors (regular/raw/byte/byte-raw), arbitrary `#` counts in raw strings, char literals vs lifetime annotations
- 13 tests cover the edge cases

**Trade-off / future:** When a check needs a real Rust AST (e.g. detecting `unwrap()` only on `Result` types vs all method calls named `unwrap`), `parse()` would need to return a real tree. The adapter contract supports that — only the implementation in `parse.ts` would need to change. Tree-sitter integration is deferred until a check requires it.

**Reversible:** Yes — replacing `parse.ts` is a contained change.

---

## D2 — Phase 2: keep `getSharedSourceFile` shim in core/framework/parse-cache.ts

**Decision:** Core's `framework/parse-cache.ts` retains a minimal `getSharedSourceFile()` that resolves the TS adapter from the registry (or falls back to direct parse). Used by `framework/import-graph.ts` internally.

**Why:**
- `import-graph.ts` is a TS-AST utility used by many checks via the core barrel — moving it to lang-typescript would reverse the dependency direction (lang → core, then core → lang for utilities)
- The shim is a thin wrapper that delegates to the language registry
- Keeps the core barrel API stable for the 150+ files importing TS helpers from `@opensip-tools/core`

**Trade-off:** Core still depends on `typescript` runtime. Phase 4 may revisit this when the content-filter dispatch goes through the adapter.

**Reversible:** Yes — removing the shim and migrating `import-graph.ts` to `@opensip-tools/lang-typescript` is mechanical when desired.

---

## D3 — Phase 1: registry-based dedup in plugin loader (D24 commit)

**Decision:** Loader tracks registered IDs (Check ids, adapter ids) and skips duplicates within a single plugin module. Allows the same Check or Adapter to be exported via array AND named/default export without producing two registrations.

**Why:**
- Single-file plugin authors may copy-paste between styles
- Without dedup, a plugin exporting `myCheck` and `checks = [myCheck]` would register the same id twice and trigger registry collision warnings
- Cheap (Set<string> per module) and correct

**Reversible:** Yes — the dedup set is a local variable scoped to one plugin load.

---

## (entries below this line are added during the overnight implementation)

---

## D4 — Phase 4: empty `scope.languages` means "any language" (universal scope)

**Decision:** Loosen `CheckScopeSchema` to accept empty `languages` arrays. Empty `languages` (and empty `concerns`) mean "match any language/concern" — the matching logic in `TargetRegistry.findByScope()` already treats empty arrays as match-any, so this aligns the schema with runtime behavior.

**Why:**
- `@opensip-tools/checks-universal` checks (TODO comments, file length) operate on any language. Without this change, authors must enumerate every supported language in `scope.languages: [...]` — a list that grows with every new language pack and would silently miss language packs added later.
- The runtime already supports universal scope; only the schema rejected it.
- An alternative — a wildcard sentinel like `'*'` — adds a special case for callers and matchers, where the natural representation (empty list = no constraint) is already consistent with how empty `concerns` work.

**Trade-off:** A user who forgets to set `scope.languages` will get a universal check by accident. This is the same risk as forgetting to set `concerns`, which is already non-required. We accept it because the alternative (mandatory non-empty arrays) blocks legitimate cross-language checks structurally.

**Reversible:** Yes — adding back `.min(1)` rejects universal checks at schema validation time.

---

## D5 — Phase 4: dispatch through `applyContentFilter()` instead of inlining `filterContent()`

**Decision:** New `core/src/languages/content-filter-dispatch.ts` exports `applyContentFilter(filePath, content, mode)` that resolves the file's adapter and calls its `stripStrings`/`stripComments`. `define-check.ts` and `file-accessor.ts` now call this instead of `filterContent` directly.

**Why:**
- Original code called `filterContent(content)` which is TS-specific. For Rust/Python/Java/Go files, that produced TS-scanner output — wrong.
- The adapter abstraction is precisely the seam to dispatch through.
- Falls back to raw content when no adapter is registered (preserves behavior for JSON, YAML, plain text — files that previously got TS-scanner output but happened to work since those don't contain TS-specific syntax).

**Trade-off:** When a check requests `strip-strings` against a file in an unrecognized language, it gets raw content. The check still runs but may false-fire on text inside string literals. Phase 9 validation will exercise this — if it's an issue, we add a "fail-loud on missing adapter" mode for stricter projects.

**Reversible:** Yes — `applyContentFilter` is a thin wrapper.

---

## D6 — Phase 4: tests register an in-process TS adapter shim

**Decision:** `content-filter-dispatch.test.ts` registers a minimal `LanguageAdapter` whose `stripStrings`/`stripComments` delegate to core's `filterContent()`. The shim has `id: 'typescript-test-shim'` and the same file extensions as the real TS adapter.

**Why:**
- Core can't depend on `@opensip-tools/lang-typescript` (cycle) but the dispatch tests verify behavior on `.ts` files.
- A shim that calls the still-in-core `filterContent` exercises the dispatch path without pulling in the real adapter package.
- Other tests that need full TS adapter behavior (CLI integration tests) register the real adapter at bootstrap.

**Reversible:** Yes — the shim is local to the test file.

---

## D7 — Phase 9: warn (don't fail) on unknown languages in target config

**Decision:** When `opensip-tools.config.yml` declares a target with `languages: [...]` containing a language with no registered adapter, the CLI prints a stderr warning naming the unknown language(s) and the known ones, then continues. It does NOT fail the run.

**Why:**
- Failing hard would break projects that pin to one CLI version while expecting older configs to keep working when a new language is added later.
- Silent acceptance was the previous behavior — files in unknown languages would scan but `applyContentFilter` would return raw content, producing wrong results.
- Loud warning + continue is the right balance: visible to the user, doesn't block CI, gives them time to install the lang pack or fix the typo.

**Trade-off:** A typo in `languages` (e.g. `pyhton` instead of `python`) becomes a warning rather than an error. This is intentional — error-on-unknown is too strict for a multi-language project where some adapters may be optional plugins. A future strict mode flag (`--strict-languages`) could elevate this to an error for projects that want it.

**Reversible:** Yes — the validation block in fit.ts is bounded to one section.

---

## D8 — Phase 5/6: pure `analyzeXxx` functions extracted for testability

**Decision:** Every check in checks-universal/checks-python/checks-java/checks-go/checks-cpp exports two things: a pure analysis function (e.g. `analyzeTodoComments(content)`) AND the `defineCheck`-wrapped Check (`noTodoComments`). Tests target the pure function.

**Why:**
- `defineCheck` wraps the user's `analyze` callback inside an `execute(ctx)` closure that requires an `ExecutionContext`. Direct unit testing of the wrapped Check would require standing up a full file-accessor + file-cache + signal infrastructure.
- The pure function is the actual logic; the Check is the framework-integrated wrapper. Testing the pure function exercises the algorithm; an end-to-end CLI test exercises the framework wiring.
- Pattern is consistent across all proof checks. Documented in `checks-universal/src/checks/no-todo-comments.ts`.

**Reversible:** Yes — if the framework adds a `Check.run(content, filePath)` convenience method later, tests can shift to call that.

---

## D9 — Phase 6: lang-cpp parse() returns null intentionally; CommandConfig is the analysis path

**Decision:** `cppAdapter.parse()` returns null. C/C++ analysis goes through `CommandConfig` (clang-tidy) rather than a JS-side parser.

**Why:**
- Writing a real C/C++ parser in TypeScript is intractable for the scope. Tree-sitter's C++ grammar exists but pulling it in for one language is heavy when clang-tidy is the de-facto standard tool everyone already has.
- `LanguageAdapter` already supports `parse: () => null` for command-only languages. The contract holds: stripStrings/stripComments still work for regex-based universal checks; AST-based checks rely on clang-tidy.
- Establishes the pattern for any future command-mode language (shellcheck, phpcs, etc.).

**Trade-off:** Universal checks that need a parse tree (none today) won't work for C/C++ files. We accept this — universal checks operate on text, and language-specific C/C++ checks all go through clang-tidy.

**Reversible:** Yes — adding tree-sitter-cpp later only changes `parse()` and a new `query` impl.

---

## D10 — Post-publish smoke test: auto-discovery for `@opensip-tools/checks-*` packages

**Decision:** The CLI auto-discovers any `@opensip-tools/checks-*` package installed in the project's `node_modules` (or any ancestor's `node_modules`, matching Node's resolution). Two override paths in `opensip-tools.config.yml`:
- `plugins.checkPackages: [...]` — explicit list; auto-discovery is bypassed
- `plugins.autoDiscoverChecks: false` — opt out entirely

**Why:**
- Smoke-testing tarball installs revealed that publishing 5 new check packages (`checks-universal`, `checks-python`, `checks-java`, `checks-go`, `checks-cpp`) was useless without a load mechanism. Only `checks-builtin` was hardcoded into the CLI's import list.
- The choice between auto-discovery and explicit declaration is a real trade-off (zero-config vs control). Default to auto-discovery so projects that just `npm install @opensip-tools/checks-python` see their checks fire — matches user expectations from comparable tools (eslint plugins, prettier plugins).
- Provide both override paths so deterministic environments (CI, security-conscious orgs) can pin their check set.

**Trade-off:** Discovery walks ancestor `node_modules` directories — could pick up an unwanted check package in a monorepo workspace root. Mitigated by the explicit-list opt-in for users who care about determinism.

**Reversible:** Yes — `loadDiscoveredCheckPackages` is an isolated function in fit.ts; the discovery module is self-contained in `core/src/plugins/check-package-discovery.ts`.

---

## D11 — Drive-by fix: `require('js-yaml')` in ESM context

**Decision:** Replaced bare `require('js-yaml')` with `createRequire(import.meta.url)('js-yaml')` in two places: my new `readCheckPackagePreferences()` and the pre-existing `readProjectPluginsList()` in `discover.ts`.

**Why:**
- Pre-existing bug: `readProjectPluginsList()` used `require('js-yaml')` literally. In ESM (which Node16 modules emit), there is no global `require`, and TypeScript's `module: Node16` setting passes the `require` call through unchanged. The function silently failed (the catch-all returned undefined) — meaning `plugins.fit/sim/asm` declarations in projects' configs were never honored.
- Same bug would have hit my new function for the same reason. Fixed both atomically.
- `createRequire(import.meta.url)` is the documented Node API for bridging ESM ↔ CJS. Resolves modules from this package's directory, which is where `js-yaml` is declared as a dep.

**Trade-off:** None. This is a pure correctness fix with no behavior change for callers — the function now actually works.

**Reversible:** Yes, but you wouldn't want to.

---

## D12 — Decouple CLI from `@opensip-tools/checks-builtin`

**Decision:** Removed the hardcoded `await import('@opensip-tools/checks-builtin')` from the CLI's `fit.ts` and `dashboard.ts`. Every check package is now discovered through the same `discoverCheckPackages()` path — no package is privileged. `checks-builtin` becomes an ordinary npm dependency declared in `cli/package.json` like any other check pack.

**Why:**
- The hardcoding created three concrete problems: (a) CLI ↔ checks-builtin version coupling forced lockstep releases; (b) `check-package-discovery.ts` carried a `if (name === BUILTIN_NAME) continue` carve-out that future contributors had to remember; (c) users couldn't substitute, slim down, or remove checks-builtin without forking the CLI.
- Discovery + auto-load is already battle-tested by D10. Routing checks-builtin through it eliminates the special case at zero new design risk.
- The plugin contract gained `FitPluginExports.checkDisplay` so packages contribute their own display names. The CLI merges these from every loaded package; on collision, last-loaded wins. No package owns the global display registry.
- A no-checks-loaded warning was added to the CLI: silent zero-checks would let a misconfig produce a green run scanning nothing, the exact failure mode the tool exists to prevent.

**Trade-off:** "Built-in vs community" labelling in the dashboard catalog now keys on the `@opensip-tools/` scope rather than a single magic name — a slightly looser definition, but it survives the checks-builtin split (D13) without changes.

**Reversible:** Yes — re-introducing the hardcoded import is a one-line change. But the entire reason for D13 was to never need to.

---

## D13 — Hard cutover: split `checks-builtin` into `checks-typescript` + `checks-universal`

**Decision:** Deleted `@opensip-tools/checks-builtin` (158 checks, mixed languages) and split it into:
- `@opensip-tools/checks-typescript` (new, v1.0.0) — 66 checks that import the TS compiler API or are conceptually only meaningful in a TS/Node ecosystem (drizzle, typed-inject, react, package.json#exports, tsconfig).
- `@opensip-tools/checks-universal` (existing, re-versioned to v1.0.0) — 92 checks that operate on raw text, regex, file globs, or language-agnostic config (Docker, .env, Sentry config, generic structure).

No deprecation shim. The CLI's `package.json` directly depends on both new packages.

**Why:**
- "checks-builtin" named its *implementation status* (it's hardcoded), not its *contents* — a code smell once D12 removed the hardcoding.
- Real composition: roughly 40% of the old pack was TS-specific. Bundling it on a Rust-first repo (DART) imposed mostly-irrelevant checks. Splitting lets non-TS projects pull only `checks-universal`.
- Classification rule: "language API used" (does the check import `typescript` / parse .ts AST?). Mechanical, easy to verify, and forces dual-purpose checks into TS_AST conservatively. Full table at `docs/plans/checks-builtin-split-classification.md`. Per-helper / per-test placement notes at `docs/plans/checks-builtin-split-summary.md`.
- Hard cutover (no compat package) avoids carrying a deprecated alias across versions. We're pre-1.0 for the CLI and there is exactly one external consumer (DART), so the migration cost is bounded and visible.

**Trade-off:**
- Anyone currently depending on `@opensip-tools/checks-builtin` must replace the dep with `checks-typescript + checks-universal`. Documented as a v0.7.0 breaking change in the next CLI release.
- The split surfaced a latent scope-resolver bug — fixed in D14.

**Reversible:** Yes mechanically, but the labeled packages are public API now. Reversal would be another breaking change.

---

## D14 — Fix: thread `globalExcludes` into matchFiles fallback

**Decision:** Plumbed `globalExcludes` from `FitnessRecipeServiceConfig` through `ExecutionOptions` → `RunOptions` → `createExecutionContext()` → `createMatchFilesFunction()`. The fileCache fallback now filters `fileCache.paths()` against the run's globalExcludes (compiled once into Minimatch matchers) before returning. CLI passes the project config's `globalExcludes` into the service.

**Why:**
- Surfaced by D13's split — DART suddenly loaded `file-length-limit` (which lives in `checks-universal`) and got hard errors against files in directories it had explicitly listed in `globalExcludes`.
- Root cause was pre-existing: `createMatchFilesFunction()` returned `fileCache.paths()` verbatim for scope-empty checks. The cache doesn't honor exclusion config — that filtering belongs at matchFiles.
- Custom `patterns` and per-check `targetFiles` paths are intentionally untouched: the former is caller-controlled, the latter is already filtered upstream by `preResolveAllTargets()`. Only the fallback needed the filter.
- Compiled Minimatch is reused across calls (closure over `compiledGlobalExcludes`) so we don't pay regex compilation per file.

**Trade-off:** None observed. Empty-scope checks now match the same exclusion semantics as scope-typed checks, which is the expected mental model.

**Reversible:** Yes — revert by removing the new `globalExcludes` field from `RunOptions` and the four sites that thread it. But the prior behavior was buggy; you wouldn't want to.

**Regression test:** `packages/core/src/framework/__tests__/execution-context.test.ts` — four cases covering no-excludes, dir patterns, extension patterns, and empty-array.
