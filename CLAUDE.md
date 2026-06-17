# CLAUDE.md - AI Agent Guidance for OpenSIP CLI

This is the **START HERE** document for AI agents working on the OpenSIP CLI codebase.

## What is OpenSIP CLI?

OpenSIP CLI is an **open-source codebase intelligence CLI** — a CLI that
hosts pluggable tools for static analysis. Today it ships with three: `fit`
(fitness checks across TypeScript, Rust, Python, Java, Go, C/C++), `graph`
(static call-graph analysis), and `sim` (simulation scenarios, experimental).
Adding a new tool is a plugin operation; the CLI is a generic dispatcher.

## Repository Structure

Turborepo + pnpm monorepo. Workspace scope: `@opensip-cli/*`. Layered —
higher-level packages depend on lower-level substrates, never the other
direction. Architecture rules are enforced by dependency-cruiser in CI.

```
opensip-cli/
├── packages/
│   ├── core/                    # @opensip-cli/core — kernel: errors, logger,
│   │                            #   IDs, language adapters, plugin loader,
│   │                            #   Tool contract
│   ├── contracts/               # @opensip-cli/contracts — Tool↔runner contract
│   │                            #   facade: types, constants, and small
│   │                            #   tool-facing runtime helpers. SignalEnvelope
│   │                            #   (ADR-0011; replaced CliOutput), CommandResult,
│   │                            #   exit codes, the StoredSession type (runtime in
│   │                            #   session-store), GraphCatalog type surface
│   ├── datastore/               # @opensip-cli/datastore — SQLite + Drizzle
│   │                            #   persistence layer: DataStore interface,
│   │                            #   sqlite/memory backends, factory, schema
│   │                            #   migrations
│   ├── dashboard/               # @opensip-cli/dashboard — self-contained
│   │                            #   HTML report generator (generateDashboardHtml);
│   │                            #   consumed by the CLI-owned `report` command
│   │                            #   (composition root), which aggregates each
│   │                            #   tool's contributed data
│   ├── cli/                     # opensip-cli — generic tool dispatcher
│   ├── config/                  # @opensip-cli/config — config composer +
│   │                            #   schema registry (ADR-0023): folds host-owned
│   │                            #   blocks + each tool's namespaced Zod schema
│   │                            #   into one strict document; cli/dashboard/
│   │                            #   targeting/global-config I/O
│   ├── cli-ui/                  # @opensip-cli/cli-ui — shared Ink/React
│   │                            #   primitives (Banner, Spinner, RunHeader,
│   │                            #   theme). Extracted from cli/ so tools that
│   │                            #   ship a live view depend on the UI kit
│   │                            #   without pulling in the dispatcher.
│   ├── output/                  # @opensip-cli/output — machine output layer
│   │                            #   (ADR-0011): pure format/ formatters (json,
│   │                            #   sarif, table) + effectful sink/ delivery
│   │                            #   (cloud egress, entitlement). Tools never
│   │                            #   import it; the composition root does.
│   ├── session-store/           # @opensip-cli/session-store — SessionRepo
│   │                            #   runtime + sessions schema (the StoredSession
│   │                            #   type itself lives in contracts)
│   ├── targeting/               # @opensip-cli/targeting — host file-targeting
│   │                            #   runtime substrate (ADR-0037): TargetRegistry +
│   │                            #   glob expansion w/ globalExcludes; built once
│   │                            #   per run by the CLI bootstrap → scope.targets
│   ├── test-support/            # @opensip-cli/test-support — PRIVATE, never
│   │                            #   published (ADR-0040): cross-package test
│   │                            #   scaffolding (RunScope test sugar + the
│   │                            #   per-check fixture-coverage harness). Only
│   │                            #   test files may import it (depcruise rule)
│   ├── tree-sitter/             # @opensip-cli/tree-sitter — grammar-agnostic
│   │                            #   web-tree-sitter substrate shared by lang-*
│   │                            #   and the graph tree-sitter adapters
│   │
│   ├── fitness/                 # fitness namespace
│   │   ├── engine/              # @opensip-cli/fitness — fitness engine,
│   │   │                        #   fit/report-data/fit-list/fit-recipes,
│   │   │                        #   gate, SARIF
│   │   ├── checks-typescript/   # @opensip-cli/checks-typescript (51 checks)
│   │   ├── checks-universal/    # @opensip-cli/checks-universal (94 checks)
│   │   ├── checks-python/       # @opensip-cli/checks-python
│   │   ├── checks-go/           # @opensip-cli/checks-go
│   │   ├── checks-java/         # @opensip-cli/checks-java
│   │   ├── checks-cpp/          # @opensip-cli/checks-cpp
│   │   └── checks-rust/         # @opensip-cli/checks-rust
│   │
│   ├── simulation/              # simulation namespace
│   │   └── engine/              # @opensip-cli/simulation
│   │
│   ├── graph/                   # graph namespace
│   │   ├── engine/              # @opensip-cli/graph — language-agnostic
│   │   │                        #   graph kernel; depends on no parser
│   │   ├── graph-adapter-common/# @opensip-cli/graph-adapter-common —
│   │   │                        #   shared scaffolding (discover/parse/walk/
│   │   │                        #   cache-key factories) for the tree-sitter
│   │   │                        #   adapters; downstream of the engine,
│   │   │                        #   upstream of go/java/python/rust
│   │   ├── graph-typescript/    # @opensip-cli/graph-typescript — TS adapter
│   │   ├── graph-python/        # @opensip-cli/graph-python — Python adapter
│   │   ├── graph-rust/          # @opensip-cli/graph-rust — Rust adapter
│   │   ├── graph-go/            # @opensip-cli/graph-go — Go adapter
│   │   └── graph-java/          # @opensip-cli/graph-java — Java adapter
│   │
│   └── languages/               # language adapters
│       ├── lang-typescript/
│       ├── lang-rust/
│       ├── lang-python/
│       ├── lang-go/
│       ├── lang-java/
│       └── lang-cpp/
│
├── .config/                     # tooling configs (not auto-discovered —
│   │                            #   invoked via --config from package.json)
│   ├── eslint.config.mjs        #   workspace ESLint config
│   ├── knip.json                #   knip orphan-detection config
│   ├── dependency-cruiser.cjs   #   architecture-layer enforcement
│   ├── dependency-cruiser.types.cjs  # type-aware companion gate
│   └── tsconfig.depcruise.json  #   depcruise-only paths→src map
├── turbo.json                   # Turborepo task config
├── pnpm-workspace.yaml          # packages/*  +  packages/<tool>/*
└── tsconfig.json                # Root TS config (ES2022, Node16)
```

