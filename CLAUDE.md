# CLAUDE.md - AI Agent Guidance for OpenSIP Tools

This is the **START HERE** document for AI agents working on the OpenSIP Tools codebase.

## What is OpenSIP Tools?

OpenSIP Tools is an **open-source codebase analysis toolkit** — a CLI that
hosts pluggable tools for static analysis. Today it ships with three: `fit`
(fitness checks across TypeScript, Rust, Python, Java, Go, C/C++), `graph`
(static call-graph analysis), and `sim` (simulation scenarios, experimental).
Adding a new tool is a plugin operation; the CLI is a generic dispatcher.

## Repository Structure

Turborepo + pnpm monorepo. Workspace scope: `@opensip-tools/*`. Layered —
lower depends on higher only; never the other direction. Architecture
rules are enforced by dependency-cruiser in CI.

```
opensip-tools/
├── packages/
│   ├── core/                    # @opensip-tools/core — kernel: errors, logger,
│   │                            #   IDs, language adapters, plugin loader,
│   │                            #   Tool contract
│   ├── contracts/               # @opensip-tools/contracts — contract types
│   │                            #   between Tools and the runner: SignalEnvelope
│   │                            #   (ADR-0011; replaced CliOutput), CommandResult,
│   │                            #   exit codes, the StoredSession type (runtime in
│   │                            #   session-store), GraphCatalog type surface
│   ├── datastore/               # @opensip-tools/datastore — SQLite + Drizzle
│   │                            #   persistence layer: DataStore interface,
│   │                            #   sqlite/memory backends, factory, schema
│   │                            #   migrations
│   ├── dashboard/               # @opensip-tools/dashboard — self-contained
│   │                            #   HTML report generator (generateDashboardHtml);
│   │                            #   consumed by the CLI-owned `dashboard` command
│   │                            #   (composition root), which aggregates each
│   │                            #   tool's contributed data
│   ├── cli/                     # opensip-tools — generic tool dispatcher
│   ├── cli-ui/                  # @opensip-tools/cli-ui — shared Ink/React
│   │                            #   primitives (Banner, Spinner, RunHeader,
│   │                            #   theme). Extracted from cli/ so tools that
│   │                            #   ship a live view depend on the UI kit
│   │                            #   without pulling in the dispatcher.
│   ├── output/                  # @opensip-tools/output — machine output layer
│   │                            #   (ADR-0011): pure format/ formatters (json,
│   │                            #   sarif, table) + effectful sink/ delivery
│   │                            #   (cloud egress, entitlement). Tools never
│   │                            #   import it; the composition root does.
│   ├── session-store/           # @opensip-tools/session-store — SessionRepo
│   │                            #   runtime + sessions schema (the StoredSession
│   │                            #   type itself lives in contracts)
│   ├── tree-sitter/             # @opensip-tools/tree-sitter — grammar-agnostic
│   │                            #   web-tree-sitter substrate shared by lang-*
│   │                            #   and the graph tree-sitter adapters
│   │
│   ├── fitness/                 # fitness namespace
│   │   ├── engine/              # @opensip-tools/fitness — fitness engine,
│   │   │                        #   fit/dashboard/list-checks/list-recipes,
│   │   │                        #   gate, SARIF
│   │   ├── checks-typescript/   # @opensip-tools/checks-typescript (~50 checks)
│   │   ├── checks-universal/    # @opensip-tools/checks-universal (~90 checks)
│   │   ├── checks-python/       # @opensip-tools/checks-python
│   │   ├── checks-go/           # @opensip-tools/checks-go
│   │   ├── checks-java/         # @opensip-tools/checks-java
│   │   ├── checks-cpp/          # @opensip-tools/checks-cpp
│   │   └── checks-rust/         # @opensip-tools/checks-rust
│   │
│   ├── simulation/              # simulation namespace
│   │   └── engine/              # @opensip-tools/simulation
│   │
│   ├── graph/                   # graph namespace
│   │   ├── engine/              # @opensip-tools/graph — language-agnostic
│   │   │                        #   graph kernel; depends on no parser
│   │   ├── graph-adapter-common/# @opensip-tools/graph-adapter-common —
│   │   │                        #   shared scaffolding (discover/parse/walk/
│   │   │                        #   cache-key factories) for the tree-sitter
│   │   │                        #   adapters; downstream of the engine,
│   │   │                        #   upstream of go/java/python/rust
│   │   ├── graph-typescript/    # @opensip-tools/graph-typescript — TS adapter
│   │   ├── graph-python/        # @opensip-tools/graph-python — Python adapter
│   │   ├── graph-rust/          # @opensip-tools/graph-rust — Rust adapter
│   │   ├── graph-go/            # @opensip-tools/graph-go — Go adapter
│   │   └── graph-java/          # @opensip-tools/graph-java — Java adapter
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

| Layer    | Stack                                               |
| -------- | --------------------------------------------------- |
| Runtime  | Node.js 22+, TypeScript 5.7+                        |
| Build    | Turborepo, pnpm 10+ workspaces                      |
| CLI UI   | Ink (React for terminals), Commander.js             |
| Quality  | ESLint flat config (sonarjs/unicorn/import),        |
|          | dependency-cruiser, knip                            |
| Testing  | Vitest                                              |

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
pnpm --filter=@opensip-tools/<pkg> build
pnpm --filter=@opensip-tools/<pkg> test
```

