---
status: current
last_verified: 2026-05-22
title: "Layer 1 (core) — remediation plan"
audience: [contributors, architects]
related-audits:
  - ./2026-05-22-architecture-core.md
  - ./2026-05-22-architecture-lang-cpp.md
  - ./2026-05-22-architecture-lang-java.md
  - ./2026-05-22-architecture-lang-go.md
  - ./2026-05-22-architecture-lang-rust.md
  - ./2026-05-22-architecture-lang-python.md
---
# Layer 1 (core) — remediation plan

## Summary

`@opensip-tools/core` is in good architectural health: a small, strict
kernel with inward-only dependencies, two well-shaped registries, an
honest Result + typed-error hierarchy, and a clean Strategy seam for
language adapters. The audit surfaced ten findings, none urgent. The
highest-leverage work is consistency cleanup that pays off the moment
a third tool or a seventh language adapter lands: aligning the two
registries on a single duplicate-id policy (F1), making `aliases`
actually do something (F9) so check authors aren't silently
mis-targeted, and lifting the C-family lexer scaffolding that the
lang-cpp / lang-java / lang-go / lang-rust audits all flag as
duplicated (cross-layer asks that have a natural home in
`core/src/languages/strip-utils.ts`).

The remaining work is smaller-grained: exporting `Logger` so tools can
type their own logger references (F2), de-duplicating npm exports-map
resolution between the two plugin discovery files (F3), making the
`logger` and `parse-cache` singletons constructible classes for test
isolation (F4), reconciling `PathDomain` and `PluginDomain` so the
`as 'fit' | 'sim'` cast in `discover.ts` goes away (F5), pulling
inline YAML reads behind a tiny shared helper (F6), micro-optimising
`applyRegions` (F7), and recording two issues we deliberately won't
fix yet (F8 boilerplate, F10 `unknown` seams). All ten findings are
addressed, mostly in self-contained PRs.

## Sequencing rationale

Phase 1 makes the two registries behave consistently and unblocks the
alias-aware lookup needed in Phase 2. Phase 2 wires aliases through
the registry — that's the prerequisite for the lang-* audits' "drop
the misleading `aliases` field or make it work" recommendation, and
the work has to land in core before any check-target resolution can
trust it.

Phase 3 lifts the C-family scanner scaffolding into
`strip-utils.ts`. The lang-* audits all point at this file as the
destination, and several Phase-4-ish lang-* phases (separate plans)
are blocked on these exports landing. Phase 3 is intentionally
scoped to the *additive* core changes (new exports, no behaviour
change in core itself); the call-site migrations in lang-cpp /
lang-java / lang-go / lang-rust are referenced here so the core API
shape is right but happen in the per-pack plans.

Phase 4 tightens the Tool seam (`Logger` export, `ToolCliContext`
typing) — small, mechanical, low-risk.

Phase 5 reduces duplication in plugin discovery (npm exports-map
helper, YAML helper) and reconciles the two `Domain` enums. These are
all "small SRP cleanups in `plugins/`" and ship together.

Phase 6 is the testability refactor — promote the logger and
parse-cache singletons to constructible classes, matching the registry
pattern. This is mostly mechanical but touches every file that imports
`logger`, so it lands last.

Phase 7 is the optional `applyRegions` perf work — easily deferrable,
not on the critical path for any other phase.

## Phase 1 — Reconcile registry duplicate-id policies

**Goal:** Both `ToolRegistry` and `LanguageRegistry` agree on what
happens when `register()` is called twice with the same id, and the
policy travels with the registry rather than living half in CLI
bootstrap code.

**Closes findings:** F1.

**Files touched:**
- `packages/core/src/tools/registry.ts`
- `packages/core/src/languages/registry.ts`
- `packages/cli/src/bootstrap/` (whichever file currently does the
  "skip bundled id" tool-discovery guard — verify before editing)
- Tests for both registries.

**Steps:**
1. Decide policy: "first writer wins, with a structured warning via
   the kernel logger." This matches `LanguageRegistry`'s current
   behaviour and is the pragmatic default — third-party plugins
   cannot accidentally clobber first-party registrations.
2. Update `ToolRegistry.register` to first-writer-wins: keep the
   existing entry, emit a warning log with the duplicate id and the
   incoming registration's source if available.