## Tech Stack

| Layer   | Stack                                        |
| ------- | -------------------------------------------- |
| Runtime | Node.js 24+, TypeScript 5.7+                 |
| Build   | Turborepo, pnpm 10+ workspaces               |
| CLI UI  | Ink (React for terminals), Commander.js      |
| Quality | ESLint flat config (sonarjs/unicorn/import), |
|         | dependency-cruiser, knip                     |
| Testing | Vitest                                       |

## Essential Commands

```bash
# Setup
pnpm install && pnpm build

# Run fitness checks against this repo (must build first)
pnpm fit            # shortcut for: node packages/cli/dist/index.js fit

# Run all tests
pnpm test

# Typecheck
pnpm typecheck

# Lint (ESLint + dependency-cruiser; both must be 0-error)
pnpm lint
pnpm lint:fix       # ESLint auto-fix only

# Per-package
pnpm --filter=@opensip-cli/<pkg> build
pnpm --filter=@opensip-cli/<pkg> test
```

## CLI Architecture

The `opensip` binary (`packages/cli/src/index.ts`) is a generic
tool dispatcher:

1. Constructs a fresh per-invocation `LanguageRegistry` and registers
   the bundled language adapters (TypeScript, Rust, Python, Java, Go,
   C/C++) into it.
2. Constructs a fresh per-invocation `ToolRegistry` and registers the
   bundled tool packages (`@opensip-cli/fitness`, `@opensip-cli/simulation`,
   `@opensip-cli/graph`) through the manifest → compatibility gate → dynamic
   import path in `bootstrap/register-tools.ts`. Both registries are passed into
   `new RunScope({ tools, languages })` — there are no module-singleton
   registries (see the RunScope section below).
