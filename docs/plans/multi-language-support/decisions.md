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
