# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.10.0] — 2026-05-18

A performance-focused release for `@opensip-tools/graph`. Implements
[`docs/plans/graph-performance-improvements.md`](docs/plans/graph-performance-improvements.md)
waves 1–4. Driven by an OpenSIP measurement run (5476 files) that
OOM'd Node's default 4 GB heap and took ~25 minutes under a 12 GB
heap.

### Added

- **`graph --packages`** — fan a graph run across every workspace
  package under `packages/**` with a `tsconfig.json`. One child
  process per package, concurrency capped at `cpus()-1`. Aggregates
  per-package findings into a unified report. On the opensip-tools
  self-graph (18 packages), a parallel run is ~2.3× faster than the
  global run with no fidelity change. `--packages-concurrency <n>`
  overrides the cap.

- **`graph --package <name|path>`** — scope a graph run to a single
  workspace package's tsconfig. Per-package runs typically complete
  in seconds and fit in the default Node heap; cross-package call
  sites become unresolved (lower fidelity, much faster). Searches
  `packages/**` for a basename match, or accepts an explicit
  directory path.

- **Heap-sizing hint at startup** — when `discoverFiles` returns
  more than 1000 files, `graph` emits a one-line stderr hint
  recommending `NODE_OPTIONS=--max-old-space-size=8192` (or higher
  for very large monorepos). Below the threshold, silent.

### Changed

- **`graph` stage 1+2 fused into a single AST walk per file**
  ([`packages/graph/engine/src/pipeline/walk.ts`](packages/graph/engine/src/pipeline/walk.ts)).
  Legacy pipeline walked every file twice — once to emit function
  occurrences, once to find and resolve call sites. The unified walk
  emits both in one descent and feeds the call-site list to
  `resolveEdgesFromRecords` for resolver dispatch. Eliminates the
  redundant `hashFunctionBody` calls Stage 2's `hashOf` previously
  performed on every function-shape. Catalog output is byte-identical
  to the pre-refactor pipeline.

- **`graph` cache is now incrementally updated.** Previous behaviour
  was binary: any file change → full rebuild. New behaviour:
  `classifyCatalog` returns `valid | incremental | invalid`; on
  `incremental`, the orchestrator re-walks only the changed files
  plus their transitive edge-dependents and merges with cached
  entries from unchanged files. Iterates to fixpoint so no cached
  edge dangles. Editing a single file in the opensip-tools self-
  graph drops rebuild time from ~15 s (full) to ~2.5 s (incremental,
  ~6×) with byte-identical output. `--no-cache` still forces a full
  rebuild.

- **Streamed catalog write** — `cache/write.ts` emits the catalog
  metadata via `JSON.stringify` with a sentinel placeholder for the
  `functions` field, then writes the functions map entry-by-entry
  via `writeSync`. Bounds the write peak by the largest single
  occurrence array rather than the full catalog. Output is
  byte-identical to the legacy `JSON.stringify(_, null, 2)` path so
  existing on-disk caches stay valid.

- **Slice-not-getText for body hashing** — `digestFunctionBody` uses
  `sourceFile.text.slice(start, end)` instead of
  `node.getText(sourceFile)`, avoiding the per-call AST walk that
  materialises a fresh string. Identical hash output.

- **TypeScript `Program` is freed before serialization** —
  orchestrator's stage 1+2 work is scoped so the program reference
  becomes unreachable as soon as edge resolution returns. With
  ~3000+ files the program plus its bound symbol table is ~1–2 GB;
  freeing it before stages 3–5 (indexes, rules, serialization) keeps
  peak resident lower.

### Internal

- New module: [`packages/graph/engine/src/pipeline/walk.ts`](packages/graph/engine/src/pipeline/walk.ts)
  (unified Stage 1+2 walk).
- New module: [`packages/graph/engine/src/cli/scope.ts`](packages/graph/engine/src/cli/scope.ts)
  (`--package` and workspace-discovery resolution).
- New module: [`packages/graph/engine/src/cli/packages-runner.ts`](packages/graph/engine/src/cli/packages-runner.ts)
  (`--packages` parallel runner).
