# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] — 2026-05-14

Architecture refactor. opensip-tools is now a true tool-plugin platform —
a kernel + a Tool contract + first-party fitness and simulation tools.
Adding a third tool is "write a Tool, install the package."

### Added

- **`@opensip-tools/fitness`** (new package, v2.0.0) — extracted from
  `@opensip-tools/core`. Holds the fitness engine (defineCheck, recipes,
  framework, signalers, targets, types/findings, gate, SARIF reporting,
  fit/dashboard/list-checks/list-recipes commands). 188 tests.
- **`@opensip-tools/cli-shared`** (new package) — CLI types, exit codes,
  session persistence, dashboard HTML generator. Tools depend on this
  for shared CLI infrastructure without taking a hard dep on the CLI
  entry point.
- **Tool plugin contract** in `@opensip-tools/core/tools` —
  `Tool { metadata, commands, register(cli), initialize? }`. Tools mount
  their own Commander subcommands via `register(cli)`; the CLI walks
  `defaultToolRegistry` and never imports tool-specific code directly.
- **Auto-discovery for tool packages** — any npm package whose
  `package.json` declares `opensipTools.kind === 'tool'` is loaded by
  the CLI on startup. Walks ancestor `node_modules/` directories,
  matching Node's resolution algorithm.
- **dependency-cruiser** with architecture rules encoding the layer
  order (core → cli-shared → fitness/simulation/lang-* → checks-* →
  cli). Forbidden edges fail CI.
- **ESLint flat config** with `typescript-eslint:recommendedTypeChecked`,
  `eslint-plugin-sonarjs`, `eslint-plugin-unicorn`, `eslint-plugin-import`.
  Workspace runs at 0 errors.
- **knip** for orphan / dead-export detection. Workspace runs at 0
  findings.
- **Multi-language fitness checks** — Rust, Python, Java, Go, C/C++
  language packs with hand-written lexers (or clang-tidy command mode
  for C/C++). 158 checks total across the typescript / universal /
  per-language packs.
- **Scope-resolver fix**: scope-empty checks (e.g. `file-length-limit`)
  now honor the project config's `globalExcludes`. Previously the
  fileCache fallback path returned every prewarmed file regardless of
  exclusion config — causing findings inside `docs/`, `tests/fixtures/`,
  etc. (D14 in the multi-language decisions log.)
- **No-checks-loaded warning** — silent zero-checks runs are now
  impossible. The CLI prints to stderr if no check packages registered.

### Changed — BREAKING

- **`@opensip-tools/core` is now a strict kernel.** Every fitness symbol
  (`defineCheck`, `Check`, `CheckRegistry`, `defaultRegistry`,
  `FitnessRecipeService`, `FitnessRecipeResult`, `Finding`, `Severity`,
  `loadTargetsConfig`, `loadSignalersConfig`, `buildScopeBasedFileMap`,
  `parseSource`, `walkNodes`, `getLineNumber`, etc.) moved to
  `@opensip-tools/fitness`. Plugin authors must update imports:
  ```ts
  // before
  import { defineCheck } from '@opensip-tools/core';
  // after
  import { defineCheck } from '@opensip-tools/fitness';
  ```
- **CLI no longer hardcodes any check pack import.** What was
  `@opensip-tools/checks-builtin` (deleted) is now split into
  `@opensip-tools/checks-typescript` (66 TS-AST checks) and
  `@opensip-tools/checks-universal` (92 cross-language checks). Both
  are auto-discovered.