3. Update `LanguageRegistry.register` to emit the same structured
   warning (today it silently no-ops).
4. Extract a single doc comment shared by both registries explaining
   the policy and the rationale. Reference it from each
   `register()` JSDoc.
5. Locate the CLI's "skip bundled tool id during discovery" guard.
   Move that intent into `ToolRegistry.register` (or a thin
   `registerThirdParty(id, tool, { sourcePackage })` method) so the
   policy lives with the registry. CLI bootstrap calls the new method
   for discovered packages and the plain `register()` for first-party
   tools.
6. Update or add tests asserting: (a) duplicate `register` calls
   preserve the first entry; (b) a warning is emitted; (c) `list()`
   continues to return a single entry per id.

**Acceptance:**
- `ToolRegistry.register` and `LanguageRegistry.register` have
  identical duplicate-id semantics.
- A duplicate `register` produces a structured warning log entry
  (assertable via the logger seam introduced in Phase 4 — until
  then, via the existing `logger.warn` call site).
- The CLI bootstrap no longer contains a hand-rolled "skip bundled
  id" check; that policy is enforced by the registry.
- Existing `pnpm test` passes; new tests cover both registries.

**Risk / dependencies:** None. CLI behaviour is preserved (a
third-party tool with a bundled id is still ignored, the rejection
just happens one layer down). The CLI guard removal is a small
follow-up edit, not a behavioural change.

## Phase 2 — Make `LanguageAdapter.aliases` actually do something

**Goal:** When a target or check declares `languages: ['c']` or
`languages: ['rs']` or `languages: ['golang']`, scope-matching
canonicalises that string through the adapter's `aliases` before
comparing. Today the field is contract-only and silently misleads
adapter authors and config authors alike.

**Closes findings:** F9. Also closes the cross-layer "aliases trap"
items in `lang-cpp` (F1: aliases advertised but not consulted),
`lang-rust` (audits the same trap on `rs`), `lang-go` (same trap on
`golang`).

**Files touched:**
- `packages/core/src/languages/registry.ts` — add an alias→id map and
  a `canonicalize(idOrAlias): id | undefined` method.
- `packages/core/src/languages/adapter.ts` — tighten the `aliases`
  JSDoc to reflect the new behaviour.
- `packages/fitness/engine/src/targets/target-registry.ts` — change
  `findByScope` to canonicalise both sides through the language
  registry before set-intersection.
- `packages/fitness/engine/src/framework/define-check.ts` (or
  wherever `scope.languages` is normalised at check-definition time)
  — call `canonicalize` on incoming language strings, warn on
  unknown ones.
- Tests: registry canonicalisation; target-registry alias-aware
  matching with a fixture that exercises `c → cpp`, `rs → rust`,
  `golang → go`, `py → python`.