3. Discovers third-party tools via `discoverToolPackages()` (any npm package
   whose `package.json` declares `opensipTools.kind === 'tool'`).
4. Walks the tool registry and mounts each tool's declarative `commandSpecs`
   through the host-owned `mountCommandSpec` infrastructure. Tools never receive
   a raw Commander program.
5. Adds CLI-only commands: `init`, `report`, `sessions`, `configure`,
   `plugin`, `tools`, `agent-catalog`, `completion`, and `uninstall`.

**The CLI source has zero static imports of first-party tool runtimes**; bundled
tools load by package name through the same plugin path as installed tools.

Subcommands available out of the box:

- `opensip fit` — Run fitness checks (with --gate-save, --gate-compare,
  --recipe, --check, --tags, --json, --report-to)
- `opensip fit-list` — List available checks
- `opensip fit-recipes` — List available recipes
- `opensip fit-baseline-export` — Export fitness findings to SARIF
- `opensip report` — Generate HTML report
- `opensip graph` — Build the static call graph
- `opensip graph-recipes` — List available graph rule recipes
- `opensip graph-lookup` — Look up a symbol's callers/callees in the graph
- `opensip graph-symbol-index` — Build/query the symbol index
- `opensip graph-baseline-export` — Export the graph gate fingerprint baseline to JSON (git-trackable enforcement). For SARIF, use `graph --sarif <path>`.
- `opensip catalog-export` — Write graph catalog JSON for downstream tooling
- `opensip sarif-export` — Run graph analysis and write SARIF findings
- `opensip sim` — Run simulation scenarios [experimental]
- `opensip init` — Generate `opensip-cli.config.yml`
- `opensip sessions list|show|purge` — Manage stored sessions
- `opensip plugin list|add|remove|sync` — Manage fit/sim packs and the Tool-plugin compatibility path
- `opensip tools list|validate|install|uninstall|data-purge` — Manage whole Tool plugins
- `opensip configure` — Store an API key for future/private OpenSIP Cloud-compatible endpoints

## Fitness Check System

151 checks across seven check packs (TypeScript, Universal, Python,
Go, Java, C/C++, Rust). The authoritative per-pack list lives in
`docs/public/70-reference/05-checks-index.md` (generated) — counts below
are approximate and drift as checks are added:

- `@opensip-cli/checks-typescript` (51 checks) — TS-AST-driven checks
  (drizzle-orm, typed-inject, react, package.json exports, tsconfig).
- `@opensip-cli/checks-universal` (94 checks) — text/regex/glob checks
  (Docker, .env, Sentry, generic structure, dead-code via knip).
- `@opensip-cli/checks-python|go|java|cpp|rust` — language-specific checks.

### Key Files

- `packages/fitness/engine/src/framework/define-check.ts` — `defineCheck()` API
- `packages/fitness/engine/src/framework/scope-registry.ts` — per-run check and recipe registry access
- `packages/fitness/engine/src/recipes/` — Recipe service, registry, types
- `packages/fitness/engine/src/cli/` — fit/report-data/fit-list/fit-recipes
  command implementations
- `packages/fitness/engine/src/tool.ts` — fitness's Tool plugin descriptor

Adding a new check:

1. Decide which pack it belongs in (TS-AST → checks-typescript;
   text/regex → checks-universal; language-specific → checks-<lang>).