- `cache/invalidate.ts` gains `classifyCatalog` and `diffFingerprints`;
  `isCatalogValid` retained as a back-compat boolean wrapper.
- `cli/orchestrate.ts` gains `obtainCatalog` (cache verdict
  dispatch), `buildAndResolveCatalogIncremental` (Wave 4),
  `expandClosureToFixpoint`, `mergeOccurrences`, and
  `restoreCachedCalls`.
- Phase 5 (lazy typechecker init) was spiked and rejected: the
  apparent ~12× speedup was an artefact of stale-cache comparison
  and the binder cost simply shifts to Stage 2's first
  `getSymbolAtLocation` call. Eager `program.getTypeChecker()` in
  Stage 1 is retained.
- Architecture docs updated under [`docs/architecture/40-the-graph-loop/`](docs/architecture/40-the-graph-loop/)
  and [`docs/architecture/70-surfaces/01-cli-command-tree.md`](docs/architecture/70-surfaces/01-cli-command-tree.md)
  to reflect the fused walk, incremental rebuild, `--package` /
  `--packages`, and updated catalog shape (`bodySize`,
  `discarded`). Dead links to retired plan docs (`graph-tool-v2-design`,
  `graph-rule-enhancements`, `graph-dashboard-v3-design`,
  `tool-version-from-package-json`) replaced with live references.

## [1.1.0] — 2026-05-17

> **DRAFT — please review and rewrite the framing before tagging.** The
> lead bullet under _Added_ should reflect how you want users to
> perceive `@opensip-tools/graph`: as a first-class third tool, or
> still flagged experimental like `sim` has been.

### Added

- **`@opensip-tools/graph` — new tool package**, the third first-party
  Tool alongside `fit` and `sim`. Static call-graph + dead-end analysis
  with a six-stage staged pipeline and an interactive HTML dashboard
  (`graph dashboard`). Dashboard views shipped: Function Card overlay,
  fuzzy Search, Hot Functions, Big/Wide functions, Untested, SCCs
  (Tarjan), Coupling heat map, plus collapsible filter chips, hash
  routing, editor deep-links from entry, and a slide-out per-tab help
  drawer. Initial gate baseline is committed at
  `opensip-tools/graph/baseline.json` so the tool can gate itself in CI
  from day one.

- **Coverage gate at ≥90%** across the engine and language packs:
  `@opensip-tools/core`, `fitness`, `simulation`, `graph`, `lang-rust`,
  `checks-typescript`, `checks-universal`, and exported helpers in
  `checks-{cpp,go,java,python}`. Exercises previously-uncovered
  exported surfaces, not synthetic coverage padding.

### Fixed

- **`defineRecipe` is now exported from `@opensip-tools/fitness`.**
  The helper was used internally but never re-exported through the
  package barrel, blocking out-of-tree recipe authors. The
  `chaos-executor` doc reference was corrected at the same time.

- **Tool `metadata.version` no longer drifts from package.json.**
  All three first-party Tools (`fitness`, `simulation`, `graph`) now
  read their version from package.json at module-load time via a new
  `readPackageVersion(import.meta.url)` helper exported from
  `@opensip-tools/core`. Previously the version was a hardcoded
  literal in each `tool.ts`; `fitness` and `simulation` reported
  `'1.0.0'` through several releases because nothing forced a sync
  on bump. `fitness` and `simulation` now have contract tests
  matching `graph`'s, so drift is caught at test time rather than at
  release time. Implements the proposal in
  `docs/plans/tool-version-from-package-json.md`.

### Internal

- Architecture-doc audit completed across passes 15–21 (worktree-arch-
  audit branch merged). Fixes include: stale section path refs, stale
  17-package counts, per-language pack contents accuracy, README
  headings + `configuration.apiKey` + plugin-loader `projectDir`
  surfaces, ignore-directive comment forms, paginated (not capped) Code
  Paths views, invariant scenarios documented as workflow integration
  (not property-based), and lang-rust adapter description.
- Release plumbing updated for the third tool: `RELEASING.md`,
  `.github/workflows/release.yml` (preflight, pack, publish steps),
  and `tools/bootstrap-publish.sh` now account for 18 packages
  including `@opensip-tools/graph`.