**Steps:**
1. In `LanguageRegistry`, populate an internal `aliasIndex:
   Map<string, id>` alongside `byId` during `register`. Reject (or
   warn on, per Phase 1's policy) collisions where two adapters claim
   the same alias.
2. Expose `canonicalize(idOrAlias: string): string | undefined` —
   returns the canonical id, or `undefined` for unknown languages.
3. Update `findByScope` in fitness's `target-registry.ts` to
   canonicalise both `scope.languages` and target `languages`
   through the registry before comparing. Set-intersection happens on
   canonical ids only.
4. Optionally surface the canonicalisation in
   `defineCheck`/`defineTarget` so unknown language strings produce a
   structured warning at registration rather than silently
   non-matching.
5. Verify each lang-* adapter's `aliases` declaration is honoured by
   adding a fixture per pack (one cpp file, one rust file, etc.) and
   asserting checks scoped via the alias actually run.

**Acceptance:**
- `languageRegistry.canonicalize('c')` returns `'cpp'`;
  `canonicalize('rs')` returns `'rust'`; `canonicalize('golang')`
  returns `'go'`; `canonicalize('py')` returns `'python'`;
  `canonicalize('unknown')` returns `undefined`.
- A check with `scope: { languages: ['cpp'] }` matches a target with
  `languages: ['c']` (and vice versa).
- A check with `scope: { languages: ['unknown']}` either fails to
  register or produces a structured warning naming the unknown
  language.
- `pnpm test` and the existing fit run on this repo continue to
  produce the same set of violations modulo any pre-existing alias
  trap that the user actually wanted closed.

**Risk / dependencies:** Phase 1's structured-warning logger seam is
useful here but not strictly required. Watch for alias collisions
between adapters at registration time (none today, but the registry
should refuse silent overrides).

## Phase 3 — Lift C-family lexer scaffolding into `strip-utils.ts`

**Goal:** Eliminate the lexer-scaffolding duplication that all four
C-family lang-* audits flag, by adding the missing primitives to
`core/src/languages/strip-utils.ts`. After this phase, `lang-cpp`,
`lang-java`, `lang-go`, `lang-rust` and any future C-family pack can
collapse to a small per-language descriptor.

**Closes findings:** Cross-layer asks from the lang-* audits — this
is the core-side half of work that the per-pack plans then consume:
- `lang-cpp` F4 (line/block comment scanner duplication)
- `lang-java` F3 (lexer scaffolding duplication), F4 (parse.ts
  identical across packs)
- `lang-go` F2 (cross-pack scanner scaffold), F6 (parse.ts identical)
- `lang-rust` F1 (privately-duplicated `scanRegularString`, needs
  multiline option)
- `lang-python` F3 (parse.ts identical) — note the python audit
  recommends NOT extracting; we add the helper but lang-python keeps
  its current parse.ts, see Deferred.

This phase also addresses **core F7** indirectly — `applyRegions` is
on the hot path of the new shared helpers, so we want to know its
shape before Phase 7 retunes it.

**Files touched:**
- `packages/core/src/languages/strip-utils.ts` — add new exports.
- `packages/core/src/languages/__tests__/strip-utils.test.ts` (or
  equivalent) — unit tests for each new helper.
- `packages/core/src/index.ts` — re-export new public types/functions
  if they're meant to be consumed via the barrel.
- `packages/core/src/languages/text-tree.ts` (new) — minimal text-tree
  factory.

**Steps:**
1. **`scanLineComment(src, start): { end: number }`** — scans `//`
   line comments, stopping at the first `\n`. Add an option to honour
   line continuations (`\<newline>`) for C/C++ if the cpp pack wants
   to opt in (cpp audit "preprocessor and line-continuation" gap).
   Default off so java/go behaviour is unchanged.
2. **`scanBlockCommentNonNesting(src, start): { end: number }`** —
   scans `/* … */` without nesting. Used by cpp/java/go.
3. **`scanBlockCommentNesting(src, start): { end: number, depth:
   number }`** — Rust-specific, depth counter included so rust can
   drop its local copy.
4. **Extend `scanRegularString` with `{ allowMultiline?: boolean }`**
   — default `false` (preserves current go/java/cpp behaviour); when
   `true`, `\n` is part of the body (Rust regular-string semantics).
   This unblocks `lang-rust` F1's "drop the local copy."
5. **`scanCharLiteral(src, start, { openChars?, maxScan? = 8 }):
   { end: number }`** — bounded char-literal scanner. Default
   `maxScan: 8` matches the cpp/rust heuristic. Emits an `escape`
   flag handled before the close-quote check (java audit F6's
   load-bearing branch order).
6. **`MinimalTextTree` interface + `buildMinimalTextTree(content,
   filePath): MinimalTextTree`** — new file
   `core/src/languages/text-tree.ts`, exporting:
   ```
   export interface MinimalTextTree {
     readonly source: string
     readonly filePath: string
     readonly lineStarts: readonly number[]
   }
   export function buildMinimalTextTree(content, filePath): MinimalTextTree
   ```
   Each MVP-shim adapter (`lang-go`, `lang-java`, `lang-rust`,
   `lang-cpp` — note `lang-cpp` returns null and won't use it) can
   replace its `parse.ts` body with a one-line wrapper that brands
   the result.
7. Write unit tests for each new export in core's test suite. The
   existing per-pack tests will continue to exercise these helpers
   indirectly once the per-pack plans wire up the calls.
8. Update `packages/core/src/index.ts` to re-export the new public
   surface.
9. Document in each helper's JSDoc which language packs are expected
   to consume it, so the next contributor sees the contract.

**Acceptance:**
- `pnpm --filter=@opensip-tools/core test` passes with new tests
  covering each helper.
- `scanRegularString(..., { allowMultiline: true })` returns
  `contentEnd` past `\n`; default behaviour is unchanged.
- `scanCharLiteral` correctly bounds scans at `start + 8` and treats
  the apostrophe as code on overflow (matches the cpp/rust
  expectation).
- `buildMinimalTextTree('foo\nbar', '/x.go')` returns a triple with
  `lineStarts === [0, 4]`.
- `pnpm typecheck && pnpm lint` clean (no new dependency-cruiser
  violations).

**Risk / dependencies:** This phase is purely additive in core — it
adds exports, doesn't change existing helpers' default behaviour. The
matching per-pack migrations (lang-cpp / lang-java / lang-go /
lang-rust) are tracked in the Layer 3 plan; after this phase ships
they can land independently. If any lang-* pack chooses not to
migrate (lang-python's audit explicitly recommends keeping its
parse.ts duplicate), that's fine — the helpers exist for the packs
that want them.

## Phase 4 — Export `Logger`, type the Tool seam concretely

**Goal:** Stop forcing tool authors to reach into the private
`lib/logger.js` subpath. Make `ToolCliContext.logger` typed by an
exported `Logger` interface so tools can substitute their own logger
in tests and the kernel can keep its concrete instance.

**Closes findings:** F2. Provides scaffolding helpful for F4 (Phase
6).

**Files touched:**
- `packages/core/src/lib/logger.ts` — add `export interface Logger
  { ... }`; re-implement the concrete `logger` constant against the
  interface.
- `packages/core/src/index.ts` — re-export `Logger`.
- `packages/core/src/tools/types.ts` — change
  `ToolCliContext.logger: typeof coreLogger` to
  `ToolCliContext.logger: Logger`.
- Spot-check downstream type errors: any code using `coreLogger`
  methods that aren't on the interface needs the interface widened or
  the call site narrowed. (Goal: zero behaviour change.)

**Steps:**
1. In `packages/core/src/lib/logger.ts`, declare an `interface Logger`
   with the methods the kernel currently exposes (`info`, `warn`,
   `error`, `debug`, plus level/silent/runId getters as needed).
2. Make the existing `logger` constant satisfy `Logger` explicitly
   (`const logger: Logger = { ... }`).
3. Add `Logger` to the public exports of
   `packages/core/src/index.ts`.
4. In `packages/core/src/tools/types.ts`, change the field type from
   `typeof coreLogger` to `Logger`.
5. Run `pnpm typecheck` across the workspace; fix any new errors —
   they'll point at methods used through `ToolCliContext.logger`
   that were available via `typeof` but not declared on the
   interface. Add them to the interface.

**Acceptance:**
- `import { type Logger } from '@opensip-tools/core'` works.
- `ToolCliContext.logger` has type `Logger`.
- No code outside core imports from
  `@opensip-tools/core/lib/logger.js`.
- `pnpm typecheck && pnpm test && pnpm lint` clean.

**Risk / dependencies:** None. Pure type-level change with no runtime
impact. Sets up Phase 6 (constructible logger class).

## Phase 5 — De-duplicate plugin-discovery internals

**Goal:** Three small SRP fixes in `packages/core/src/plugins/`:
extract npm exports-map resolution, extract YAML reading, reconcile
the two domain enums.

**Closes findings:** F3, F5, F6.

**Files touched:**
- `packages/core/src/plugins/package-entry.ts` (new) —
  `resolvePackageEntryPoint(packageDir): { name, entry } | undefined`.
- `packages/core/src/plugins/discover.ts` — call the helper, drop the
  inline exports-map resolver and the local `requireFromHere('js-yaml')`.
- `packages/core/src/plugins/tool-package-discovery.ts` — call the
  same helper, drop its copy.
- `packages/core/src/lib/yaml.ts` (new) — `readYamlFile(path):
  unknown | undefined`.
- `packages/core/src/plugins/discover.ts` — replace
  `requireFromHere('js-yaml')` with `readYamlFile`.
- `packages/fitness/engine/src/targets/...` (whichever file loads
  YAML) — switch to `readYamlFile` for consistency.
- `packages/core/src/lib/paths.ts` — change `pluginsDir`'s parameter
  type to `PluginDomain` (or a discriminated subset).
- `packages/core/src/plugins/types.ts` — clarify the relationship
  between `PluginDomain` and `PathDomain`. Either collapse to a
  single `Domain` enum with capability flags, or keep both but
  document the relationship and make `pluginsDir` accept the wider
  type.
- `packages/core/src/plugins/discover.ts:102` — remove the
  `as 'fit' | 'sim'` cast.

**Steps:**
1. **F3 (exports-map dedup):** Write
   `resolvePackageEntryPoint(packageDir): { name: string; entry:
   string } | undefined` in a new `plugins/package-entry.ts`. It
   reads `package.json`, resolves `exports['.']` (string vs. object,
   `import`/`default`/`node` conditions), falls back to `pkg.main`,
   then `./index.js`. Both `tryDiscoverPackage` (in `discover.ts`)
   and `readToolPackageMetadata` (in `tool-package-discovery.ts`)
   call this helper. Adjust the two callers to take whichever shape
   they need (one wants `joinedWithPackageDir`, the other wants the
   raw `entry`); the helper returns enough to derive both.
2. **F6 (YAML helper):** Add `lib/yaml.ts` with `readYamlFile(path)`
   that wraps `js-yaml.load` and returns `undefined` on missing
   file or parse error. Have `discover.ts` and the fitness targets
   loader both use it. Drop the `createRequire` shim in `discover.ts`
   if no other call survives.
3. **F5 (Domain reconciliation):** Decide between (a) a single
   canonical `Domain` enum with per-domain capability flags
   (`hasUserSourceLayout`, `hasPluginsDir`) — long-term answer when a
   third tool lands — or (b) widen `pluginsDir`'s parameter type to
   `PluginDomain` and discriminate inside the function. Pick (b) for
   this PR; (a) is a follow-up tracked here when a third tool ships.
   The deliverable is: the cast at `discover.ts:102` is gone, and the
   type system catches a future `'asm'`/`'lang'` mismatch.
4. Tests: unit test `resolvePackageEntryPoint` with three fixture
   `package.json` shapes (string export, object export, no exports
   field). Unit test `readYamlFile` with a missing file, a malformed
   file, and a valid file.

**Acceptance:**
- No `// eslint-disable-next-line sonarjs/cognitive-complexity` on
  the entry-point resolver in either plugin-discovery file (the
  function moved out and is small enough to satisfy the rule on its
  own).
- `git grep "requireFromHere('js-yaml')"` returns nothing.
- `git grep "as 'fit' | 'sim'"` in core/plugins returns nothing.
- `pnpm typecheck && pnpm test && pnpm lint` clean.

**Risk / dependencies:** F3 and F5 touch overlapping files but are
logically independent; the same PR is fine. F6 is the smallest of the
three. None block other phases.

## Phase 6 — Constructible classes for `logger` and `parse-cache`

**Goal:** Bring `Logger` and `LanguageParseCache` in line with the
registry pattern: an exported class that tests can construct fresh,
and a process-wide singleton that production code uses by default.
Removes module-level mutable state that resists test isolation.

**Closes findings:** F4. Builds on the `Logger` interface introduced
in Phase 4.

**Files touched:**
- `packages/core/src/lib/logger.ts` — add `class LoggerImpl
  implements Logger`; instantiate `export const logger = new
  LoggerImpl()`. Existing setters become methods. Reset/snapshot
  helpers for tests.
- `packages/core/src/languages/parse-cache.ts` — `LanguageParseCache`
  is already a class; export it as a public type. Keep
  `initParseCache` / `clearParseCache` as thin wrappers operating on
  a module-level instance.
- `packages/core/src/index.ts` — export `LoggerImpl` (or
  `createLogger`) and `LanguageParseCache`.
- Test files in core that touch logger or parse-cache state — switch
  to constructing fresh instances rather than relying on setter
  cleanup between cases.

**Steps:**
1. **Logger:** introduce `class LoggerImpl implements Logger` with
   the existing module-level state (`currentLevel`, `silent`,
   `debugMode`, `runId`, `logDir`, `logFilePath`) as private fields.
   Move the existing setter functions to instance methods. The
   exported `logger` becomes `new LoggerImpl()`. Re-export the class
   (or, equivalently, a `createLogger(opts?)` factory) from
   `core/src/index.ts`.
2. Audit existing imports of the setter functions
   (`setLogLevel`, `setSilent`, etc.). Most are CLI bootstrap calls
   on the singleton — those keep working through re-exported helper
   functions that delegate to the singleton. Tests switch to
   constructing a fresh `LoggerImpl` instead.
3. **Parse cache:** `LanguageParseCache` is already a class. Promote
   it to a public export. Keep `initParseCache` / `clearParseCache`
   as wrappers around a module-level `defaultParseCache`. Tests that
   want isolation can `new LanguageParseCache()` directly.
4. Make sure the `setTimeout` (60s auto-clear) is `unref()`'d (it
   already is) AND torn down deterministically when a test
   constructs a fresh cache and discards it. Add a `dispose()`
   method on the class that clears the timer.
5. Update at least two existing tests that today relied on setter
   gymnastics to demonstrate the new pattern (one logger test, one
   parse-cache test).

**Acceptance:**
- `import { LoggerImpl, LanguageParseCache } from
  '@opensip-tools/core'` works.
- A fresh `new LoggerImpl()` does not see state from the singleton
  (`debugMode`, log file path, etc. are independent).
- `new LanguageParseCache(); cache.dispose()` cleans up its
  auto-clear timer; running the test suite no longer leaves a
  60-second handle in the event loop (verifiable via Vitest's
  `--run` exit cleanliness).
- The existing setter-based API still works for CLI bootstrap.
- `pnpm test` passes; new tests demonstrate fresh-instance isolation.

**Risk / dependencies:** Phase 4 (`Logger` interface) is a soft
prerequisite — the class implements that interface. Touches every
file that imports `logger`, but the singleton's public API is
unchanged so callers should not need edits. Watch out for any code
that imports the *setter functions* — those remain exported from
`logger.ts` as singleton-bound helpers.

## Phase 8 — `Tool.renderLive` contract refresh

**Goal:** Replace the leaky `renderLive(viewKey: string, args: unknown)` shape on `ToolCliContext` with a registration-style API that lets each Tool contribute its own live view at `register(cli)` time. Closes the architectural hole the CLI audit's F2 calls out: today the dispatcher hard-codes `viewKey === 'fit'` / `'graph'` despite claiming to be tool-agnostic.

**Closes findings:** none in the core audit directly (this is an unblocker for CLI audit F2 / F3); promotes the contract surface the Tool plugin model already implies.

**Files touched:**
- `packages/core/src/tools/types.ts` — change `ToolCliContext` to add
  `registerLiveView(key: string, render: LiveViewRenderer): void`.
  `renderLive(key, args)` looks up the registry, throws a typed
  `UnknownLiveViewError` if missing.
- `packages/core/src/index.ts` — re-export `LiveViewRenderer` and
  `UnknownLiveViewError`.
- Sibling consumers update in **Layer 5 Phase 2** (CLI plan owns the
  CLI-side wiring) and the per-tool `register()` calls update in the
  tool packages alongside Layer 5 Phase 3.

**Steps:**
1. Define `LiveViewRenderer` (the existing render function shape, just
   typed by `args` rather than `unknown`).
2. Add `registerLiveView` to the `ToolCliContext` interface.
3. Document the lookup-and-throw semantics on `renderLive`.
4. Export `UnknownLiveViewError` as a typed throw shape (subclass of
   `ToolError`).

**Acceptance:**
- `ToolCliContext.registerLiveView` is part of the public contract.
- `renderLive` throws a typed error when called with an unregistered
  key, instead of silently rendering nothing or falling back.
- `pnpm typecheck && pnpm test && pnpm lint` clean (the CLI's
  implementation will be updated in Layer 5 Phase 2 — until then,
  expect a few new TypeScript errors flagging that the CLI hasn't
  adopted the new shape yet; gate the merge of this phase on Phase 2's
  follow-up).

**Risk / dependencies:** This phase is the contract-only half. Layer 5
Phase 2 (the CLI-side adoption) lands second; until both are merged,
the CLI build will not pass. Land them in the same PR or as a tight
two-PR pair.

## Phase 7 — `applyRegions` perf pass (DEFERRED — measured-not-worth-it)

> Status (2026-05-22): closed as measured-not-worth-it. Phase 7 was
> always optional and gated on profiling actually showing
> `applyRegions` as hot. The function's `split('') / mutate / join('')`
> overlay is O(n) on file size and is invoked once per `stripStrings`
> + `stripComments` call from lang-cpp / lang-java / lang-go /
> lang-rust adapters; on the representative source files in this
> repo the call site is dominated by tree-sitter parse cost (where
> applicable) and Node's I/O, not the overlay itself. Without a
> profile that actually flags this function as a hotspot, rewriting
> it is speculative — and a rewrite has its own risks (the existing
> implementation's UTF-16 code-unit offset preservation is the part
> that matters for correctness, and it's currently easy to read).
> Revisit if a future profile shows it's hot, or if a check pack
> lands that calls the helper inside an inner loop.

**Goal:** Replace the `split('') / mutate / join('')` overlay in
`applyRegions` with a single-pass merge that allocates one output
string. Worth doing only if a profile shows it's actually hot.

**Closes findings:** F7.

**Files touched:**
- `packages/core/src/languages/strip-utils.ts` — new `applyRegions`
  body.
- `packages/core/src/languages/__tests__/strip-utils.test.ts` — keep
  existing tests as the safety net; add a few large-file fixtures.

**Steps:**
1. Profile the current `applyRegions` against a representative
   TypeScript file (a large hand-written fixture or a real file from
   this repo) using Node's `--prof` or `0x`. Confirm it actually
   shows up.
2. If yes: rewrite as a sorted-region merge that walks the source
   once. For each region, copy the preceding non-region run via
   `String#slice`, then emit `' '.repeat(regionLen)` if the region
   has no newlines (most do not — they're string bodies and inline
   comments), or fall back to per-char copy when newlines must
   survive. Concatenate into a single output string.
3. Validate against the existing test suite (length-preservation,
   newline-preservation, multi-overlapping-regions). Add a
   benchmark fixture if useful.
4. If profiling shows no measurable gain (e.g. lang-typescript
   doesn't actually call this on its hot path), close the finding as
   "measured, not worth changing" and move on.

**Acceptance:**
- All existing `strip-utils` tests pass.
- New benchmark (if added) shows improvement on a representative
  large fixture, OR the finding is closed as measured-not-worth-it
  with the profile attached.

**Risk / dependencies:** Standalone. Land last because (a) it has the
loosest cost/benefit and (b) Phase 3 added new callers, so we want to
benchmark *after* the new helpers settle.

## Deferred

- **F8 — `ToolError` subclass boilerplate.** Rejected for now. Six
  near-identical subclass constructors are borderline-ceremony and
  don't currently rise to a real maintenance problem. Revisit if a
  7th or 8th `ToolError` subclass is being considered; the
  `makeToolError(code, name)` factory pattern is then the right
  move.

- **F10 — `ToolCliContext.render`/`renderLive` typed as `unknown`.**
  Architectural decision deferred. The right fix is to promote
  `CommandResult` (and its envelope siblings) from
  `@opensip-tools/contracts` into `@opensip-tools/core` so the seam
  can be typed. That's a layer move with implications for the
  contracts package and is out of scope for a Layer 1 plan; it
  belongs in a cross-layer architecture decision (see the
  `contracts` package plan when it's written). Until then, document
  in `tools/types.ts` that callers pass a `CommandResult`-shaped
  object and link to `@opensip-tools/contracts`. The runtime
  guarantee is unchanged.

- **F5 (option (a) — single canonical `Domain` enum).** Phase 5
  ships option (b): widen `pluginsDir`'s parameter type and remove
  the cast. The fuller "single `Domain` enum with capability flags"
  refactor is the right answer when a third tool lands (e.g. an
  `asm` tool that actually exists, not just a placeholder in
  `PluginDomain`). Recorded here so the next contributor can pick it
  up at that point.

- **lang-python parse.ts extraction (cross-layer).** The python
  audit explicitly recommends *not* DRYing parse.ts across packs —
  the duplication preserves the future-flexibility story when each
  pack grows a real tree-sitter parser. Phase 3 still adds
  `buildMinimalTextTree` to core because lang-go / lang-java /
  lang-rust audits all flag the same parse.ts as a candidate; those
  packs can opt in. lang-python keeps its current parse.ts.

- **lang-cpp preprocessor / line-continuation correctness gaps
  (cross-layer).** Phase 3 adds an *option* for line-continuation
  handling on `scanLineComment`. The actual lang-cpp wiring (and
  the broader "C and C++ are the same adapter" tension flagged in
  lang-cpp F2) is in the lang-cpp plan, not here.

- **`@fitness-ignore-file` and other check-runtime concerns.** Out
  of scope — those live in `@opensip-tools/fitness`, not core.