2. Add the source file under `src/checks/<category>/`.
3. Re-export it from the pack's `src/index.ts` barrel.
4. Add a display entry to `src/display/<category>.ts` if you want a
   pretty name and icon (otherwise kebab-to-title-case fallback applies).

For TS-AST checks, prefer the canonical AST helpers exported from
`@opensip-cli/lang-typescript` over reinventing them inline:
`getSharedSourceFile`, `walkNodes`, `findEnclosingFunction`,
`findEnclosingFunctionBody`, `getEnclosingFunctionName`,
`findEnclosingScope`, `isAsync`, `isInAsyncContext`,
`isInsideConditionalBlock`, plus the various `find*` /
`getPropertyChain` / `isInComment` helpers.

### Defining a Check

Checks declare **scope** (languages + concerns) for file targeting. The
platform matches checks to targets defined in `opensip-cli.config.yml`
via set intersection.

```typescript
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

export const myCheck = defineCheck({
  id: 'uuid-here',
  slug: 'my-check-slug',
  description: 'What this check does',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  tags: ['quality'],
  analyze: (content, filePath) => {
    const violations: CheckViolation[] = [];
    // ... detect issues
    return violations;
  },
});
```

`defineCheck` lives in `@opensip-cli/fitness`, NOT `@opensip-cli/core`.
Core is a strict kernel — language adapters, plugin loader, errors,
logger, IDs, retry, the Tool contract. Anything fitness-shaped lives in
fitness.

### File Scoping (Two-Layer Model)

- **Checks** declare intent: `scope: { languages: ['typescript'], concerns: ['backend'] }`
- **Targets** (`opensip-cli.config.yml`) declare reality: named file sets
  with `languages`, `concerns`, and include/exclude globs
- **Resolution**: `checkOverrides > scope matching > file cache fallback`
- **Global excludes**: `globalExcludes` in `opensip-cli.config.yml` —
  applied to BOTH scope-matched and fileCache-fallback paths (D14)
- **Per-check exemptions**: `@fitness-ignore-file <check-slug>` inline directives

## Coding Standards

### Testing

Vitest. Test files: `*.test.ts` next to the source. Run with `pnpm test`
or `pnpm --filter=@opensip-cli/<pkg> test`.

### Imports

- **Workspace packages** — `import { x } from '@opensip-cli/<pkg>'`
- **Subpath exports** are strongly discouraged; prefer the package
  barrel. The exception is
  `@opensip-cli/core/languages/parse-cache.js` (used by language
  adapters).
- **Internal** — relative paths within a package, always with `.js`
  extension (ESM Node16 module resolution requires it).
- **Type-only imports** — `import type { X }` whenever possible. The
  `@typescript-eslint/consistent-type-imports` rule enforces inline
  `type` for mixed value+type imports.

### Per-run state lives on `RunScope`

- Per-CLI-invocation state (logger, parse cache, tool/language
  registries, recipe-config slot, project context, lazy datastore
  thunk) lives on `RunScope` (`@opensip-cli/core/lib/run-scope.ts`).
  Never reintroduce module-level mutable state for these concerns.
- Tools read `cli.scope.foo`. The legacy `defaultToolRegistry` and
  `defaultLanguageRegistry` module-singleton exports do not exist
  anymore — the CLI bootstrap constructs and populates a fresh
  `ToolRegistry` / `LanguageRegistry` per invocation and passes them
  into `new RunScope({ tools, languages })`.
- Library functions deep in the call tree read the current scope via
  `currentScope()` (AsyncLocalStorage). Inside `runWithScope(scope,
fn)`, every async descendant of `fn` sees the same scope. The
  Commander preAction hook uses `enterScope` so the action body
  invoked after the hook returns still resolves the same scope.
- `getCheckConfig(slug)` reads from `currentScope()?.recipeCheckConfig`.
  It does NOT read from `globalThis` and the `Symbol.for(globalThis)`
  slot has been deleted.
- Registration of tools, languages, scenarios, recipes, and checks is
  ALWAYS explicit. `defineX(...)` returns a value; the caller
  registers it via the plugin loader or by passing it into a
  populated registry. No module-import side effects.
