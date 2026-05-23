---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/core"
package: "@opensip-tools/core"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/core

## Summary
The kernel is in good shape: it is a small, well-bounded layer with strict
inward-only dependencies and a clear set of focused subsystems (errors,
logger, IDs, retry, paths, language adapters, plugin discovery, Tool
contract). The Registry pattern is used twice (`ToolRegistry`,
`LanguageRegistry`); the Strategy pattern is implicit in
`LanguageAdapter`; a Result type lives next to a typed-error hierarchy.
Generics are propagated correctly through `LanguageAdapter<TTree, TNode>`
and `getParseTree<TTree>`, keeping the kernel adapter-agnostic.

The findings below are mostly small consistency and ISP/DIP issues:
two registries with diverging "duplicate id" semantics; a Logger seam
exposed only as `typeof logger`; npm exports-map resolution duplicated
across two plugin discovery files; module-level mutable singletons in
`logger.ts` and `parse-cache.ts` that resist test isolation; and a
narrow opportunity to factor the strip-utils + adapter relationship
behind a shared Template Method for hand-written language strippers.
None are urgent, but several are cheap and pay off the moment a third
tool or a seventh language adapter lands.

## Existing patterns (correct usage)

- **Registry — `tools/registry.ts:16-39` and `languages/registry.ts:11-69`.**
  In-memory collection keyed by stable id, with read-only `list()`
  snapshots returned by spread (so callers cannot mutate internal
  state). Both registries also expose a process-wide singleton
  (`defaultToolRegistry`, `defaultLanguageRegistry`) for the common
  case while leaving the class itself usable in tests. Correct: leave
  alone.

- **Strategy — `languages/adapter.ts:20-42` consumed by
  `languages/content-filter-dispatch.ts:37-53` and
  `languages/parse-cache.ts:84-110`.** `LanguageAdapter` is the
  Strategy interface; `applyContentFilter` and `getParseTreeForFile`
  resolve the adapter once via the registry and delegate. The kernel
  never branches on `adapter.id`. Correct: leave alone.

- **Factory functions — `types/signal.ts:53-72` (`createSignal`),
  `lib/ids.ts:11-19` (`generateId`, `generatePrefixedId`).** Encapsulate
  ID format and default-field policies behind a function so callers
  cannot drift. The `createSignal` factory is the right level of
  abstraction (default `provider`, default `category`, ULID-style id,
  ISO timestamp) and keeps `Signal` immutable for consumers. Correct:
  leave alone.

- **Result type + typed errors — `lib/errors.ts:14-105`.** `ToolError`
  is the shared root and every subclass uses a stable `code` constant.
  `ok` / `err` / `tryCatch` / `tryCatchAsync` form a small, complete
  Result API. Subclasses are used in real `instanceof` discrimination
  in fitness and graph (e.g. `ValidationError` / `SystemError` vs.
  generic). Correct: leave alone.

- **Inversion of control — `tools/types.ts:60-94` (`ToolCliContext`).**
  Tools never import the CLI package; instead the CLI hands them a
  context object containing `render`, `renderLive`,
  `maybeOpenDashboard`, `setExitCode`, and `logger`. This is the seam
  that lets `core` stay below `cli` in the layer graph and is exactly
  the right shape. Leave alone.

- **Path Resolver — `lib/paths.ts:88-112`.** Centralises every project-
  and user-level filesystem path behind one resolver, so a layout
  change is a single-file edit. Doc comment is precise about which
  paths are tracked vs. gitignored. Leave alone.

## Findings (problems / improvement opportunities)