## CLI Architecture

The `opensip-tools` binary (`packages/cli/src/index.ts`) is a generic
tool dispatcher:

1. Constructs a fresh per-invocation `LanguageRegistry` and registers
   the bundled language adapters (TypeScript, Rust, Python, Java, Go,
   C/C++) into it.
2. Constructs a fresh per-invocation `ToolRegistry` and registers the
   first-party tools — `fitnessTool`, `simulationTool`, and `graphTool`
   (`FIRST_PARTY_TOOLS` in `bootstrap/register-tools.ts`) — into it.
   Both registries are passed into `new RunScope({ tools, languages })`
   — there are no module-singleton registries (see the RunScope section
   below).
3. Discovers third-party tools via `discoverToolPackages()` (any npm
   package whose `package.json` declares `opensipTools.kind === 'tool'`).
4. Walks the tool registry; each tool's `register(cli)` method mounts
   its Commander subcommands using shared CLI infrastructure
   (`ToolCliContext`).
5. Adds CLI-only commands: `init`, `sessions`, `configure`, `plugin`,
   `completion`, `uninstall`.

**The CLI source has zero direct imports from `@opensip-tools/fitness` or
`@opensip-tools/simulation`** beyond the static `tool` exports.

Subcommands available out of the box:

- `opensip-tools fit` — Run fitness checks (with --gate-save, --gate-compare,
  --recipe, --check, --tags, --json, --report-to)
- `opensip-tools fit-list` (alias `list-checks`) — List available checks
- `opensip-tools fit-recipes` (alias `list-recipes`) — List available recipes
- `opensip-tools fit-baseline-export` — Export fitness findings to SARIF
- `opensip-tools dashboard` — Generate HTML report
- `opensip-tools graph` — Build the static call graph
- `opensip-tools graph-lookup` — Look up a symbol's callers/callees in the graph
- `opensip-tools graph-symbol-index` — Build/query the symbol index
- `opensip-tools graph-baseline-export` — Export the graph gate fingerprint baseline to JSON (git-trackable enforcement). For SARIF, use `graph --sarif <path>`.
- `opensip-tools sim` — Run simulation scenarios [experimental]
- `opensip-tools init` — Generate `opensip-tools.config.yml`
- `opensip-tools sessions list|purge` — Manage stored sessions
- `opensip-tools plugin list|add|remove|sync` — Manage plugins
- `opensip-tools configure` — Set up OpenSIP Cloud API key

## Fitness Check System

~145 checks across seven check packs (TypeScript, Universal, Python,
Go, Java, C/C++, Rust). The authoritative per-pack list lives in
`docs/public/70-reference/05-checks-index.md` (generated) — counts below
are approximate and drift as checks are added:

- `@opensip-tools/checks-typescript` (~50 checks) — TS-AST-driven checks
  (drizzle-orm, typed-inject, react, package.json exports, tsconfig).
