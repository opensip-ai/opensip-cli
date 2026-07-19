---
status: current
last_verified: 2026-07-11
release: v0.7.0
title: "Layered package graph"
audience: [contributors]
purpose: "The layered workspace, the six-layer dependency rule, why dependency-cruiser exists, and the trade-offs."
source-files:
  - .config/dependency-cruiser.cjs
  - pnpm-workspace.yaml
  - package.json
  - packages/*/package.json
  - packages/*/*/package.json
related-docs:
  - ./01-fitness-loop.md
  - ./02-tool-plugin-model.md
  - ./04-contract-surfaces.md
  - ../70-reference/02-package-catalog.md
  - ../80-implementation/05-layer-policy.md
---
# Layered package graph

Sixty-one workspace packages: 58 publishable and three private. Six runtime layers. One
enforced rule: dependencies flow up only.

This document is the conceptual map. For the lookup-shaped catalog of every package's role and exports, jump to [`70-reference/02-package-catalog.md`](../70-reference/02-package-catalog.md). For the literal dep-cruiser rules, see [`80-implementation/05-layer-policy.md`](../80-implementation/05-layer-policy.md).

> **What you'll understand after this:**
> - Why opensip-cli ships as 58 publishable packages instead of one.
> - The six layers, in order, and what each one is for.
> - How the layer rule is enforced (and what happens if you break it).
> - How type-only edges are caught by a second cruiser pass, and the two cross-layer exceptions that were paid down.
> - Trade-offs: what this shape buys you, what it costs.

---

## The six layers