- For tests, wrap any code that reads `currentScope()` in
  `runWithScope(new RunScope({ languages: new LanguageRegistry(),
tools: new ToolRegistry(), ... }), () => ...)`. Several test helpers
  (`packages/core/src/test-utils/with-scope.ts`,
  `packages/fitness/.../__tests__/`) already wrap this pattern.
- After the host-owned scope/seam hardening work, **every production
  path** (tool actions + all host commands including `sessions list|show|purge`,
  `agent-catalog`, plugin, configure, etc.) executes inside a properly
  constructed and entered `RunScope` (via `enterScope` in the pre-action hook or
  explicit `runWithScope` in tests). The former general pre-scope
  `CliRuntimeContext` + `scopeEntered` holder is strictly test-only (hard
  guards throw `SYSTEM.SCOPE.HOLDER_MISUSE` / `NOT_ENTERED` in prod).
- The only way to reach per-run datastore, project context, registries, etc.
  from production handler bodies is `currentScope()` (or `cli.scope` on the
  ToolCliContext).

### Only documented ToolCliContext seams (output, delivery, host planes)

Tools and host command handlers must only use the methods on the `ToolCliContext`
they receive:

- `render`, `emitJson`, `emitEnvelope`, `deliverSignals`, `writeSarif`
- Baseline seams (`saveBaseline`, `compareBaseline`, `exportBaselineSarif`...)
- `toolState` (ADR-0042)
- `hostPlanes` (when present: the typed `governance`/`audit`/`entitlements`
  bag — Cloud primary; OSS tools may ignore or supply compat impls and fall
  back to `toolState` for custom records).
- `runSession` (host-owned-run-timing): `{ timing: RunTimer }` — **read-only**.
  `timing` exposes the current invocation's `RunTimer` for display-only elapsed
  (e.g. a live header clock). There is **no** generic-session writer on the
  context. To record a run, a tool RETURNS a `ToolSessionContribution` (the
  `session` field of a `ToolRunCompletion`) from its command handler or live
  renderer; the host run plane stamps `startedAt`/`completedAt`/`durationMs` from
  that single `RunTimer` and persists the `StoredSession` row. Tools supply only
  `tool`/`cwd`/`recipe?`/`score`/`passed`/`payload?` (never timing).

Direct `process.stdout` (for run output), `console.*` for run data, the old
pre-scope holder, or raw datastore from action bodies is forbidden and caught
by ESLint (no-restricted-properties + imports) + a fitness architecture check
(`only-documented-toolcli-seams`) + the hard runtime guards added in the
hygiene pass. The composition root (bootstrap, error/report seams, the
`buildToolCliContext` factory itself) is exempted by design. See
ADR-0051 and `docs/public/80-implementation/03-session-and-persistence.md`.

**Session timing rule (host-owned-run-timing):** `StoredSession.startedAt`,
`completedAt`, and `durationMs` are produced exclusively by the CLI host from a
single `RunTimer` (created at the command-action boundary). Tools never own the
generic row: they return a `ToolSessionContribution` and the host run plane
stamps the timing + persists. First-party tools (and third-party) must never
import `SessionRepo`, re-introduce a `persist*Session` helper, or call a
`runSession.record(...)` writer (removed) — there is no tool-side generic-session
writer. Internal per-unit/stage/recipe timers (and the SignalEnvelope's own
timing) remain tool-owned for diagnostics and belong in the tool payload /
envelope or `collectReportData`, never the generic columns. Host-side overhead
(persistMs/ttyBusyMs/renderMs/egressMs/totalCommandMs) lives on a sibling
`StoredSessionHostMetrics` record the host writes, keyed by session id. The
`architecture-session-timing-not-host-owned` fitness check (path-gated to the
first-party tool packages; forbids the persistence symbols above) plus
`only-documented-toolcli-seams` and ESLint rules enforce this.

