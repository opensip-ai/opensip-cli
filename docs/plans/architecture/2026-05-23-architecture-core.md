---
status: current
last_verified: 2026-05-23
title: "Architecture audit — @opensip-tools/core (delta)"
package: "@opensip-tools/core"
audience: [contributors, architects]
related-audits:
  - ./2026-05-22-architecture-core.md
  - ./2026-05-22-plan-layer-1-core.md
---
# Architecture audit: @opensip-tools/core (2026-05-23)

Delta audit verifying Layer 1 Phase 1–6 + Phase 8 remediations against
the 2026-05-22 baseline, plus a sweep for net-new and missed findings.

## Status of prior findings (2026-05-22)

- **F1 — Two registries, two opposite duplicate-id policies:** CLOSED
  by `91c834b`. Both `ToolRegistry.register` and
  `LanguageRegistry.register` are now first-writer-wins with structured
  `tool.registry.duplicate` / `lang.registry.duplicate` warnings
  (`packages/core/src/tools/registry.ts:28-40`,
  `packages/core/src/languages/registry.ts:25-38`). Tests exercise
  the new contract on both sides
  (`tools/__tests__/registry.test.ts:43-86`,
  `languages/__tests__/registry.test.ts:62-92`).
  `ToolRegistry.registerThirdParty` adds the `sourcePackage` field to
  warnings (`tools/registry.ts:49-62`); the CLI uses it from
  `packages/cli/src/bootstrap/register-tools.ts:49-73`.
- **F2 — `Logger` interface not exported:** CLOSED by `4821a95`.
  `Logger` interface is declared at `lib/logger.ts:35-40`, re-exported
  from `index.ts:63`, and `ToolCliContext.logger: Logger`
  (`tools/types.ts:155`). See net-new **N1** below — the exported
  singleton is still typed as the concrete class, partially defeating
  the abstraction.
- **F3 — npm exports-map resolution duplicated:** CLOSED by `c996a0a`.
  `resolvePackageEntryPoint` lives in
  `plugins/package-entry.ts:47-70`; both `tryDiscoverPackage`
  (`plugins/discover.ts:216-247`) and `readToolPackageMetadata`
  (`plugins/tool-package-discovery.ts:146-150`) call it. Neither call
  site carries the old cognitive-complexity disable comment.
- **F4 — Module-level mutable singletons:** CLOSED by `b1c2a85`.
  `LoggerImpl` class at `lib/logger.ts:53-150`, exported singleton at
  `:223`, back-compat helpers at `:225-247`. `LanguageParseCache` at
  `languages/parse-cache.ts:36-97`, with the new `dispose()` method at
  `:86-92`. Both have isolation tests
  (`logger.test.ts:283-334`, `parse-cache.test.ts:121-149`).
- **F5 — `PathDomain` / `PluginDomain` mismatch:** CLOSED (option (b))
  by `c996a0a`. `PluginsPathDomain = PathDomain | 'asm' | 'lang'`
  (`lib/paths.ts:96`) is the parameter to `pluginsDir`
  (`lib/paths.ts:71`); the call site at `plugins/discover.ts:100` no
  longer needs a cast. The single-canonical-`Domain` rewrite (option
  (a)) remains deferred until a third tool ships, as the plan
  recorded.
- **F6 — Inline YAML / `requireFromHere` shim:** CLOSED by `c996a0a`.
  `lib/yaml.ts:36-44` exposes `readYamlFile`; `discover.ts:30, 159`
  uses it. `git grep "requireFromHere('js-yaml')"` returns nothing in
  `packages/core/src` — only the comment in `lib/yaml.ts` referencing
  the prior shape survives. `readYamlFile` is also re-exported
  publicly (`index.ts:70`); see **N2** below.
- **F7 — `applyRegions` perf:** DEFERRED (measured-not-worth-it) per
  the plan. Implementation unchanged at `strip-utils.ts:342-352`. The
  ESLint disable comment on `split('')` is correct (UTF-16 unit
  preservation is load-bearing), so the shape is intentional. No
  regression.
- **F8 — `ToolError` boilerplate:** DEFERRED. Six subclasses still
  follow the same constructor template (`lib/errors.ts:24-71`). No
  new subclass landed; the deferral is appropriate.
- **F9 — `LanguageAdapter.aliases` not consulted:** CLOSED by
  `fd178f1`. `LanguageRegistry` indexes aliases (`registry.ts:23,
  59-91`) and exposes `canonicalize(idOrAlias)` (`registry.ts:115-119`).
  Tests cover canonical→canonical, alias→canonical, case-insensitive
  inputs, alias collisions, and alias-vs-canonical-id collision
  (`languages/__tests__/registry.test.ts:144-227`).