The layer model the dependency-cruiser config enforces ([`.config/dependency-cruiser.cjs`](../../../.config/dependency-cruiser.cjs)):

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer 6  ┌──────────────────────────────────────────────────┐    │
│           │                opensip-cli                       │    │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 5  ┌──────────────────────┴───────────────────────────┐    │
│           │  checks-cpp  checks-go  checks-java  checks-python │   │
│           │  checks-rust  checks-typescript  checks-universal  │   │
│           │  graph-{typescript,python,rust,go,java}            │   │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 4  ┌──────────────────────┴───────────────────────────┐    │
│           │ fitness  simulation  graph  yagni  mcp  tool-*    │   │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 3  ┌──────────┬───────────┴───────────┬───────────────┐    │
│           │  cli-live  session-store  output  config  targeting │  │
│           │  shared-analysis  codebase  dashboard              │   │
│           │  external-tool-adapter  lang-*                     │   │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 2  ┌──────────────────────┴───────────────────────────┐    │
│           │ datastore contracts tree-sitter clone-detection    │   │
│           │ format cli-ui tool-test-kit                         │   │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 1  ┌──────────────────────┴───────────────────────────┐    │
│           │              @opensip-cli/core                   │   │
│           └──────────────────────────────────────────────────┘    │
│                                                                    │
│            (arrows mean "depends on" — strictly upward)            │
└────────────────────────────────────────────────────────────────────┘
```

**Layer 1 — `@opensip-cli/core`.** The kernel. Ships types, errors, IDs, the logger, the path resolver, the language-adapter contract, the plugin discovery mechanics (including the generic marker-discovery walker), and the Tool registry. No knowledge of fitness, simulation, or any other tool. No dependency on Commander, Ink, or any UI library.

**Layer 2 — `@opensip-cli/datastore`, `@opensip-cli/contracts`, `@opensip-cli/tree-sitter`, `@opensip-cli/clone-detection`, `@opensip-cli/format`, `@opensip-cli/cli-ui`, and `@opensip-cli/tool-test-kit`.** Substrate packages above the kernel. Most depend only on `core`; leaf pure packages (`clone-detection`, `format`) depend on nothing. Never on a tool.

- **`@opensip-cli/datastore`** is the persistence kernel — the `DataStore` interface, the SQLite + Drizzle implementation, the in-memory backend for tests, the workspace migration store under `migrations/`. Paradigm-agnostic infrastructure: tools and session-store own their domain schemas (sessions in session-store; baseline/catalog in graph; baseline in fitness) and register them with the datastore at open time. Depends on `core` only.
- **`@opensip-cli/contracts`** is the shared Tool/runner contract facade: the `SignalEnvelope` shape every tool returns, the `CommandOutcome` wrapper the host stamps on machine output, the `CommandResult` union, exit codes, `StoredSession`, and `GraphCatalog`. It also owns small shared host-run runtime helpers such as command-result construction; repository runtime and schemas remain in their owning packages (`SessionRepo` in `session-store`). It imports `core` only and no tool.
- **`@opensip-cli/tree-sitter`** (ADR-0010) is the grammar-agnostic `web-tree-sitter` substrate: the WASM parser lifecycle and grammar-neutral node accessors (`createParser`, `walkNodes`, `findEnclosing`, …). It imports `core` only (plus `web-tree-sitter`) and is consumed from above — by the fitness `lang-*` adapters and the four tree-sitter `graph-*` adapters (through `graph-adapter-common`) — so the WASM lifecycle lives in exactly one place. A dedicated dependency-cruiser rule (`tree-sitter-imports-core-only`) holds it at this substrate position.
- **`@opensip-cli/cli-ui`** is the Ink/React presentational primitives kit (`Banner`, `Spinner`, `RunHeader`, `theme`) — extracted from `cli/` so tools that ship a live view depend on the UI kit without pulling in the dispatcher.

**Layer 3 — persistence/output/config/codebase libraries and language adapters.** Packages above the substrate, depending on `core`/`contracts`/`datastore` (and lower siblings within this layer), never on a tool.

- **`@opensip-cli/cli-live`** owns the shared live-run state machine and `produce()` seam used by bundled Tools without pulling in the CLI dispatcher.
- **`@opensip-cli/session-store`** owns session persistence: the `SessionRepo` runtime, the `sessions`/`session_tool_payload` schema, and the `generateSessionId`/`sanitizeForFilename` helpers. Depends on `core`, `datastore`, and `contracts` (for the `StoredSession` shape it round-trips).
- **`@opensip-cli/output`** (renamed from `@opensip-cli/reporting`, ADR-0011) owns all machine output: pure `(envelope) => string` formatters under `format/` (json, sarif, table) and effectful `sink/` delivery (cloud egress, entitlement). The CLI composition root composes a formatter with a sink per the run's flags; tool engines no longer import it. Depends on `core` and `contracts` only.
- **`@opensip-cli/config`** is the capability-configuration substrate (ADR-0023): the `composeConfigSchema` composer that folds each tool's namespaced Zod schema into one strict whole-document schema, the resolver, and the `ToolConfigDeclaration` declaration type. The dependency-cruiser rule here is **directional**: `config` must not import a tool. Tools, by contrast, **do** import `@opensip-cli/config` — for the `ToolConfigDeclaration` type they use to declare their config namespace. So the edge runs tool → config, never config → tool. Depends on `core`.
- **`@opensip-cli/targeting`** is the host file-targeting runtime substrate (ADR-0037): the `TargetRegistry`, the uniform glob expansion (`resolveTargets`, always applying per-target `exclude` **and** `globalExcludes`), and `applyGlobalExcludes`. The CLI bootstrap builds it once per run from the validated config document and exposes it as `scope.targets`; any tool resolves named file sets without importing fitness. Depends on `config` (targeting types) and `core` (the generic `Registry<T>` base) — never a tool engine. The check-domain half (`checkOverrides`, scope matching, the content `fileCache`) stays in `fitness` as a thin consumer.
- **`@opensip-cli/codebase`** is the persistence-free project inventory substrate: it projects bounded target membership, file metadata, package manifests, and conservative verification commands into deterministic evidence facts. It reads through the captured structural target resolver and retains no source or raw manifest content. Graph and MCP consume it from above.
- **`@opensip-cli/shared-analysis`** is the cross-tool analysis **runtime** extracted from `contracts` ([ADR-0172](../../decisions/ADR-0172-shared-analysis-layer-extraction.md)): the changed→impact compute engine behind `graph impact` and `fit --changed` / `--include-impacted`, review-brief derivation and correlation, and agent-catalog assembly. It depends on `core` and `contracts` only; tool engines and the host depend on **it**, never the reverse (the `shared-analysis-no-tool-or-cli-edges` dep-cruiser rule). The persisted contract shapes those functions produce (the `ReviewBrief*` and `AgentCatalog*` types, zod schemas, and version constants) stay in `contracts`, which remains a genuine type/constant/facade surface.
- **`@opensip-cli/dashboard`** is the self-contained HTML report renderer; consumed by the CLI-owned `report` command and each tool's auto-open hook. It does not implement the `Tool` contract; it is a library the composition root consumes.
- **`@opensip-cli/external-tool-adapter`** is the shared normalization and command substrate for external scanner Tools.
- **Language adapters** — `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp` implement the `LanguageAdapter` contract used by fitness checks. (The graph engine has its own `GraphLanguageAdapter` contract, implemented by the publishable `graph-*` adapter packs at Layer 5.) See [`50-extend/05-language-adapters.md`](../50-extend/05-language-adapters.md) for the distinction.

**Layer 4 — Tools.** `@opensip-cli/fitness`, `@opensip-cli/simulation`, `@opensip-cli/graph`, `@opensip-cli/yagni`, `@opensip-cli/mcp`, and the external scanner `@opensip-cli/tool-*` adapters. Each implements the Tool contract and contributes declarative `commandSpecs`. Peer imports are denied except the explicit MCP → graph public-surface relationship. YAGNI builds its own TypeScript inventory and has no graph dependency; MCP reads graph state through `@opensip-cli/graph/read`, never `graph/internal`.

**Layer 5 — `@opensip-cli/checks-*` and `@opensip-cli/graph-*`.** Seven publishable fitness check packs plus private repository-only `checks-dogfood`; and five graph adapter packs, with the tree-sitter adapters sharing `graph-adapter-common`. These are the marketplace shapes installable without the CLI. Check packs do **not** depend on `cli` or `contracts`.

**Layer 6 — `opensip-cli`.** The composition root. Discovers every first-party tool and language adapter, registers them, builds the Commander tree, runs the dispatcher. The only package that knows everything below it.

The generated architecture map is the inventory source of truth: 61 workspace
packages, 58 publishable, and three private. `@opensip-cli/agent-eval` is a
black-box agent-usability harness outside the runtime layers;
`@opensip-cli/test-support` carries cross-package test scaffolding; and
`@opensip-cli/checks-dogfood` carries this repository's architecture checks.
None is published. The eval harness has zero workspace source edges in either
direction, while the support packages are unavailable to production source.

---

## How the layer rule is enforced

The layer rule — "dependencies flow up only" — is enforced by [dependency-cruiser](../../../.config/dependency-cruiser.cjs) at lint time. The relevant rules:

```js
// core imports nothing else from the workspace.
{ name: 'core-imports-nothing-workspace',
  from: { path: '^packages/core/src/' },
  to:   { path: '^packages/', pathNot: '^packages/core/' },
}