This is the mechanical realization of "only use documented seams".

### Layering rules (enforced by dependency-cruiser)

```
core (kernel)
  ↑
contracts (Tool↔runner contract facade)
  ↑
lang-* / fitness / simulation (peer layer)
  ↑
checks-* (depend on fitness)
  ↑
cli (entry point — depends on every tool)
```

- core must NOT import from contracts, cli, fitness, simulation, lang-_, or checks-_.
- contracts must NOT import from cli, fitness, simulation, lang-_, or checks-_.
- fitness / simulation must NOT import from cli (would create a cycle).
- check packs must NOT import from cli or contracts.
- lang-\* packs must NOT import from cli, contracts, fitness, simulation, or
  each other. (The historical lang-typescript exception for `filterContent`
  was paid down — the symbol now lives in `@opensip-cli/lang-typescript`
  alongside the rest of the TS-aware string/comment stripping.)
- `Registry<T>` (the shared base for all by-id/by-name registries) and
  `RunScope` (per-invocation execution scope) live in `@opensip-cli/core`.
  Tools own their own thin subclasses (e.g. `CheckRegistry`,
  `TargetRegistry`); no per-tool registries leak back into the kernel.

If you need to violate a rule, the right move is usually to refactor the
shared piece into core. If that's wrong, surface it for discussion before
disabling the rule.

## Before Committing

```bash
pnpm typecheck && pnpm test && pnpm lint
```

`pnpm lint` runs both ESLint and dependency-cruiser. Both must be 0-error.

## Dogfood Gate

CI runs `pnpm fit:ci` on every PR — OpenSIP CLI analyzes itself.
`fit --gate-save` writes findings into the (CI-ephemeral) datastore
AND hard-fails the step on any error-level finding — it returns the
`failOnErrors`/`failOnWarnings` exit code (ADR-0020), so the CI step
itself is the gate, not just the downstream ratchet. A separate
workflow step then exports to SARIF (`fit-baseline-export --out
fit.sarif`) under `if: always()` — so the baseline + annotations
export even when the gate fails — and uploads to GitHub Code Scanning.
GH compares against the latest main-branch SARIF and surfaces **new**
alerts inline on PR diffs and under Security → Code scanning alerts.
That net-new ratchet is the complementary annotation layer (and the
model for adopters with a backlog: `failOnErrors: 0` = ratchet-only):
existing violations are recorded in the baseline; only net-new
violations surface as new alerts on contributor PRs.