- `@opensip-tools/checks-universal` (~90 checks) — text/regex/glob checks
  (Docker, .env, Sentry, generic structure, dead-code via knip).
- `@opensip-tools/checks-python|go|java|cpp|rust` — language-specific checks.

### Key Files

- `packages/fitness/engine/src/framework/define-check.ts` — `defineCheck()` API
- `packages/fitness/engine/src/framework/registry.ts` — `defaultRegistry`
- `packages/fitness/engine/src/recipes/` — Recipe service, registry, types
- `packages/fitness/engine/src/cli/` — fit/dashboard/list-checks/list-recipes
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
`@opensip-tools/lang-typescript` over reinventing them inline:
`getSharedSourceFile`, `walkNodes`, `findEnclosingFunction`,
`findEnclosingFunctionBody`, `getEnclosingFunctionName`,
`findEnclosingScope`, `isAsync`, `isInAsyncContext`,
`isInsideConditionalBlock`, plus the various `find*` /
`getPropertyChain` / `isInComment` helpers.

### Defining a Check

Checks declare **scope** (languages + concerns) for file targeting. The
platform matches checks to targets defined in `opensip-tools.config.yml`
via set intersection.

```typescript
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

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

`defineCheck` lives in `@opensip-tools/fitness`, NOT `@opensip-tools/core`.
Core is a strict kernel — language adapters, plugin loader, errors,
logger, IDs, retry, the Tool contract. Anything fitness-shaped lives in
fitness.

### File Scoping (Two-Layer Model)

- **Checks** declare intent: `scope: { languages: ['typescript'], concerns: ['backend'] }`
- **Targets** (`opensip-tools.config.yml`) declare reality: named file sets
  with `languages`, `concerns`, and include/exclude globs
- **Resolution**: `checkOverrides > scope matching > file cache fallback`
- **Global excludes**: `globalExcludes` in `opensip-tools.config.yml` —
  applied to BOTH scope-matched and fileCache-fallback paths (D14)
- **Per-check exemptions**: `@fitness-ignore-file <check-slug>` inline directives

## Coding Standards

### Testing

Vitest. Test files: `*.test.ts` next to the source. Run with `pnpm test`
or `pnpm --filter=@opensip-tools/<pkg> test`.

### Imports

- **Workspace packages** — `import { x } from '@opensip-tools/<pkg>'`
- **Subpath exports** are strongly discouraged; prefer the package
  barrel. The exception is
  `@opensip-tools/core/languages/parse-cache.js` (used by language
  adapters).
- **Internal** — relative paths within a package, always with `.js`
  extension (ESM Node16 module resolution requires it).
- **Type-only imports** — `import type { X }` whenever possible. The
  `@typescript-eslint/consistent-type-imports` rule enforces inline
  `type` for mixed value+type imports.

### Per-run state lives on `RunScope`

- Per-CLI-invocation state (logger, parse cache, tool/language
  registries, recipe-config slot, project context, lazy datastore
  thunk) lives on `RunScope` (`@opensip-tools/core/lib/run-scope.ts`).
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

### Layering rules (enforced by dependency-cruiser)

```
core (kernel)
  ↑
contracts (Tool↔runner contract types)
  ↑
lang-* / fitness / simulation (peer layer)
  ↑
checks-* (depend on fitness)
  ↑