## [1.0.10] — 2026-05-16

### Added

- **`opensip-tools uninstall --project [path]`** — project-local
  cleanup. Removes both `<path>/opensip-tools/` (user-authored checks +
  recipes and the gitignored `.runtime/` cache) and
  `<path>/opensip-tools.config.yml`. Path defaults to cwd; pass
  `--project /path/to/repo` to target another location. Refuses to run
  when neither target exists at the resolved path, so an accidental
  `--project /unrelated/dir` is a no-op rather than a destructive
  accident. Both modes support `--dry-run` and `--yes`.

- **Updating & uninstalling section** in `README.md` plus a forward-
  link from Quick start. Documents the three independent removal steps
  (project state, user-level config, npm-global binary), the
  state-lives table, the daily update-notifier behaviour, and the
  `OPENSIP_NO_UPDATE` / `NO_UPDATE_NOTIFIER` opt-outs.

### Fixed

- **`~/.opensip-tools/` is now reserved for `config.yml` only.**
  `@opensip-tools/contracts/persistence/store` and
  `@opensip-tools/core/lib/logger` previously defaulted to writing
  sessions, reports, and logs under the home directory if no caller
  bootstrapped them — letting the user-level dir accumulate state that
  the documented architecture said only ever held config. The
  fallbacks are gone; persistence APIs throw if used before
  `configurePersistencePaths()` and `initLogFile(dir)` requires its
  `dir` argument at compile time. Any pre-existing
  `~/.opensip-tools/{sessions,reports,logs,fit}` dirs are legacy cruft
  and are swept up by `opensip-tools uninstall`.

- **Stale `--force` flag in the architecture docs.** The
  `docs/architecture/60-surfaces/01-cli-command-tree.md` uninstall
  section documented a `--force` option; the actual flag has always
  been `--yes` / `-y`. Section rewritten to match reality and document
  the new `--project` mode.

## [1.0.9] — 2026-05-16

### Fixed

- **Per-check recipe config now reaches the check.** The
  `getCheckConfig(slug)` plumbing in `@opensip-tools/fitness` stored
  the recipe-service-supplied config map on a module-local `let` —
  which meant the CLI's bundled `@opensip-tools/fitness` (running the
  recipe service) and the plugin pack's resolved
  `@opensip-tools/fitness` (running the check + calling
  `getCheckConfig`) saw separate module-scope state. The recipe's
  `additionalSyncFunctions` / `additionalSelfDocumentingSuffixes` /
  `additionalSafeTOCTOUPaths` allowlists were silently never reaching
  the checks that read them — detached-promises / throws-documentation
  / null-safety / toctou-race-condition warned on every project-
  declared safe call site despite the recipe authoring them.

  The fix hoists the slot onto a `Symbol.for('@opensip-tools/fitness/
  currentRecipeCheckConfig')` entry on `globalThis`, so every loaded
  copy reads + writes the same well-known slot regardless of which
  package instance imported the module. The single-session contract
  (recipe service throws SESSION_IN_PROGRESS for concurrent runs) is
  unchanged; only the storage location moves.

  Regression coverage added in
  `recipes/__tests__/check-config.test.ts` — simulates "two copies"
  by reading `globalThis[Symbol.for(...)]` after `set`, confirming
  the value lands at the shared slot.

## [1.0.8] — 2026-05-16

### Fixed

- **Directive parser now recognises Markdown (`<!--`) and shell/YAML
  (`#`) comment prefixes.** Pre-1.0.8 `extractCheckIdFromDirective` in
  `@opensip-tools/fitness` only matched `//` and `/*` openers, so
  `@fitness-ignore-file <slug>` / `@fitness-ignore-next-line <slug>`
  pragmas inside Markdown documents, HTML files, YAML configs, shell
  scripts, and Python were silently ignored — the file got scanned
  despite the author's intent. Authors hit this when trying to
  suppress `file-length-limit` on intentionally-long doc-set
  catalogues (DEC indices, metric taxonomies) where the only natural
  comment syntax is `<!-- ... -->`. The fix extends the comment-prefix
  table to include `<!--` (4 chars) and `#` (1 char) alongside the
  existing `//` and `/*`. Eight new regression tests in
  `directive-parsing.test.ts` cover the four supported prefixes plus
  the rejection of unsupported forms (`;`, plain text).