A hard PR gate that fails on any net-new alert is configured via
GitHub branch protection (Settings → Branches → main → "Require
status checks to pass" → include the Code Scanning check). The
plan flagged this as optional but recommended.

If a Code Scanning alert appears on your PR, run `pnpm fit` locally
to see the specific finding and the suggestion. Fix the violation
in your PR. Updating the gate (e.g., via `disabledChecks` in
`opensip-cli.config.yml`) requires PR-description justification
and reviewer sign-off — it is not a default contributor option.

The **graph** tool is dogfooded the same way: CI runs `graph
--gate-save --sarif graph.sarif` (one run: the gate hard-fails on
error-level findings AND emits SARIF 2.1.0 via the shared
`cli.writeSarif` envelope→SARIF seam, the same path `fit` uses) →
upload to Code Scanning under category `opensip-cli-graph`. The
`--sarif` write happens after the gate exit code is set, so the file
lands even when the gate fails (upload runs under `if: always()`).
Same ratchet: only net-new graph findings surface on PRs.
(`graph-baseline-export` is a separate command — it exports the gate
**fingerprint** baseline JSON for git-trackable enforcement, not
SARIF.) The graph rules
(large-function, wide-function, high-blast-untested, cycle,
duplicated-function-body) skip test-file occurrences — they gate
production code only — and `large-function` skips the synthetic
`<module-init>` (whole-file) occurrence. Run `pnpm graph` locally to
reproduce a graph alert.

**The baseline/ratchet/export machinery is a HOST-OWNED plane, not
per-tool code (ADR-0036).** Capture (`--gate-save`), the net-new ratchet
(`--gate-compare`), and export (SARIF + git-trackable JSON fingerprints)
are four `ToolCliContext` seams — `saveBaseline` / `compareBaseline` /
`exportBaselineSarif` / `exportBaselineFingerprints` — over one generic
table pair in `@opensip-cli/datastore` (`tool_baseline_entries` +
`tool_baseline_meta`, scoped by a `tool` column) and one pure
`diffBaseline` in `@opensip-cli/output`. A tool inherits the whole
ratchet by emitting fingerprint-stamped signals; it authors **at most a
`Tool.fingerprintStrategy`** — often nothing (the host default keys on
`ruleId|filePath|line|col`). `graph` declares a byte-preserved strategy
(its git-trackable JSON fingerprint baseline is a consumer-repo artifact);
`fitness` declares a message-hash (`sha256(filePath\nruleId\nmessage)`,
line-shift-tolerant). The plane NEVER re-fingerprints — each tool stamps
its envelope (`stampFingerprints`) at construction time; the seams only
read `signal.fingerprint`. The gate-compare exit is host-derived: a tool
passes `degraded && failOnDegraded` as the `deliverSignals` runFailed
override (no tool calls `setExitCode` for the gate path; ADR-0035). The
third reserved gate key `failOnDegraded` (default `true`, beside
`failOnErrors`/`failOnWarnings`) toggles hard-fail vs. report-only for the
ratchet. Baselines are drop-and-recapture (CI-ephemeral; a release that
changes the baseline schema drops the local DB rows — re-run `--gate-save`;
the committed JSON fingerprint baseline is a file, untouched).

**Why `pnpm fit` works at all in this monorepo:** workspace dep
injection is enabled via `injectWorkspacePackages: true` in
`pnpm-workspace.yaml` (pnpm 11's settings home — it no longer reads the
package.json `pnpm` field; the build-script allowlist and `overrides`
moved there too, as `allowBuilds`/`overrides`), plus
`@opensip-cli/checks-typescript` and `@opensip-cli/checks-universal`
are declared as root devDependencies. Without that, the discovery walker
would find 0 check packages at the workspace root and the run would
silently report 0 checks.

## Documentation

The `docs/` tree has five committed siblings plus one local-only
scratch area, each with a distinct contract:

- **`docs/public/`** — hand-edited source. These are the docs we publish
  on the website at opensip.ai/docs/opensip-cli/. Numbered
  Diátaxis-ish sections: `00-start`, `10-concepts`, `20-fit`, `30-sim`,
  `40-graph`, `50-extend`, `60-guides`, `70-reference`,
  `80-implementation`. Anything here is reader-facing and externally
  consumable.
- **`docs/internal/`** — hand-edited, repo-only but committed.
  Contributor-facing awareness that doesn't belong on the website:
  cross-repo consumer relationships, operational notes. See
  `docs/internal/README.md` for the charter. (Formal decisions live in
  `docs/decisions/`, not here.)
- **`docs/decisions/`** — hand-edited, committed. The architecture
  decision log (ADRs): the durable _why_ behind a choice, with
  alternatives and consequences. One file per `ADR-NNNN-*.md`,
  **append-only** (supersede via a new ADR; never rewrite). This repo
  uses `ADR-NNNN`; the parent `opensip` repo uses `DEC-NNN` — cite a
  parent decision via `related: [DEC-NNN]`. See
  `docs/decisions/README.md` and `docs/decisions/TEMPLATE.md`.
- **`docs/plans/specs/`** — hand-edited, **local-only (gitignored,
  lives under `docs/plans/`)**. Forward-looking implementation specs
  (the _how_ to build a feature), following the spec skill format; they
  gate planning before code. A spec implements a decision recorded in
  `docs/decisions/`. NOTE: this deliberately overrides the spec skill's
  default `docs/specs/` output — author all specs under
  `docs/plans/specs/`.
- **`docs/web-generated/`** — generated output. Never hand-edit. It
  mirrors `docs/public/` rewritten for the website (links resolved to
  pinned GitHub URLs and root-relative website paths; `web:skip` /
  `web:only` voice markers processed). Committed so PR reviewers see
  what will actually render.
- **`docs/plans/`** — local-only scratch space, **gitignored**.
  In-progress implementation plans and design notes that don't belong
  in a public OSS repo. Not committed; not visible to external
  contributors. Anything that matures into a durable record (decision →
  `docs/decisions/`, consumer contract →
  `docs/internal/`, reader-facing fact → `docs/public/`) graduates out
  of `docs/plans/`.

Boundary rule of thumb: a durable _decision_ (what we chose + why, with
alternatives) is an ADR in `docs/decisions/`; the _how to build it_ is a
spec in `docs/plans/specs/` (local-only). For prose docs: if you can write the fact about
opensip-cli without naming a specific consumer, it goes in
`docs/public/`; if naming a specific consumer (or other private context)
is load-bearing, it goes in `docs/internal/`; if it's pending work or
design exploration not yet ready for external readers, it stays in
`docs/plans/` (local-only).

- **Generator:** `scripts/build-web-docs.mjs`
- **Scripts:** `pnpm docs:build` (write) · `pnpm docs:check` (CI staleness gate)
- **What it does:** relative source-code links → pinned GitHub URLs;
  sibling `.md` links → root-relative website paths; processes
  `<!-- web:skip -->` / `<!-- web:only -->` markers (silent in repo view).

**Rules:**

- Never hand-edit anything under `docs/web-generated/` — it gets overwritten.
- After editing `docs/public/`, run `pnpm docs:build` and commit
  the regenerated `docs/web-generated/` in the same change.
- Moves/renames inside `docs/public/` propagate to `docs/web-generated/`
  automatically — don't mirror them manually.
- If CI's `pnpm docs:check` fails, the fix is `pnpm docs:build` + commit.

## Release Process

Releases are tag-driven. See `RELEASING.md` — there are 33 packages
to publish, in a specific dependency order, via OIDC trusted publishing.

The release workflow has two non-obvious steps (npm 11 to a separate
prefix; `pnpm pack` + `npm publish <tarball>`) that look like they
could be simplified but cannot — both work around concrete bugs in
npm's self-replacement and pnpm's lack of OIDC support.

## Project Status

**v0.1.5 (initial production launch)** — OpenSIP CLI is a tool-plugin
platform: `core` is a strict kernel, and `fitness`, `graph`, and
`simulation` are peer tools implementing a shared Tool contract, with
`cli` as a generic dispatcher. Adding a new tool requires zero CLI
changes: tools declare `commandSpecs`, ship a manifest, and load through
the same dynamic-import plugin path whether bundled, installed, or
project-local. The npm package is `opensip-cli`; the installed command is
`opensip`.

The new-customer flow is three commands: `init` (language detection

- scaffolded layout) → `fit --recipe example` → `sim --recipe
example`. Project layout is local: user-authored content under
  `<project>/opensip-cli/{fit,sim}/{checks,recipes,scenarios}/`
  (tracked) and tool-generated state under
  `<project>/opensip-cli/.runtime/` (gitignored). Plugin loader
  auto-discovers `.mjs` files by directory presence; npm packages
  must be explicitly listed in `plugins.<domain>` to load.

Re-running `init` on a non-pristine project refuses with exit 2 by
default. Two explicit flags express user intent:
`--keep` re-scaffolds examples while preserving custom files, and
`--remove` deletes `opensip-cli/` entirely before scaffolding
fresh. The flags are mutually exclusive. See
`docs/public/70-reference/01-cli-commands.md#init---scaffold-the-project-layout`
for the full state table.

Future tool ideas (not implemented): `audit`, `lint`, `bench`. Any of
these would slot in by writing a Tool implementation and shipping a
package.