// contracts imports only core.
{ name: 'contracts-imports-core-only', /* ... */ }

// fitness / simulation / graph cannot import cli (would create a cycle).
{ name: 'fitness-no-cli',     from: { path: '^packages/fitness/' },    to: { path: '^opensip-cli($|/)' } }
{ name: 'simulation-no-cli',  from: { path: '^packages/simulation/' }, to: { path: '^opensip-cli($|/)' } }
{ name: 'graph-no-cli',       from: { path: '^packages/graph/' },      to: { path: '^opensip-cli($|/)' } }

// checks-* cannot reach into cli or contracts.
{ name: 'check-pack-no-cli', /* ... */ }

// lang-* cannot reach into cli, contracts, or checks-*.
{ name: 'lang-no-cli-or-shared', /* ... */ }
```

The build runs `pnpm depcruise` as part of the standard `pnpm lint` flow. A forbidden import is a build failure with a precise message: which file, which import, which rule. Refactor the offending edge or move the symbol to a layer where it belongs.

---

## Two cruiser passes — no standing layer exception

Real codebases have edge cases. Two earlier cross-layer exceptions once lived in [`.config/dependency-cruiser.cjs`](../../../.config/dependency-cruiser.cjs); both have since been **paid down** and deleted:

- **`lang-typescript` → `fitness`** (the `filterContent` back-edge): `filterContent` / `clearFilterCache` / `FilteredContent` now live in `@opensip-cli/lang-typescript` itself, so no lang pack reaches up into a tool. The `lang-no-fitness-except-typescript` rule is gone.
- **`graph` → `fitness`** (SARIF reuse): SARIF is now the single shared `formatSignalSarif` formatter in `@opensip-cli/output`, applied at the composition root (ADR-0011) — `graph` returns a `SignalEnvelope` and imports neither fitness nor `@opensip-cli/output`. The `graph-may-import-fitness-sarif` info-exception is gone.

What remains is not an exception but a *second lens*. The layer ruleset runs twice, and both passes gate `pnpm lint`.

### Type-only edges are caught by the type-aware pass

The **runtime pass** ([`.config/dependency-cruiser.cjs`](../../../.config/dependency-cruiser.cjs)) sets `tsPreCompilationDeps: false`, so type-only imports (`import type { ... }`) don't count as edges. It models what actually runs: two files that only `import type` from each other form no runtime cycle, and TypeScript erases those imports, so flagging them would be a false positive.

That leaves a blind spot — a type-only *layer inversion* or *cycle* would be invisible to the runtime pass. The **type-aware pass** ([`.config/dependency-cruiser.types.cjs`](../../../.config/dependency-cruiser.types.cjs)) closes it: it flips `tsPreCompilationDeps: true` and re-runs the **same** `forbidden` ruleset over the type-inclusive graph. Every directional layer rule — and `no-circular` — therefore also fires on type-only edges.

The upshot: there is **no** standing "you may `import type` upward" allowance. A type-only import from a lower layer into a higher one trips the type-aware pass exactly as a runtime import trips the runtime pass. (The historical type-only cycles that predated this pass were paid down before it was promoted from visibility-only to gating.)

---

## Why 58 publishable packages and not 1

A single mega-package was considered. It would compile faster, ship faster, and have a simpler `package.json`. We chose against it for three load-bearing reasons:

### 1. The marketplace shape

A check pack like `@opensip-cli/checks-python` has to be installable on its own. A user who only writes Python should be able to:

```bash
opensip fit plugin add @opensip-cli/checks-python
```

…and not pull in the JavaScript universe. With a single mega-package, every install pulls every check. With 58 publishable packages, an install pulls only what's needed. (Today the bundled distribution still installs everything; tomorrow's tree-shaken or selectively-installed distribution doesn't have to.)

### 2. The Tool contract's promise

The Tool contract says "any npm package can be a Tool." That promise only holds if a Tool can depend on `@opensip-cli/core` *without* depending on `opensip-cli`. With a mega-package, importing `core` would import the entire CLI, including Commander and Ink. A third-party Tool that runs in a non-CLI context (a CI plugin, a server-side runner, a future GUI) couldn't shed those deps.

### 3. The layer rule needs to be visible

A flat package can have any internal structure. With 61 workspace packages, the layer is the directory structure: looking at `packages/` tells you the architecture in five seconds. If a contributor accidentally adds an upward edge, the build fails before the PR is even reviewed. The layer rule isn't aspiration — it's a wall.

---

## What this shape costs

Trade-offs are real. The 60-package workspace is more expensive in three places:

- **More `package.json` files to maintain.** Version bumps span 58 publishable packages; `agent-eval`, `test-support`, and `checks-dogfood` remain private. The root manifest is tooling metadata, not a workspace package. We use `pnpm` workspace protocol (`workspace:*`) so internal deps are auto-linked, and release scripts verify the publishable set in lockstep.
- **More `tsconfig.json` files.** Each package has its own. Project references handle the build graph. The cost is configuration footprint, not build speed.
- **A discovery cost when reading the codebase.** "Where does `Signal` live?" is one search now: `packages/core/src/types/signal.ts`. But "where does `defineCheck` live?" requires knowing the layer (`fitness`) and the framework subdir (`fitness/engine/src/framework/`). The package catalog ([`70-reference/02-package-catalog.md`](../70-reference/02-package-catalog.md)) is the antidote.

We've been comfortable with these costs. They're the price of the marketplace shape and the Tool-contract promise.

---

## A worked example

Tracing the dependency arrows for the `no-console-log` check we followed in [`01-fitness-loop.md`](./01-fitness-loop.md):

```
opensip-cli        ─ dynamic-loads ─►  @opensip-cli/fitness
(resolves manifest,                              │
 dynamic-imports the                             │ imports
 `tool` export — no                              ▼
 static symbol import)                  @opensip-cli/core
                                                 ▲
                                                 │ imports
                                                 │