## [1.0.7] — 2026-05-16

### Fixed — false-positive triage

Four built-in checks were producing high-rate false positives against
real-world TypeScript codebases. Each fix tightens the heuristic
without losing real-bug coverage; regression tests pin the FP cases.

- **`sql-injection`** (`@opensip-tools/checks-typescript`)
  - `SQL_CLAUSE_PATTERN` was case-insensitive — `/\b(?:WHERE|AND|OR|
    SET|VALUES)\b/i` matched the English words "and"/"or"/"set"/"where"
    inside CLI help text (`cli.info('Usage: ...\n' + '...and continues
    here\n')`), producing one error per concatenated help-string. Now
    case-sensitive; real SQL conventionally uppercases these.
  - Arm-3 (right-side string + clause keyword) now requires the SAME
    `+` chain to contain a real SQL keyword (`SELECT|INSERT|UPDATE|
    DELETE|...`) somewhere. Closes the residual FP where uppercase
    "AND" appears in non-SQL text.
  - Both template-literal and concat arms now skip arguments to
    output methods (`cli.info`, `console.log`, `logger.warn`, …).
    These call sites carry user-facing text, never SQL.
  - Extracted `analyzeSqlInjection(content, filePath)` as a top-level
    function for direct test invocation; added 7-test FP regression
    suite in `__tests__/sql-injection.test.ts`.

- **`context-mutation-check`** (`@opensip-tools/checks-typescript`)
  - Flagged `ctx.X = value` mutations even when `ctx` was a locally-
    declared `const`/`let`/`var` (object-construction pattern), not
    a shared request context. Now scans the file for local
    declarations of `ctx`/`context` via `LOCAL_DECLARATION_PATTERNS`
    and skips mutations rooted at locally-declared names.
  - Extracted `analyzeContextMutation` for direct test invocation;
    added 4-test FP regression suite.

- **`no-hardcoded-secrets`** (`@opensip-tools/checks-universal`)
  - Matched secret patterns inside REGEX LITERALS (the file IS the
    redactor — `[/-----BEGIN PRIVATE KEY-----.../g, replacement]`)
    and inside REDACTION PLACEHOLDERS (`'-----BEGIN PRIVATE KEY-----
    ***-----END PRIVATE KEY-----'`). Now adds two filters:
    `isInsideRegexLiteral(line, pos)` and `lineHasRedactionPlaceholder
    (line)` — the latter scans the whole line for `***`, `[REDACTED]`,
    `<REDACTED>`, or `XXXX+` runs, since the project-defined patterns
    typically only match the header (e.g. `-----BEGIN PRIVATE KEY-----`)
    and the redacted value follows.
  - Extracted `analyzeHardcodedSecrets`; added 3-test FP regression
    suite.

- **`eslint-justifications`** (`@opensip-tools/checks-universal`)
  - Reported "Malformed ESLint suppression comment" for rationales
    between 401 and 500 characters. The disable-pattern regex
    accepted bodies up to 500 chars (matching `MAX_JUSTIFICATION_
    LENGTH`) but the rationale-extraction regex capped at 400 — so
    rationales in the 401–500 window matched the outer pattern but
    failed the inner parse, producing the wrong error message
    instead of the accurate "too long" one. Now both bounds are 500.

### Internal

- All 17 packages bumped 1.0.6 → 1.0.7; cross-package `workspace:*`
  deps resolved to `1.0.7` via `pnpm pack`.
- Regression-test count: 14 new tests across the four fixes (all
  passing); 79 / 83 / 110 totals across `checks-typescript` and
  `checks-universal`.

## [1.0.6] — 2026-05-16

### Fixed