cli (entry point — depends on every tool)
```

- core must NOT import from contracts, cli, fitness, simulation, lang-*, or checks-*.
- contracts must NOT import from cli, fitness, simulation, lang-*, or checks-*.
- fitness / simulation must NOT import from cli (would create a cycle).
- check packs must NOT import from cli or contracts.
- lang-* packs must NOT import from cli, contracts, fitness, simulation, or
  each other. (The historical lang-typescript exception for `filterContent`
  was paid down — the symbol now lives in `@opensip-tools/lang-typescript`
  alongside the rest of the TS-aware string/comment stripping.)
- `Registry<T>` (the shared base for all by-id/by-name registries) and
  `RunScope` (per-invocation execution scope) live in `@opensip-tools/core`.
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

CI runs `pnpm fit:ci` on every PR — opensip-tools analyzes itself.
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
`opensip-tools.config.yml`) requires PR-description justification
and reviewer sign-off — it is not a default contributor option.

The **graph** tool is dogfooded the same way: CI runs `graph
--gate-save --sarif graph.sarif` (one run: the gate hard-fails on
error-level findings AND emits SARIF 2.1.0 via the shared
`cli.writeSarif` envelope→SARIF seam, the same path `fit` uses) →
upload to Code Scanning under category `opensip-tools-graph`. The
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

**Why `pnpm fit` works at all in this monorepo:** workspace dep
injection is enabled via `injectWorkspacePackages: true` in
`pnpm-workspace.yaml` (pnpm 11's settings home — it no longer reads the
package.json `pnpm` field; the build-script allowlist and `overrides`
moved there too, as `allowBuilds`/`overrides`), plus
`@opensip-tools/checks-typescript` and `@opensip-tools/checks-universal`
are declared as root devDependencies. Without that, the discovery walker
would find 0 check packages at the workspace root and the run would
silently report 0 checks.

## Documentation

The `docs/` tree has five committed siblings plus one local-only
scratch area, each with a distinct contract:

- **`docs/public/`** — hand-edited source. These are the docs we publish
  on the website at opensip.ai/docs/opensip-tools/. Numbered
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
  decision log (ADRs): the durable *why* behind a choice, with
  alternatives and consequences. One file per `ADR-NNNN-*.md`,
  **append-only** (supersede via a new ADR; never rewrite). This repo
  uses `ADR-NNNN`; the parent `opensip` repo uses `DEC-NNN` — cite a
  parent decision via `related: [DEC-NNN]`. See
  `docs/decisions/README.md` and `docs/decisions/TEMPLATE.md`.
- **`docs/plans/specs/`** — hand-edited, **local-only (gitignored,
  lives under `docs/plans/`)**. Forward-looking implementation specs
  (the *how* to build a feature), following the spec skill format; they
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

Boundary rule of thumb: a durable *decision* (what we chose + why, with
alternatives) is an ADR in `docs/decisions/`; the *how to build it* is a
spec in `docs/plans/specs/` (local-only). For prose docs: if you can write the fact about
opensip-tools without naming a specific consumer, it goes in
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

Releases are tag-driven. See `RELEASING.md` — there are 27 packages
to publish, in a specific dependency order, via OIDC trusted publishing.

The release workflow has two non-obvious steps (npm 11 to a separate
prefix; `pnpm pack` + `npm publish <tarball>`) that look like they
could be simplified but cannot — both work around concrete bugs in
npm's self-replacement and pnpm's lack of OIDC support.

## Project Status

**v2.7.0 (pre-GA)** — opensip-tools is a tool-plugin platform: `core` is a
strict kernel, and `fitness`, `graph`, and `simulation` are peer
tools implementing a shared Tool contract, with `cli` as a generic
dispatcher. Adding a new tool requires zero CLI changes. The project stays
pre-GA on the long-lived 2.x major (ADR-0012); **`3.0.0` is reserved for the
tool-plugin-parity north star** described in
`docs/plans/tool-plugin-parity-architecture-2026-06-06.md` — many 2.x releases
are expected before then.

The new-customer flow is three commands: `init` (language detection
+ scaffolded layout) → `fit --recipe example` → `sim --recipe
example`. Project layout is local: user-authored content under
`<project>/opensip-tools/{fit,sim}/{checks,recipes,scenarios}/`
(tracked) and tool-generated state under
`<project>/opensip-tools/.runtime/` (gitignored). Plugin loader
auto-discovers `.mjs` files by directory presence; npm packages
must be explicitly listed in `plugins.<domain>` to load.

Re-running `init` on a non-pristine project refuses with exit 2 by
default. Two explicit flags express user intent:
`--keep` re-scaffolds examples while preserving custom files, and
`--remove` deletes `opensip-tools/` entirely before scaffolding
fresh. The flags are mutually exclusive. The legacy `--force` flag
is gone; users who scripted it should migrate to `--remove`. See
`docs/public/70-reference/01-cli-commands.md#init---scaffold-the-project-layout`
for the full state table.

Future tool ideas (not implemented): `audit`, `lint`, `bench`. Any of
these would slot in by writing a Tool implementation and shipping a
package.