@opensip-cli/checks-universal ─── imports ──────┘
       │
       │ exports `noConsoleLog`
       ▼
   the CLI's loaded check registry, populated at startup
```

The `cli` imports the bundled language adapters to register them (Layer 5 → Layer 3). First-party tools are not statically imported by runtime symbol: the CLI lists their package names, resolves their manifests on disk, admits them, and dynamic-imports the same `tool` export shape that installed tool plugins use. It does **not** import `checks-universal` directly — instead, the plugin loader walks `node_modules` at runtime and discovers any package declaring the `fit-pack` marker plus target-domain epoch (or listed exactly in `plugins.checkPackages`). The check pack imports `fitness` (for `defineCheck`) and `core` (for `Signal`), both lower layers. Every arrow points up.

---

## Complete boundaries, derived and locked

The layer cake above is enforced by more than the dependency-cruiser layer rules.
Two decisions ([ADR-0151](../../decisions/ADR-0151-manifest-derived-package-and-export-boundaries.md)
and [ADR-0150](../../decisions/ADR-0150-production-builds-publish-runtime-artifacts-only.md))
make the boundaries **derived** and **complete** rather than hand-maintained. The
current package/tool inventory is authoritative in the generated
[`architecture-map.md`](../80-implementation/architecture-map.md) and the release
governance projection, not in a frozen count here:

- **Dynamic CLI Tool loading.** The CLI host statically imports **no** Tool
  runtime (`cli-no-static-tool-package-import`, manifest-derived so it covers a
  Tool with any package name); a bundled Tool and an installed Tool travel the
  same dynamic plugin path, so install-source independence is structural.
- **Fail-closed capability allowlists.** Tool/fit-pack classification comes from
  `opensipTools.kind`; an unlisted fit pack throws at dependency-cruiser config
  load rather than getting a permissive default.
- **Test-only internal subpaths.** Cross-package `/internal` subpaths are matched
  completely (file *and* directory forms); MCP reads graph evidence only through
  the public `@opensip-cli/graph/read` surface, with a single sanctioned
  adapter-registrar root exception.
- **Exact export locks.** Each governed package's public surface is locked as an
  exact **value and type** namespace by a TypeScript-AST walker
  (`verify-core-exports`), so a leaked type is caught even though a runtime
  `Object.keys` check would miss it.
- **Production-only packed output.** Package builds emit runtime bytes only;
  test/spec/fixture trees are excluded from both `tsc` output and the verified
  `pnpm pack` packlist, while test sources stay semantically checked by a
  per-package no-emit test project (ADR-0150).

Every one of these gates ships with a firing probe *and* a legal-edge control in
`scripts/verify-gate-live.mjs`.

## What's next

- **[`04-contract-surfaces.md`](./04-contract-surfaces.md)** — the public edges this layer cake exposes. The Tool contract sits at the top of Layer 3; the JSON output sits across Layer 2.
- **[`../70-reference/02-package-catalog.md`](../70-reference/02-package-catalog.md)** — every package, by layer, with one-line role and key exports. Use this when you're hunting for a symbol.
- **[`../80-implementation/05-layer-policy.md`](../80-implementation/05-layer-policy.md)** — the dep-cruiser config, rule by rule, with rationale.