- **Plugin discovery now honors `package.json#opensip-tools.configPath`.**
  `readProjectPluginsList` in `@opensip-tools/core` previously hardcoded
  `<projectDir>/opensip-tools.config.yml`, ignoring the package.json
  pointer that the targets loader (`resolveProjectConfigPath`) already
  honored. Projects whose config lived at a non-default path — e.g.,
  pointing at `opensip-tools/opensip-tools.config.yml` in a monorepo
  with a vendor-tooling subdir — had their `plugins.<domain>: [...]`
  declaration silently skipped. The plugins dir then fell through to
  the empty default, and the declared pack never registered (so no
  recipes, no checks beyond the built-ins).

  The fix routes `readProjectPluginsList` through
  `resolveProjectConfigPath` so the precedence is identical across
  the two loaders: `--config` → `package.json#opensip-tools.configPath`
  → `<projectDir>/opensip-tools.config.yml`. Coverage added to
  `discover.test.ts` for the pointer + default-fallback cases.

## [1.0.0] — 2026-05-15

First stable release. Everything below was developed and iterated
internally; nothing in the 1.x range was ever published. The 0.x
releases listed further down are the actual public history.

### Architecture

- **Tool-plugin platform.** `@opensip-tools/core` is a strict kernel
  (errors, logger, IDs, language adapters, plugin loader, Tool
  contract). Fitness and simulation are first-party tools that
  implement the Tool contract; the CLI is a generic dispatcher that
  walks `defaultToolRegistry` and asks each tool to mount its own
  Commander subcommands. Adding a new tool — `audit`, `lint`,
  whatever — requires zero CLI changes.
- **Auto-discovery for tool packages.** Any npm package whose
  `package.json` declares `opensipTools.kind === 'tool'` is loaded
  by the CLI on startup; the walker matches Node's nearest-ancestor
  resolution.
- **Layered architecture enforced by dependency-cruiser.** core →
  contracts → fitness / simulation / lang-* (peers) → checks-* → cli.
  Forbidden edges fail CI.

### Packages (17)

- **`@opensip-tools/cli`** — generic tool dispatcher (Ink/React UI).
- **`@opensip-tools/core`** — kernel: errors, logger, IDs, language
  adapters, plugin loader, Tool contract, path resolution.
- **`@opensip-tools/contracts`** — CLI types, exit codes, session
  persistence, dashboard HTML generator.
- **`@opensip-tools/fitness`** — fitness engine + commands
  (`fit`, `dashboard`, `fit-list`, `fit-recipes`), recipe service,
  architecture gate (baseline/compare), SARIF reporting.
- **`@opensip-tools/simulation`** — simulation engine, sim recipes,
  built-in `default` recipe (selects all scenarios). Load + chaos
  scenario kinds are end-to-end functional; invariant and
  fix-evaluation are usable but their executors are MVP.