- **F10 — `render`/`renderLive` typed `unknown`:** DEFERRED (cross-
  layer; needs `CommandResult` promoted into core or contracts moved).
  `tools/types.ts:105,129` retains `unknown`. Phase 8 reshaped
  `renderLive` into a registration-style API (`registerLiveView`,
  `UnknownLiveViewError`); the param type is still `unknown` because
  each tool defines its own args shape. Doc comment at `:60-63`
  acknowledges this explicitly.

## Net-new findings (introduced or surfaced by Wave 1–4)

### N1 — Exported `logger` singleton typed as `LoggerImpl`, not `Logger`
- **Severity:** P2.
- **Where:** `packages/core/src/lib/logger.ts:223`
  (`export const logger: LoggerImpl = new LoggerImpl()`).
- **What:** Phase 4 exported the `Logger` interface and Phase 6 added
  the `LoggerImpl` class; the singleton is annotated with the concrete
  class type. Production callers that `import { logger }` get a
  `LoggerImpl`, not a `Logger`, which silently re-exposes
  setters (`setDebugMode`, `initLogFile`, etc.) at every call site.
  This re-introduces the DIP concern Phase 4 closed for
  `ToolCliContext` — the interface is honoured at the seam but not at
  the singleton itself. SRP/ISP: a typical consumer wants the four
  log-level methods, not the configuration surface.
- **Why it matters:** Tools and tests that import `logger` for a
  `warn`/`info` call gain visibility into the configuration API,
  inviting "just call `logger.setDebugMode()` here" patches that the
  CLI bootstrap should own. Re-typing as `Logger` lets the type system
  catch that.
- **Recommendation:** Change `:223` to
  `export const logger: Logger = new LoggerImpl()`. Keep `LoggerImpl`
  exported for tests and tools that want the constructor (already at
  `:53` and `index.ts:62`).

### N2 — `readYamlFile` and `LoggerImpl` widen the public API for use cases that are nominally internal
- **Severity:** P3 (note only).
- **Where:** `packages/core/src/index.ts:62, 70`. `LoggerImpl` and
  `readYamlFile` are part of the package barrel.
- **What:** `readYamlFile`'s docstring at `lib/yaml.ts:1-22`
  explicitly positions it as "permissive helper used by plugin-
  discovery sites" and warns "Strict YAML loading … is the targets
  loader's job." `LoggerImpl` is "for tests (or tools that need an
  isolated logger)." Both are now public. The justification for
  exporting them is real (fitness's targets loader can use
  `readYamlFile` for the discovery field, tests need `LoggerImpl`),
  but the barrel doesn't communicate "advanced / discouraged for
  general use" — a third-party tool author scanning exports may pick
  `readYamlFile` for a structured-config use case it isn't suited
  for. SRP/ISP at the barrel layer.
- **Why it matters:** Cheap to mis-use. A tool that reads its own
  config via `readYamlFile` will silently swallow malformed-YAML
  errors and look healthy.
- **Recommendation:** Add a JSDoc `@remarks` block on each barrel
  re-export pointing to the file-level docstring's "use this only
  when…" guidance. Or, segregate them under a sub-export like
  `@opensip-tools/core/internal` so the discouragement is structural.
  Lower-cost: the doc comment in `index.ts:65-69` already does the
  right thing for `readYamlFile`; replicate for `LoggerImpl`.

### N3 — `RecipeRegistry<T>` accepts both `allowOverwrite` and `throwOnDuplicate` without explicit precedence
- **Severity:** P2.
- **Where:** `packages/core/src/recipes/registry.ts:92-114`. The
  JSDoc at `:88-91` says they are "Mutually exclusive with
  `allowOverwrite`" but the runtime never enforces this — if a caller
  passes both, `allowOverwrite: true` wins because the
  `if (isDuplicate && !allowOverwrite)` guard short-circuits before
  the `throwOnDuplicate` branch fires.
- **What:** Two flags interacting via a combined boolean condition,
  with a JSDoc claim of mutual exclusion that is not enforced. ISP/
  contract honesty — the API surface advertises a property the
  implementation doesn't enforce. (Same pattern issue as the prior
  audit's F9 `aliases` finding, on a smaller scale.)
- **Why it matters:** A caller that defensively sets both flags
  ("throw on duplicate unless I'm doing an explicit overwrite") gets
  the silent-overwrite path with no warning. Surprises the next
  reader.
- **Recommendation:** Either (a) throw `ValidationError` at the top
  of `register` when both are true, or (b) reword the JSDoc to
  describe the actual precedence (`allowOverwrite` wins, even if
  `throwOnDuplicate` is also set). (a) is the honest fix; the
  caller's invariant is structurally violated.