- **`FitPluginExports` interface moved to `@opensip-tools/fitness`.**
  Tool-package-discovery is in core; check-package-discovery is in
  fitness (it's fitness-specific).
- **Workspace layout reorganized** to `packages/<tool>/<pkg>/`:
  ```
  packages/lang-*               → packages/languages/lang-*
  packages/fitness              → packages/fitness/engine
  packages/checks-*             → packages/fitness/checks-*
  packages/simulation           → packages/simulation/engine
  ```
  npm package names are unchanged — pure DX cleanup. The new check
  packs (`checks-python/go/java/cpp`) live alongside `checks-typescript`
  and `checks-universal` under `packages/fitness/`.
- **`@opensip-tools/cli` shrinks from 627 to ~430 lines.** All
  fitness-specific command implementations (fit, dashboard, list-checks,
  list-recipes) and the gate / SARIF code moved to
  `@opensip-tools/fitness`. The CLI is now a tool dispatcher with
  argv setup, the rendering layer, and cross-tool housekeeping
  commands (init, plugin, sessions, configure, completion, uninstall).

### Removed — BREAKING

- **`@opensip-tools/checks-builtin`** (was the v1.0.0 package) —
  replaced by `@opensip-tools/checks-typescript` (TS-AST checks) and
  `@opensip-tools/checks-universal` (text/regex/glob checks). No
  deprecation alias; consumers update their `package.json` directly:
  ```json
  // before
  "dependencies": { "@opensip-tools/checks-builtin": "^1.0.0" }
  // after
  "dependencies": {
    "@opensip-tools/checks-typescript": "^2.0.0",
    "@opensip-tools/checks-universal": "^2.0.0"
  }
  ```

### Fixed

- **`globalExcludes` now flows into scope-empty checks.** Fixes a
  regression introduced when scope-empty checks (file-length-limit)
  were first added — they bypassed the project config's exclude list
  by reading directly from the prewarmed file cache. (D14.)
- **Cleaned up ~700 ESLint violations and ~12 truly-dead source files.**
  Build/test/parity all green; check pack behavior unchanged.

### Migration from 1.0.0

1. In any package depending on `@opensip-tools/core` for fitness
   symbols, add `@opensip-tools/fitness` and switch the imports:
   ```ts
   import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';
   ```
2. If you depended on `@opensip-tools/checks-builtin`, replace it
   with `@opensip-tools/checks-typescript` + `@opensip-tools/checks-universal`.
3. If you implement a Tool plugin, the contract is in
   `@opensip-tools/core/tools`. See `packages/fitness/engine/src/tool.ts`
   for a worked example.

## [1.0.0] — 2026-05-14

### Changed — BREAKING

- **`@opensip-tools/checks-builtin` deleted; split into two packages:**
  - **`@opensip-tools/checks-typescript`** (new, 66 checks) — checks
    that import the TypeScript compiler API or are conceptually only
    meaningful in a TS/Node ecosystem (drizzle-orm, typed-inject, react,
    package.json#exports, tsconfig).
  - **`@opensip-tools/checks-universal`** (existing, re-versioned) — 92
    checks that operate on raw text, regex, file globs, or
    language-agnostic config (Docker, .env, Sentry, generic structure).
- **CLI decoupled from any privileged check pack.** The hardcoded
  `await import('@opensip-tools/checks-builtin')` is gone. Every check
  package goes through the same `discoverCheckPackages()` path. The
  plugin contract gained `FitPluginExports.checkDisplay` so packages
  contribute their own display names; the CLI merges from every
  loaded pack.
- **Auto-discovery of `@opensip-tools/checks-*` packages.** The CLI
  scans `node_modules/` and ancestor `node_modules/` for any package
  in the `@opensip-tools/checks-*` namespace and loads them. Override
  via `plugins.checkPackages: [...]` in the project config or opt
  out via `plugins.autoDiscoverChecks: false`.
- **No-checks-loaded warning.** Silent zero-checks runs are now
  impossible — the CLI prints to stderr if no check packages
  registered.

### Migration

Replace `@opensip-tools/checks-builtin` in your `package.json` with
`@opensip-tools/checks-typescript` + `@opensip-tools/checks-universal`.

## [0.6.1] — 2026-05-07

### Fixed (`@opensip-tools/checks-builtin`)

- **`async-patterns` and `batch-operations`** — split the strip-comments
  preprocessing between per-match scanning and bounded-pattern
  detection. The 0.6.0 narrowings ran the full strip (including
  comments) for both, which caused new false positives on files where
  the bounded indicator was a comment (e.g.
  `assessment-runner/heartbeat-manager.ts`). Per-match scanning still
  strips comments to avoid JSDoc FPs; bounded-pattern detection now
  runs on original content to preserve operator hints.

## [0.6.0] — 2026-05-07

### Removed (`@opensip-tools/checks-builtin`) — BREAKING

Four checks have been removed from the default recipe because their
false-positive rate on idiomatic TypeScript codebases consistently
exceeded the bar for a built-in. Each was either opinion-based
("naming should be 3+ characters"), enforced an arbitrary numeric
cutoff ("functions should have ≤5 parameters"), or guarded a class of
bugs that doesn't meaningfully occur in practice ("exported objects
should be frozen"). Customers running `opensip-tools fit` against a
typical TypeScript repo would see a wall of false positives on day 1
— a poor first-impression experience that trains users to ignore
warnings rather than act on them.

- **`clean-code-naming-quality`** — flagged `EventEmitter.on`,
  `Drizzle.Tx`, `IO`, `OS`, `UI`, and any other short identifier as a
  violation of "min 3 characters". The allowlist needed to match the
  canonical short names of every TypeScript codebase. Naming is too
  team-specific to enforce by default.
- **`clean-code-function-parameters`** — flagged any function with >5
  parameters. Real APIs (DI constructors, Fastify handlers, LLM tool
  definitions) legitimately have wider signatures. The 5-param cutoff
  is a Robert C. Martin opinion, not a precision rule.
- **`mutable-exported-constants`** — defensive theater. Mutation of
  an exported object literal is rare in practice, and TypeScript's
  `Readonly<T>` + `as const` already provide compile-time protection
  for the real risk. The check fired on every codebase using
  `Object.freeze` (the canonical immutability primitive) until it
  was patched, then continued to flag legitimate frozen objects.
- **`god-function-detection`** — used arbitrary cyclomatic-complexity
  cutoffs (warning ≥18, error ≥20) that don't correlate with real
  bugs. Long functions are sometimes correct; complexity scores
  measure the wrong thing.

If a team wants any of these patterns enforced, they can re-add the
check as a workspace plugin under their own recipe — but they
shouldn't be defaults.

### Improved (`@opensip-tools/checks-builtin`) — Precision narrowings

A round of false-positive narrowings landed alongside the removals.
Every change shipped with at least one regression test asserting the
check does NOT fire on the previously-misidentified pattern.

- **`error-handling-quality`** — empty-catch detection iteratively
  strips leading single-line and block comments before testing for
  empty body. Previously, a catch with `// @fitness-ignore` followed
  by a real handler call was flagged as silently swallowing because
  the regex only checked the first character.
- **`api-contract-validation`** — skip "missing try-catch" warning
  for `handle*Error` and `process*Error` functions. These are
  themselves error translators called from inside a catch block;
  requiring another try-catch around them is error-handling
  inception.
- **`interface-implementation-consistency`** — skip "extra method"
  warning for classes named `Fake*`, `Mock*`, `Stub*`, `Spy*`. Test
  doubles intentionally extend the production interface with helper
  methods (`queueError`, `setEvents`, `reset`).
- **`async-patterns` (detached-promises)** — recognize `outer(await inner())`
  as a sync wrapper around an awaited promise. Previously flagged
  every `unwrap(await x)` pattern as detached.
- **`performance-anti-patterns`** — sequential-await detection skips
  retry/backoff loops where any of `await delay|sleep|wait|setTimeout|backoff|pause`
  appears in a 30-line forward window. Spread and string-concat
  detectors are unchanged.
- **`toctou-race-condition`** — full AST rewrite. Previously a
  regex-only check that paired any `.get(...)` with any `.set(...)`
  regardless of receiver. New detection classifies calls by receiver
  identity, recognizes local in-memory `Map`/`Set` collections,
  in-process cache fields (`this.cache`, `this.#cache`,
  `this.<X>Cache`), parameters typed `*Cache`, and atomic SQL
  writes (`tx.update`, `tx.execute(sql\`UPDATE ...\`)`).
- **`dead-code`** — Knip's per-issue path is now propagated to the
  violation record's `filePath`, so dead-dep warnings in a monorepo
  surface against the sub-package's `package.json` instead of
  collapsing onto root.
- **`duplicate-utility-functions`** — recognizes intentional
  variation (different generic constraints, side-effect profiles).
- **`test-file-naming`** — accepts `*-helper.ts` and `*-helpers.ts`
  suffix conventions alongside the canonical `*-test-setup.ts`.

### Migration

Customers on `0.5.x` who relied on any removed check should add the
check back as a workspace-local plugin or pin to `0.5.x`. No code
changes are required for the precision narrowings — they only
reduce noise.

## [0.5.0] — 2026-05-05

### Removed (`@opensip-tools/core`) — BREAKING

- The deprecated `contentFilter: 'code-only'` and
  `contentFilter: 'no-strings-no-comments'` aliases are removed.
  Migrate to the canonical names introduced in 0.4.0:
  - `'code-only'`              → `'strip-strings'`
  - `'no-strings-no-comments'` → `'strip-strings-and-comments'`
  Mapping is mechanical — same dispatch, same behaviour, just the
  spelling changes.

  Consumers of `@opensip-tools/core` who passed either old name to
  `defineCheck({ contentFilter, ... })` or to `createFileAccessor(...,
  { contentFilter })` will see a TypeScript narrowing error and a Zod
  validation rejection at runtime.

  Why now: `code-only` described intent, not behaviour, and the
  resulting confusion produced a real false-positive bug
  (`audit-sink-direct-use` firing on its own JSDoc) before the rename.
  Keeping the alias indefinitely would invite the same confusion to
  recur. The 0.4.0 release shipped both forms so consumers had a clean
  migration window; that window closes here.

## [0.4.0] — 2026-05-05

### Added (`@opensip-tools/core`)

- New `contentFilter` mode names that describe what the filter strips:
  - `'strip-strings'` — string literals blanked, comments preserved
    (use when a check reads comment-based directives like `// @swallow-ok`,
    `// @fitness-ignore-...`, or `@deprecated` JSDoc tags).
  - `'strip-strings-and-comments'` — both strings and comments blanked
    (use when a check pattern-matches identifiers that would false-fire
    if the same phrase appears in JSDoc / inline comments documenting
    the rule itself).

  The previous names (`'code-only'`, `'no-strings-no-comments'`)
  described intent rather than behaviour and were misleading enough to
  cause real false positives — `code-only` strips strings but PRESERVES
  comments, which most rule authors didn't expect from the name.

### Changed (`@opensip-tools/checks-builtin`)

- 82 built-in checks migrated to the new `strip-strings` /
  `strip-strings-and-comments` names.

### Deprecated (`@opensip-tools/core`)

- `contentFilter: 'code-only'` — use `'strip-strings'` instead (same
  dispatch, no behaviour change).
- `contentFilter: 'no-strings-no-comments'` — use
  `'strip-strings-and-comments'` instead (same dispatch).

  Both old names continue to work as aliases. Plan to remove in 0.5.0.

### Fixed (`@opensip-tools/checks-builtin`)

- `resilience/no-process-exit-in-finally` no longer false-fires on
  files that use `Promise.prototype.finally(...)` without a try/finally
  clause. The detection regex now requires `} finally {` brace
  adjacency rather than matching the bare word `finally`.
- `architecture/module-coupling-fan-out` no longer flags pure barrel
  files (only `export ... from` re-exports) or type-declaration files
  (`.d.ts`, `.test-d.ts`). Both are exempt by design — barrels fan out
  on purpose; type imports compile to nothing.

## [0.3.0] — earlier

(Release notes were not captured at the time. Includes various
infrastructure improvements over 0.2.5; see git log for details.)

## [0.2.5] — 2026-05-04

### Security

Users on 0.2.4 and earlier should upgrade. Three issues in plugin discovery
allowed code outside the plugin directory to be loaded and executed:

- **Path traversal in plugin discovery** (`@opensip-tools/core`). A malicious
  `.opensip-tools/fit/package.json` (or `~/.opensip-tools/fit/package.json`)
  with a dependency key like `"../../etc/passwd"` would resolve outside the
  plugins' `node_modules/` and the matching file could be dynamically
  imported. Now: dependency names containing `..`, leading `/`, or NUL bytes
  are rejected before any filesystem access, and resolved package paths are
  containment-checked against `node_modules/` via `realpathSync`.
- **Symlink follow in loose-file plugin discovery** (`@opensip-tools/core`).
  A symlink in `~/.opensip-tools/fit/` (or a project-local plugin dir)
  pointing to an arbitrary file outside the plugin dir would be loaded as a
  plugin and dynamically imported. Now: loose-file plugin paths are
  containment-checked against the plugin dir; pnpm-style symlinks that
  resolve inside the plugin dir continue to work.
- **Silent plugin load failure** (`@opensip-tools/cli`). When a plugin failed
  to import, errors were printed to stderr but the run still exited 0 with
  `passed: true` if no checks failed. A malicious or broken plugin could
  therefore suppress its own checks (including compliance-required checks)
  while CI reported success. Now: any plugin load error sets `passed: false`
  and produces a non-zero exit code.

### Tests

- Added 5 regression tests in `core/src/plugins/__tests__/discover.test.ts`
  covering `..` traversal, absolute-path names, NUL-byte names, escaping
  symlinks, and pnpm-legitimate symlinks.

## [0.3.0] — 2026-05-04

### Security

- **Plugin install no longer runs npm lifecycle scripts.** All three
  `npm install` invocations (project-local sync, user-level `plugin install`,
  and peer-dep auto-install) now pass `--ignore-scripts`. Without this,
  `opensip-tools fit` running in a freshly cloned repo with declared
  plugins would auto-install them and execute their `postinstall` /
  `preinstall` / `prepare` scripts before the user had any chance to
  inspect what was being installed. Plugins are loaded via dynamic
  `import()` at fit time, so legitimate plugin code paths are unaffected;
  only install-time side-effects are blocked.

### Performance

- **Shared AST parse cache for checks-builtin.** 10 AST-based checks
  (`circular-imports`, `deep-inheritance`, `export-complexity`,
  `fan-out-complexity`, `import-graph`, `interface-bloat`, `logger-detector`,
  `method-complexity`, `missing-error-handling`, `type-assertion-overuse`)
  now call `getSharedSourceFile()` instead of `ts.createSourceFile()`.
  Files parsed by multiple checks in the same run are parsed once and
  reused from an LRU cache, reducing CPU and memory overhead proportional
  to the number of co-running AST checks.

### Fixed

- **`withRetry` tolerates NaN / non-finite `maxAttempts`.** Passing
  `maxAttempts: NaN` (or `Infinity`, `-1`) previously caused an infinite
  retry loop. Now clamped to `max(1, floor(n))` with a `Number.isFinite`
  guard; non-finite inputs default to a single attempt.
- **ULID `extractTimestamp` handles multi-underscore ID prefixes.** The
  old implementation split on the first `_`, so IDs like
  `fitness_check_01JPHK...` returned a garbage substring. Now uses
  `id.slice(-26)` to always extract the last 26 characters (the canonical
  ULID component), regardless of prefix length or underscore count.
- **`filterCache` idle timer bounds memory growth.** The content-filter
  cache had no eviction path: after a large scan the filtered-content map
  would stay in memory for the process lifetime. A 10-minute idle timer
  (matching the parse-cache pattern) now clears the map when no new files
  are being scanned, returning memory between runs without affecting
  correctness.

### Observability

- Structured log events for all fitness check lifecycle stages now carry a
  `module: 'fitness:execution'` field, making it straightforward to filter
  check-level traces in log aggregators.
- All CLI-level logger calls in `cli:fit`, `cli:gate`, `cli:report`,
  `cli:persistence`, and `cli:bootstrap` now include a `module:` field,
  enabling per-component log filtering.
- `cli.plugin.autosync.start` and `cli.plugin.autosync.failed` events
  are now emitted when the CLI transparently installs project-local
  plugins, surfacing install activity and per-domain failures in
  structured logs.


### Added
- Ink-based CLI rendering with themed components (React for terminals)
- Commander.js for argument parsing with auto-generated `--help`
- `opensip-tools dashboard` — top-level HTML report command
- `opensip-tools sessions list` — view run history
- `opensip-tools sessions purge` — delete session data with confirmation
- `--verbose` flag shows detailed results table (default is compact summary)
- `--findings` flag shows per-check violation details
- `--debug` flag outputs structured JSON logs to stderr
- `--report-to` sends findings as SARIF 2.1.0 with retry on failure
- `failOnErrors` / `failOnWarnings` config for CI exit code control
- Structured JSON logging with ULID run IDs to `~/.opensip-tools/logs/`
- Theme system with terminal capability detection (NO_COLOR, tmux, truecolor)
- Shared animation clock for spinner
- `RunHeader` component showing tool info between banner and content
- Custom check plugin support via `~/.opensip-tools/fit/`
- `itemType` support in `defineCheck()` for accurate validated column display
- `withRetry()` utility for network calls with exponential backoff
- Result pattern (`ok()`, `err()`, `tryCatchAsync()`) in core
- `NetworkError`, `ConfigurationError` typed error classes
- ULID-based ID generation (`generatePrefixedId()`, `extractTimestamp()`)

### Changed
- CLI output layer migrated from raw console.log to Ink components
- Default `fit` output is now a single summary line (was full table)
- Score and PASS/FAIL removed from summary — data speaks for itself
- `Ignored` renamed to `Ignores` in table and summary
- `Validated` column shows human-readable format (`450 files`, `13 packages`, `—`)
- Replaced `successThreshold` with `failOnErrors`/`failOnWarnings`
- 3rd party tool checks auto-detect package manager (pnpm > yarn > npm)
- Knip dead-code check uses default config discovery (no hardcoded path)
- Missing tool detection: shows "{tool} is not installed" instead of cryptic errors

### Removed
- `opensip-tools asm` command and `@opensip-tools/assess` package
- 28 OpenSIP-specific fitness checks (moved to community plugin)
- 6 OpenSIP-specific tool checks (hardcoded paths)
- 3 OpenSIP-specific assessments
- `fit --dashboard` (replaced by top-level `dashboard` command)
- `fit --history` (replaced by `sessions list`)
- Score-based pass/fail from summary display