- **`@opensip-tools/checks-typescript`** (66 checks) — TS-AST checks
  (drizzle-orm, typed-inject, react, package.json#exports, tsconfig).
- **`@opensip-tools/checks-universal`** (88 checks) — text/regex/glob
  checks (Docker, .env, Sentry, generic structure).
- **`@opensip-tools/checks-{python,go,java,cpp}`** — language-specific
  packs (Python `no-bare-except`, Go `no-fmt-print`, Java
  `no-printstacktrace`, C/C++ `clang-tidy` passthrough).
- **`@opensip-tools/lang-{typescript,rust,python,go,java,cpp}`** —
  language adapters (typescript ships a tsc-based parser; the others
  are hand-written lexers, with tree-sitter integration deferred).

### CLI surface

```bash
opensip-tools                              # welcome screen
opensip-tools init                         # detect language + scaffold
opensip-tools fit --recipe example         # smoke test the example check
opensip-tools sim --recipe example         # smoke test the example scenario
opensip-tools fit                          # run the default recipe
opensip-tools fit --check <slug>           # run a single check
opensip-tools fit --tags <list>            # tag filter
opensip-tools fit --gate-save              # save baseline
opensip-tools fit --gate-compare           # diff against baseline
opensip-tools fit --report-to <url>        # SARIF upload to OpenSIP Cloud
opensip-tools dashboard                    # HTML report
opensip-tools fit-list / fit-recipes       # catalog browsing
opensip-tools sessions list|purge          # run history
opensip-tools plugin add|remove|list|sync  # project-local npm plugins
opensip-tools configure                    # cloud API key setup
opensip-tools completion                   # shell completion script
opensip-tools uninstall                    # remove ~/.opensip-tools/
```

### Project layout (v1)

User identity (cloud API key, theme) lives at `~/.opensip-tools/config.yml`.
Everything else is project-local:

```
<project>/
├── opensip-tools.config.yml                       (TRACKED)
├── opensip-tools/
│   ├── fit/{checks,recipes}/*.mjs                 (TRACKED — auto-loaded)
│   ├── sim/{scenarios,recipes}/*.mjs              (TRACKED — auto-loaded)
│   └── .runtime/                                  (GITIGNORED)
│       ├── sessions/         — run history
│       ├── reports/          — dashboard HTML
│       ├── logs/             — structured JSONL (rotated 7 days)
│       ├── cache/            — AST + prewarm caches
│       ├── plugins/<domain>/ — npm-installed plugin packages
│       └── baseline.sarif    — gate baseline
└── ...
```

### Plugin model

- **Source files (auto-loaded):** drop a `.mjs` into
  `opensip-tools/{fit,sim}/{checks,recipes,scenarios}/` and the loader
  picks it up. No config opt-in required.
- **npm packages (explicit):** `opensip-tools plugin add <pkg>`
  installs to `opensip-tools/.runtime/plugins/<domain>/node_modules/`
  and pins the name in `plugins.<domain>:` in
  `opensip-tools.config.yml`. Only packages explicitly listed there
  are loaded — transitive deps in the runtime tree do not auto-load.
- **`@opensip-tools/checks-*` packages** found in `node_modules/`
  (any ancestor) are auto-discovered as fitness check packs unless
  `plugins.autoDiscoverChecks: false` is set.

### `init` and onboarding

`opensip-tools init` detects the project's language(s) from filesystem
markers (`Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`,
`pom.xml`, `build.gradle`, `CMakeLists.txt`, `tsconfig.json`,
`package.json`) and scaffolds:

- `opensip-tools.config.yml` with one named target per detected language
- `opensip-tools/fit/checks/example-check.mjs` (one per language for
  polyglot projects, distinct slugs)
- `opensip-tools/fit/recipes/example-recipe.mjs`
- `opensip-tools/sim/scenarios/example-scenario.mjs`
- `opensip-tools/sim/recipes/example-recipe.mjs`
- `.gitignore` entry for `opensip-tools/.runtime/`

`--language <comma-separated>` overrides detection or specifies a
polyglot configuration explicitly. Ambiguous detection exits 2 with a
prompt — no partial scaffolding.

### Quality gates

- ESLint flat config (`typescript-eslint:recommendedTypeChecked` +
  sonarjs + unicorn + import) — workspace at 0 errors / 0 warnings.
- dependency-cruiser layer rules — 0 violations across 465 modules.
- knip — 0 unused exports / files.
- Vitest — 1308 tests passing across 17 packages.

### Migration from 0.x

1. Replace `@opensip-tools/checks-builtin` in your `package.json` with
   `@opensip-tools/checks-typescript` + `@opensip-tools/checks-universal`.
   The 158-check builtin pack is split: TS-AST checks moved into
   `checks-typescript`, text/regex/glob checks into `checks-universal`.
2. If you imported fitness symbols (`defineCheck`, `CheckViolation`,
   etc.) from `@opensip-tools/core`, switch the import to
   `@opensip-tools/fitness`. Core is a strict kernel now.
3. From your project root, run `opensip-tools init` to scaffold the
   v1 directory layout. Move any custom `.mjs` files from
   `~/.opensip-tools/fit/` into `<project>/opensip-tools/fit/checks/`
   (or `recipes/` if the file exports `recipes`). Move sim files the
   same way under `<project>/opensip-tools/sim/`.
4. If your config declared `plugins.checkPackages:` for npm-installed
   packs, run `opensip-tools plugin sync` to reinstall them under
   `<project>/opensip-tools/.runtime/plugins/`.
5. Replace any `opensip-tools plugin install` calls with
   `opensip-tools plugin add`. The `install` command was always doing
   two operations; `add` is the one-step equivalent.
6. Delete `~/.opensip-tools/{fit,sim,sessions,logs,reports}/` —
   they're no longer read. `opensip-tools uninstall` does this for you.

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