### N4 — `LoggerImpl.logDir` reserved-but-unread field
- **Severity:** P3.
- **Where:** `packages/core/src/lib/logger.ts:58-63`. `logDir` is
  assigned in `initLogFile` (`:112`) but never read anywhere on the
  class.
- **What:** Dead state preserved for "future getter" intent. SRP is
  fine but this is an unreferenced field; ESLint won't flag it
  because TypeScript private fields aren't tracked for read/write
  asymmetry.
- **Why it matters:** Cheap signal of unfinished refactor. The
  comment at `:58-62` documents the intent, which is good, but a
  reader of `LoggerImpl` reasonably expects every assignment to
  matter.
- **Recommendation:** Delete the field and the assignment; if a
  future getter wants the dir it can re-derive from
  `dirname(logFilePath)`. Cheaper than carrying a placeholder.

### N5 — `discoverNpmPackages` `pluginDir` parameter is unused
- **Severity:** P3.
- **Where:** `packages/core/src/plugins/discover.ts:172-214`. Param
  `pluginDir` is declared but the only reference is the
  `void pluginDir` no-op at `:210-211` ("kept for parity with prior
  log shape"). The caller at `:103` still threads it through.
- **What:** Vestigial argument. SRP — function signature carries a
  parameter the function doesn't use.
- **Why it matters:** A reader of the call site wonders why
  `pluginDir` is supplied. Removing it tightens the interface and
  drops the `void` placeholder.
- **Recommendation:** Drop `pluginDir` from
  `discoverNpmPackages`'s signature and the call site at
  `discover.ts:103`. One-line cleanup.

### N6 — `AUTO_CLEAR_MS` doc-comment drift in `parse-cache.ts`
- **Severity:** P3.
- **Where:** `packages/core/src/languages/parse-cache.ts:29` —
  `const AUTO_CLEAR_MS = 10 * 60 * 1000 // matches previous behavior`.
  The prior audit's F4 description claimed "60-second `setTimeout`";
  the actual value (and pre-Wave-4 value) is 10 minutes. Not a
  regression — just a doc drift in the prior audit that's now
  embedded in the source comment ("matches previous behavior" is
  vague).
- **What:** Stale comment. SRP/clarity — the comment should
  document the actual policy.
- **Recommendation:** Replace the comment with "10 minutes — the
  cache is regenerated on every fitness run, so 10 minutes of
  staleness is the worst case for a check author who edits the
  source between runs."

### N7 — `applyRegions` not part of the lang-typescript hot path; perf deferral assumes correctly
- **Severity:** P3 (note).
- **Where:** `packages/core/src/languages/strip-utils.ts:342-352`,
  `packages/languages/lang-typescript/src/filter.ts`.
- **What:** lang-typescript has its own `buildLineStarts` local
  helper (`filter.ts:52`) duplicating the core export
  (`strip-utils.ts:360-370`). The TS adapter is the perf-critical
  pack and it intentionally bypasses core's helpers, which is why
  `applyRegions` is not actually hot — confirming the Phase 7
  deferral. Still: the duplication itself is a small SRP smell.
- **Why it matters:** The lang-typescript adapter could call
  `buildLineStarts` from core directly; the local copy is one extra
  byte-identical function. Low priority because changing it touches
  another package, not core.
- **Recommendation:** Tracked in lang-typescript's own audit, not
  here. Noted for completeness.

## Findings missed by the prior audit

### M1 — `ToolError`'s `code` field claims to be `string` but subclasses pin specific values
- **Severity:** P2.
- **Where:** `packages/core/src/lib/errors.ts:14-21` declares
  `readonly code: string`; subclasses at `:24-71` each default to a
  specific code (`'VALIDATION_ERROR'`, `'NOT_FOUND'`,
  `'TIMEOUT'`, etc.) but the public type erases that specificity.
- **What:** A typed-error consumer that does
  `if (e.code === 'TIMEOUT')` has no static guarantee they're
  matching the right string — there's no exported union of valid
  codes. ISP/Result-pattern honesty: the contract advertises
  `code: string` even though every subclass narrows it to a literal.
- **Why it matters:** Opportunity for a typed `ToolErrorCode` union
  that consumers can switch on exhaustively. Today the only safe
  discriminator is `instanceof`, which works but loses the
  per-subclass `code` constants.
- **Recommendation:** Export a `ToolErrorCode` union literal type
  (`'VALIDATION_ERROR' | 'NOT_FOUND' | …`) and tighten each
  subclass's `code` field to its specific literal via a `readonly
  code: 'VALIDATION_ERROR'` override. Optional but cheap, and pays
  off the moment a consumer wants exhaustive-switch on `code`.

### M2 — `ToolCliContext.builtinLiveViews` is a covert tool-discovery channel that bypasses the registry pattern
- **Severity:** P2.
- **Where:** `packages/core/src/tools/types.ts:131-143`. The CLI
  hands each tool a map of pre-built renderers keyed by tool id; the
  tool's `register()` looks itself up by id and threads the renderer
  back into `cli.registerLiveView`.
- **What:** A registry-by-tool-id whose semantics are "first-party
  tools have a bundled renderer; third-party tools don't." That's a
  legitimate seam, but it's structurally an implicit Mediator/
  Service-Locator: the tool *queries* a bag of capabilities by its
  own id, instead of being *handed* its renderer at register time.
  Pattern: this is a Service Locator inside a registration-style
  API; the rest of the kernel uses Strategy/Registry where the
  collaborator is passed in directly.
- **Why it matters:** A first-party tool's `register(cli)` body has
  to know its own id matches the key the CLI used to populate the
  map (see `fitness/engine/src/tool.ts:112-114`). Misalignment is a
  silent no-op (no renderer registered → `UnknownLiveViewError` at
  call time, not at startup). It also means a third-party tool can
  read the entire map of first-party renderers, which is harmless
  today but architecturally is an over-broad surface.
- **Recommendation:** Either (a) replace `builtinLiveViews:
  ReadonlyMap<…>` with a `getBuiltinRenderer(toolId): LiveViewRenderer
  | undefined` function on `ToolCliContext` so the map shape is
  hidden; or (b) push the renderer into a per-tool init context
  (`tool.register(cli, ctx)`) so first-party tools never have to
  look themselves up by id. (b) is the cleaner long-term answer.

### M3 — `lib/yaml.ts` swallows YAML parse errors silently — no diagnostic logging
- **Severity:** P2.
- **Where:** `packages/core/src/lib/yaml.ts:36-44`. Catches every
  thrown error from `yaml.load` and returns `undefined`. No log
  line, no `evt`. Compare with the rest of core (`logger.warn({
  evt: 'lang.registry.duplicate', … })`), which emits structured
  logs on every "this is unusual" branch.
- **What:** The function is intentionally permissive (per the
  docstring), but "permissive" should not mean "silent" at the
  kernel layer. SRP — error handling is a concern; logging-on-
  unexpected is the kernel's idiom.
- **Why it matters:** A user who hand-edits
  `opensip-tools.config.yml` and introduces a syntax error will see
  zero plugins load and no clue why. The targets loader catches the
  same file later via its strict path, but plugin discovery silently
  no-ops first.
- **Recommendation:** Add a `logger.debug({ evt:
  'core.yaml.parse_failed', module: 'core:lib', filePath, error:
  String(error) })` in the catch. Debug-level so it doesn't spam
  production but is visible under `--debug`.

### M4 — `readPackageVersion` walks up to filesystem root on every call
- **Severity:** P3.
- **Where:** `packages/core/src/lib/package-version.ts:17-36`. Pure
  function, called once per Tool at metadata-construction time. No
  cache.
- **What:** SRP/perf. Each tool that calls
  `readPackageVersion(import.meta.url)` does a `package.json` walk
  up to root; for a deeply-nested workspace this is O(depth) syscalls
  per tool. Today there are 3 first-party tools so the cost is
  negligible — flagged because the helper is a public export and
  third-party tool authors will adopt it.
- **Why it matters:** Cheap to memoize by `metaUrl` if it ever
  becomes a hot path; today it's a freebie.
- **Recommendation:** Add a `Map<string, string>` cache keyed by
  `metaUrl`. Two lines. Defer if no profile flags it.

## Overall assessment

The package is in materially better shape than the 2026-05-22
baseline. Eight of ten prior findings are CLOSED with tests; the
two deferrals (F7, F8, F10) are documented and appropriate.
Wave 1–4 added the `registerLiveView` contract, `Logger` interface,
`LanguageParseCache.dispose()`, and the C-family lexer scaffolding
without regressing existing patterns. The net-new findings are all
P2/P3 polish — the singleton's concrete-class typing (N1), the
`RecipeRegistry` flag-precedence wording (N3), the silent
`readYamlFile` (M3), and a service-locator-shaped seam in
`ToolCliContext.builtinLiveViews` (M2). None block downstream work;
N1 and M3 are the highest-leverage clean-ups for a follow-up PR.
Core remains a small, strict kernel with a coherent set of
patterns (Registry × 3, Strategy via `LanguageAdapter`, Result +
typed errors, Factory functions for IDs and Signals, generic
`RecipeRegistry<T>` shared by tools), and the layer rules are
respected.