### 1. Two registries, two opposite "duplicate id" policies
- **Files / code:** `packages/core/src/tools/registry.ts:24-26`
  ("Re-registering the same id replaces the previous entry — last
  writer wins") vs. `packages/core/src/languages/registry.ts:15-23`
  (silently no-ops on duplicate id; first writer wins).
- **Pattern / principle:** LSP / consistency of the Registry pattern.
- **Status:** problematic.
- **Why it matters:** Two collaborators in the same kernel implement
  the same conceptual operation (`register`) with opposite semantics.
  Plugin authors and CLI bootstrap code must remember which is which:
  a third-party tool *can* override a first-party tool by id, but a
  third-party language adapter *cannot* override a first-party adapter
  by id. The CLI partly papers over this by skipping bundled-id matches
  during tool discovery, but the divergence at the kernel level is real
  and will bite the next person who reads one and assumes the other.
- **Recommendation:** Pick one policy and align both registries on it,
  documenting the choice in a single doc comment shared by both. The
  pragmatic choice is "first writer wins, with a structured warning"
  — it matches existing language-adapter behaviour and keeps third-
  party tools from accidentally clobbering first-party ones if the CLI
  guard ever regresses. If "last writer wins" is the deliberate policy
  for tools, the CLI's "skip bundled id" check belongs *in*
  `ToolRegistry.register` (or in a thin wrapper) rather than in CLI
  bootstrap, so the policy travels with the registry. Edit
  `packages/core/src/tools/registry.ts` and
  `packages/core/src/languages/registry.ts`.

### 2. `Logger` interface is private to its file but the contract leaks
- **Files / code:** `packages/core/src/lib/logger.ts:25-30` declares
  and exports `Logger`; `packages/core/src/index.ts` does NOT re-export
  it; `packages/core/src/tools/types.ts:27,88` types
  `ToolCliContext.logger` as `typeof coreLogger` (private import path).
- **Pattern / principle:** DIP / ISP.
- **Status:** opportunity.
- **Why it matters:** Every Tool that wants to type its own logger
  reference (or pass a substitute logger in tests) currently has to
  either (a) reach into the private `lib/logger.js` subpath that the
  CLAUDE.md guidance discourages, or (b) re-derive the shape with
  `typeof`. The kernel already has the right abstract interface — it
  just isn't part of the public surface. Exposing it costs zero kernel
  state but unlocks DI and substitutability for tools and tests.
- **Recommendation:** Export `Logger` from
  `packages/core/src/index.ts`, change `ToolCliContext.logger` in
  `packages/core/src/tools/types.ts` from `typeof coreLogger` to
  `Logger`. Internal log helpers continue to import the concrete
  `logger` instance; consumers that only need the contract type get
  the interface.

### 3. npm `exports`-map resolution duplicated in two discovery files
- **Files / code:** `packages/core/src/plugins/discover.ts:225-282`
  (`tryDiscoverPackage` — exports → main → `index.js`) and
  `packages/core/src/plugins/tool-package-discovery.ts:144-177`
  (`readToolPackageMetadata` — exports → main → `./index.js`). Both
  walk `exports['.']` as string vs. object, then `import`/`default`,
  then fall back to `pkg.main`, then default. Both carry near-identical
  `// eslint-disable-next-line sonarjs/cognitive-complexity` comments
  acknowledging the shape.
- **Pattern / principle:** DRY / SRP.
- **Status:** problematic.
- **Why it matters:** Two copies of nontrivial npm-exports logic will
  drift. Today they already diverge in detail: one returns
  `mainEntry` joined with `packageDir`, the other returns the raw
  `entryPoint` plus a `packageName`. Any future correction (e.g. to
  honour `exports['./']` patterns, or to recognise `exports['node']`
  conditions) has to be applied twice and both call sites have to
  agree.
- **Recommendation:** Extract the resolution to a single internal
  helper, e.g. `resolvePackageEntryPoint(packageDir): { name, entry } |
  undefined`, and have both `tryDiscoverPackage` and
  `readToolPackageMetadata` call it. Place it in
  `packages/core/src/plugins/` (e.g. `package-entry.ts`) since it's a
  plugin-discovery concern. No public API change.

### 4. Module-level mutable singletons resist test isolation
- **Files / code:** `packages/core/src/lib/logger.ts:34-39`
  (`currentLevel`, `silent`, `debugMode`, `runId`, `logDir`,
  `logFilePath` are file-scoped `let`s mutated by setters);
  `packages/core/src/languages/parse-cache.ts:50-51` (`activeCache`,
  `autoClearTimer` similarly). Tests reach into these via the setter
  functions but cannot snapshot/restore.
- **Pattern / principle:** SRP, testability (and an indirect violation
  of the Singleton-vs-injectable trade-off — Singleton makes sense for
  the *default* but the class should still be usable on its own).
- **Status:** opportunity.
- **Why it matters:** Both files have legitimate "process-wide default"
  use cases, but every other kernel singleton (`defaultToolRegistry`,
  `defaultLanguageRegistry`) is an instance of an exported class that
  tests can construct fresh. Logger and parse-cache are the odd ones
  out: setters thread through hidden state, debug mode bleeds across
  tests, and an `initParseCache()` left from a prior test leaves a
  60-second `setTimeout` (unref'd, but still live).
- **Recommendation:** Introduce a `LoggerImpl` class (or a
  `createLogger(opts)` factory) and have `logger` be `new
  LoggerImpl()`; export both. Same for parse cache: `LanguageParseCache`
  is already a class — promote it to an exported type and have
  `initParseCache` / `clearParseCache` operate on the singleton while
  the class is also constructible. This is a low-risk, mostly-
  mechanical refactor that brings Logger and parse-cache in line with
  the registry pattern already established elsewhere in core.

### 5. `PathDomain` and `PluginDomain` overlap but disagree
- **Files / code:** `packages/core/src/lib/paths.ts:85`
  (`PathDomain = 'fit' | 'sim' | 'graph'`);
  `packages/core/src/plugins/types.ts:91`
  (`PluginDomain = 'fit' | 'sim' | 'asm' | 'lang'`);
  `packages/core/src/plugins/discover.ts:102`
  (`projectPaths.pluginsDir(domain as 'fit' | 'sim')` — the cast is
  the smoking gun).
- **Pattern / principle:** ISP / type-level honesty.
- **Status:** problematic.
- **Why it matters:** The `as 'fit' | 'sim'` cast at
  `discover.ts:102` shows the contracts don't compose: `discoverPlugins`
  is typed to accept any `PluginDomain` but at runtime branches early
  for `'lang'` and `'asm'` to return empty, then casts away the
  remaining mismatch when calling `pluginsDir`. A new domain added in
  one file but not the other will compile because of the cast, and
  fail silently.
- **Recommendation:** Either (a) collapse to one canonical
  `Domain` enum with explicit per-domain capability flags
  (`hasUserSourceLayout`, `hasPluginsDir`, etc.), or (b) keep both
  enums but change `pluginsDir`'s parameter type to `PluginDomain` and
  use a discriminated check inside the function so the cast goes
  away. (a) is the better long-term answer when a third tool lands;
  (b) is the cheap fix today.

### 6. Default-export singleton + module-level `requireFromHere` couples discover.ts to its own module path
- **Files / code:** `packages/core/src/plugins/discover.ts:39`
  (`const requireFromHere = createRequire(import.meta.url)`) plus
  `:164` (`requireFromHere('js-yaml')`).
- **Pattern / principle:** DIP — kernel reaches out to a concrete
  parser via Node's CJS shim instead of receiving it.
- **Status:** opportunity.
- **Why it matters:** Inline YAML parsing in `discover.ts` is a small
  pragmatic choice (avoiding a circular dep with the targets loader)
  but it bakes a runtime dependency into a module that other tests
  must mock at the file-system layer rather than the parser layer. It
  also forks the project's YAML stack: this file uses `js-yaml` while
  fitness's targets loader can use a different parser without the two
  noticing.
- **Recommendation:** Extract a tiny internal helper
  `readYamlFile(path): unknown | undefined` next to
  `config-resolution.ts` (or in a new `lib/yaml.ts`) and have both
  `discover.ts` and the targets loader use it. The kernel already
  centralises path resolution this way; YAML parsing should follow
  the same pattern. Optional but cheap.

### 7. `applyRegions` uses an in-place character buffer
- **Files / code:** `packages/core/src/languages/strip-utils.ts:98-108`.
  ```ts
  const buf = src.split('');
  for (const r of regions) {
    for (let i = r.start; i < r.end; i++) {
      if (buf[i] !== '\n') buf[i] = ' ';
    }
  }
  return buf.join('');
  ```
- **Pattern / principle:** Performance / SRP (this is a hot path —
  every adapter calls it on every file).
- **Status:** opportunity.
- **Why it matters:** `split('')` allocates an array of length-N
  strings, then `join('')` allocates back. Region overlay is the
  inner loop of `stripStrings` / `stripComments`; for a large
  TypeScript file with hundreds of strings + comments this is a
  measurable hot path. Six adapters share this implementation today.
- **Recommendation:** Replace with a sorted-region merge that walks
  the source once, copying non-region runs into a single string
  (`String#slice` + `' '.repeat` for region bodies that contain only
  non-newlines, or per-char copy where newlines must survive). This
  is a self-contained change in `strip-utils.ts` with the existing
  unit tests as a safety net. Worth profiling before/after to
  confirm; defer if the lang-typescript adapter (which has its own
  TypeScript-AST-driven strip) doesn't actually call into this
  helper for its hot path.

### 8. `ToolError` subclasses each re-implement `code` defaulting in the same shape
- **Files / code:** `packages/core/src/lib/errors.ts:24-71`. Six
  subclasses, each with a constructor of the form
  `super(message, options?.code ?? 'X', options); this.name = 'X';`.
  `TimeoutError` and `NetworkError` add one extra typed field but
  follow the same pattern.
- **Pattern / principle:** DRY / Template Method.
- **Status:** opportunity (low priority).
- **Why it matters:** Adding a new error class is six near-identical
  lines, and a typo in `this.name` is silent. Not enough boilerplate
  to be painful today, but the pattern repeats 6 times.
- **Recommendation:** Introduce a tiny helper or a class factory:
  `class ValidationError extends makeToolError('VALIDATION_ERROR', 'ValidationError') {}`.
  Or accept the boilerplate; this is borderline ceremony. Worth
  flagging only if a 7th or 8th error class is being considered.

### 9. `LanguageAdapter.aliases` is contract-only — never consulted
- **Files / code:** `packages/core/src/languages/adapter.ts:26-27`
  declares `aliases?: readonly string[]` with the comment "Matched
  against legacy scope strings"; `packages/core/src/languages/registry.ts`
  never reads `aliases`. The arch doc
  (`docs/architecture/60-subsystems/01-language-adapters.md:128`)
  acknowledges this: "the registry today does not consult it during
  lookup".
- **Pattern / principle:** ISP — interface advertises capability the
  implementation doesn't honour.
- **Status:** problematic.
- **Why it matters:** Any adapter author who reads the contract will
  reasonably expect `forFile` or `get` to fall through `aliases` on
  a miss. They don't. The field is forward-compatible metadata at
  best and a misleading contract surface at worst.
- **Recommendation:** Either implement alias-aware lookup (one extra
  Map populated alongside `byId`, consulted by `get(id)` only — file-
  extension lookup doesn't need aliases), or remove the field from
  the public contract until it's actually used. The doc comment
  on the field already says "matched against legacy scope strings",
  which is concrete enough that wiring it up is the right call.

### 10. `ToolCliContext.program: unknown` is the right call but `render` and `renderLive` slipping `unknown` is over-broad
- **Files / code:** `packages/core/src/tools/types.ts:65-77`.
  `program: unknown` is justified (Commander major version
  flexibility). `render: (result: unknown) => Promise<void>` and
  `renderLive: (viewKey: string, args: unknown) => Promise<void>` use
  the same trick but for a different reason: the contract type for
  results is `CommandResult` and lives in `@opensip-tools/contracts`,
  which is one layer below `core` per the layer doc — so core
  cannot import it without inverting the layer graph.
- **Pattern / principle:** DIP / ISP.
- **Status:** opportunity (architectural; not urgent).
- **Why it matters:** Today every tool that calls `cli.render(result)`
  passes a value of an actual contract type. The type system can't
  catch a mismatch between what fitness produces and what the CLI's
  Ink renderer expects, because the seam is `unknown`. The pragmatic
  workaround works, but it gives up a real safety property the
  kernel could otherwise enforce.
- **Recommendation:** Promote `CommandResult` (and any sibling
  envelope types) into `core` so it can be the typed parameter for
  `render` / `renderLive`. This is consistent with how
  `LanguageAdapter` is typed concretely in core today. Or, keep the
  current shape and document explicitly in `tools/types.ts` that
  the runtime guarantee is "tools pass a `CommandResult`-shaped
  object" with a pointer to `contracts`. Either is fine; do not
  leave it under-documented. (Note: `contracts` is currently above
  core in the layer cake per CLAUDE.md, so importing into core is a
  layer move; the audit flags the choice, not a specific direction.)

## Non-findings considered and dismissed

- **Promote `LanguageAdapter` to a class with a Template Method
  base.** Considered — three of the four operations (`stripStrings`,
  `stripComments`, `parse`) have a per-language signature and the six
  hand-written adapters already share `strip-utils.ts` for the bits
  that *are* common. A base class would mostly be a vehicle for
  default `aliases = []` and would force language packs to extend
  rather than implement an interface. The interface-plus-shared-
  utility shape is fine.

- **Make `ToolRegistry` an `EventEmitter` so observers can react to
  registration.** No current consumer wants this. The CLI bootstrap
  walks `list()` once. Adding events would be ceremony.

- **Add a Builder for `Signal`.** `createSignal` is already a tiny
  factory with sensible defaults, and the `Signal` shape is small
  enough that the pre-positional-init form is clearer than a chained
  builder. Reject.

- **Replace the `Result<T,E>` discriminated union with a class
  hierarchy (`Ok` / `Err`).** TypeScript discriminated unions with
  `ok: true | false` give better type narrowing in callers and zero
  allocation overhead. The current shape is the right idiom.

- **Introduce a Visitor for traversing parse trees.** `LanguageQueryAPI`
  exposes find-functions / find-imports / find-calls-to as named
  operations, deliberately. A Visitor would couple every adapter to
  a single tree-walk vocabulary; named queries let each adapter
  implement them efficiently in its own AST shape (TypeScript compiler
  API today, tree-sitter tomorrow).

- **Force `ToolCliContext` to be a class with a defined factory in
  core.** The current "interface plus CLI-supplied object" form is
  the right inversion seam. Promoting it to a class would push
  CLI-shaped concerns (Ink, dashboard launching) into core, breaking
  the layer rule.
