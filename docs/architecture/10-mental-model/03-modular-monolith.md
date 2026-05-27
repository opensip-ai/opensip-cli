---
status: current
last_verified: 2026-05-26
release: v2.0.x
title: "Layered package graph"
audience: [contributors]
purpose: "The 27-package monorepo, the five-layer dependency rule, why dependency-cruiser exists, and the trade-offs."
source-files:
  - .dependency-cruiser.cjs
  - pnpm-workspace.yaml
  - package.json
  - packages/*/package.json
  - packages/*/*/package.json
related-docs:
  - ./01-fitness-loop.md
  - ./02-tool-plugin-model.md
  - ./04-contract-surfaces.md
  - ../80-reference/01-package-catalog.md
  - ../90-conventions/02-layer-policy.md
---
# Layered package graph

Twenty-seven packages. Five layers. One enforced rule: dependencies flow up only.

This document is the conceptual map. For the lookup-shaped catalog of every package's role and exports, jump to [`80-reference/01-package-catalog.md`](../80-reference/01-package-catalog.md). For the literal dep-cruiser rules, see [`90-conventions/02-layer-policy.md`](../90-conventions/02-layer-policy.md).

> **What you'll understand after this:**
> - Why opensip-tools ships as 27 packages instead of one.
> - The five layers, in order, and what each one is for.
> - How the layer rule is enforced (and what happens if you break it).
> - The documented exceptions and why they exist.
> - Trade-offs: what this shape buys you, what it costs.

---

## The five layers

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer 5  ┌──────────────────────────────────────────────────┐    │
│           │                @opensip-tools/cli                │    │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 4  ┌──────────────────────┴───────────────────────────┐    │
│           │  checks-cpp  checks-go  checks-java  checks-python│   │
│           │  checks-rust  checks-typescript  checks-universal │   │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 3  ┌──────────┬───────────┴───────────┬───────────────┐    │
│           │  fitness   simulation   graph   dashboard  cli-ui  │   │
│           │  lang-{ts,rust,py,java,go,cpp}                     │   │
│           │  graph-{typescript,python,rust,go,java}            │   │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 2  ┌──────────────────────┴───────────────────────────┐    │
│           │  @opensip-tools/datastore    @opensip-tools/contracts │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 1  ┌──────────────────────┴───────────────────────────┐    │
│           │              @opensip-tools/core                 │    │
│           └──────────────────────────────────────────────────┘    │
│                                                                    │
│            (arrows mean "depends on" — strictly upward)            │
└────────────────────────────────────────────────────────────────────┘
```

**Layer 1 — `@opensip-tools/core`.** The kernel. Ships types, errors, IDs, the logger, the path resolver, the language-adapter contract, the plugin discovery mechanics (including the generic marker-discovery walker), and the Tool registry. No knowledge of fitness, simulation, or any other tool. No dependency on Commander, Ink, or any UI library.

**Layer 2 — `@opensip-tools/datastore` and `@opensip-tools/contracts`.** Two packages, both depending on `core` only.

- **`@opensip-tools/datastore`** is the persistence kernel — the `DataStore` interface, the SQLite + Drizzle implementation, the in-memory backend for tests, the workspace migration store under `migrations/`. Paradigm-agnostic infrastructure: tools own their domain schemas (sessions in contracts; baseline/catalog in graph; baseline in fitness) and register them with the datastore at open time.
- **`@opensip-tools/contracts`** is the shared contract layer between Tools and the runner: the `CliOutput`/`CheckOutput`/`FindingOutput` shape every tool produces, the `CommandResult` discriminated union the renderer dispatches on, the exit-code constants, the `SessionRepo`/`StoredSession` persistence helpers, and the `GraphCatalog` type surface that the graph tool produces and the dashboard consumes. Imports `core` and `datastore`. Does not import any tool.

**Layer 3 — Tools, shared libraries, and language adapters.** Peer packages, all depending on `contracts`, `datastore`, and `core`. Three groups at this layer:

- **Tools** — `@opensip-tools/fitness`, `@opensip-tools/simulation`, `@opensip-tools/graph`. Each implements the `Tool` contract and contributes its own CLI subcommand surface.
- **Shared libraries** — `@opensip-tools/dashboard` (self-contained HTML report renderer; consumed by fitness's `dashboard` command and the auto-open hook) and `@opensip-tools/cli-ui` (Ink/React presentational primitives — `Banner`, `Spinner`, `RunHeader`, `theme` — extracted from `cli/` so tools that ship a live view depend on the UI kit without pulling in the dispatcher). Neither implements the `Tool` contract; they are libraries Tools consume.
- **Language adapters** — `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp` implement the `LanguageAdapter` contract used by fitness checks. The graph engine has its own `GraphLanguageAdapter` contract, implemented by five publishable adapter packages: `graph-typescript`, `graph-python`, `graph-rust`, `graph-go`, `graph-java`. The fitness `lang-*` packages and the graph `graph-*` packages are unrelated siblings at this layer — different contracts, different parser stacks; see [`60-subsystems/01-language-adapters.md`](../60-subsystems/01-language-adapters.md) for the distinction.

**Layer 4 — `@opensip-tools/checks-*`.** Seven check packs: `checks-universal`, `checks-typescript`, `checks-python`, `checks-go`, `checks-java`, `checks-cpp`, `checks-rust`. Each pack depends on `fitness` (for `defineCheck`) and `core` (for `Signal`, errors, the language adapter type). Check packs do **not** depend on `cli` or `contracts` — they're the marketplace shape, designed to be installable from npm without dragging the CLI in.

**Layer 5 — `@opensip-tools/cli`.** The composition root. Imports every first-party tool and language adapter, registers them, builds the Commander tree, runs the dispatcher. The only package that knows everything below it.

That's it. Five layers, twenty-seven packages.

---

## How the layer rule is enforced

The layer rule — "dependencies flow up only" — is enforced by [dependency-cruiser](../../../.dependency-cruiser.cjs) at lint time. The relevant rules:

```js
// core imports nothing else from the workspace.
{ name: 'core-imports-nothing-workspace',
  from: { path: '^packages/core/src/' },
  to:   { path: ['^@opensip-tools/contracts', '^@opensip-tools/cli($|/)',
                 '^@opensip-tools/fitness',    '^@opensip-tools/simulation',
                 '^@opensip-tools/lang-',      '^@opensip-tools/checks-'] },
}

// contracts imports only core.
{ name: 'contracts-imports-core-only', /* ... */ }

// fitness / simulation / graph cannot import cli (would create a cycle).
{ name: 'fitness-no-cli',     from: { path: '^packages/fitness/' },    to: { path: '^@opensip-tools/cli($|/)' } }
{ name: 'simulation-no-cli',  from: { path: '^packages/simulation/' }, to: { path: '^@opensip-tools/cli($|/)' } }
{ name: 'graph-no-cli',       from: { path: '^packages/graph/' },      to: { path: '^@opensip-tools/cli($|/)' } }

// checks-* cannot reach into cli or contracts.
{ name: 'check-pack-no-cli', /* ... */ }

// lang-* cannot reach into cli, contracts, or checks-*.
{ name: 'lang-no-cli-or-shared', /* ... */ }
```

The build runs `pnpm depcruise` as part of the standard `pnpm lint` flow. A forbidden import is a build failure with a precise message: which file, which import, which rule. Refactor the offending edge or move the symbol to a layer where it belongs.

---

## The three documented exceptions

Real codebases have edge cases. This one has three, all written into [`.dependency-cruiser.cjs`](../../../.dependency-cruiser.cjs).

### `lang-typescript` → `fitness`

`@opensip-tools/lang-typescript` re-exports `filterContent`, `clearFilterCache`, and `FilteredContent` from `@opensip-tools/fitness`. Those symbols moved out of `core` during an earlier refactor but the typescript adapter still needs the legacy export path for downstream consumers. The dep-cruiser rule explicitly carves out a hole:

```js
{ name: 'lang-no-fitness-except-typescript',
  from: { path: '^packages/languages/lang-', pathNot: '^packages/languages/lang-typescript/' },
  to:   { path: '^@opensip-tools/fitness' },
}
```

This is a mild architectural smell, not a bug — it means `lang-typescript` lives at Layer 3 like its peers but takes a sideways dep on `fitness`. The exception is named so you trip a different alarm if any *other* lang pack starts taking the same shortcut.

### `graph` → `fitness` (peer-layer SARIF reuse)

`@opensip-tools/graph` imports `buildSarifLog`, `chunkSarifRuns`, and `reportToCloud` from `@opensip-tools/fitness`. Both packages sit at Layer 3 (the tools/lang peer layer); cross-tool imports at the same layer are allowed when the alternative is a duplicate implementation that would drift over time. The dep-cruiser rule restricts the edge to the single permitted file and tags it `info`-severity so the build records but does not reject:

```js
{ name: 'graph-may-import-fitness-sarif',
  severity: 'info',
  from: { path: '^packages/graph/engine/src/render/sarif\\.ts$' },
  to:   { path: '^@opensip-tools/fitness$' },
}
```

The eventual extraction to a shared `@opensip-tools/sarif` package becomes a mechanical refactor when both `fit` and `graph` already import from one source.

### Type-only edges

`tsPreCompilationDeps: false` in the dep-cruiser config means type-only imports (`import type { ... }`) don't count as edges. This avoids false positives where two files form a type-cycle (each one `import type`s a type from the other) that doesn't actually exist at runtime — TypeScript erases those imports. Real runtime cycles are still caught by the `no-circular` rule.

The trade-off: a *true* type-only cycle (which is a structural smell — usually means a type belongs in a third file) won't be flagged here. Knip catches some of these as orphaned types; the rest are caught at type-check time.

---

## Why 27 packages and not 1

A single mega-package was considered. It would compile faster, ship faster, and have a simpler `package.json`. We chose against it for three load-bearing reasons:

### 1. The marketplace shape

A check pack like `@opensip-tools/checks-python` has to be installable on its own. A user who only writes Python should be able to:

```bash
opensip-tools plugin add @opensip-tools/checks-python
```

…and not pull in the JavaScript universe. With a single mega-package, every install pulls every check. With 27 packages, an install pulls only what's needed. (Today the bundled distribution still installs everything; tomorrow's tree-shaken or selectively-installed distribution doesn't have to.)

### 2. The Tool contract's promise

The Tool contract says "any npm package can be a Tool." That promise only holds if a Tool can depend on `@opensip-tools/core` *without* depending on `@opensip-tools/cli`. With a mega-package, importing `core` would import the entire CLI, including Commander and Ink. A third-party Tool that runs in a non-CLI context (a CI plugin, a server-side runner, a future GUI) couldn't shed those deps.

### 3. The layer rule needs to be visible

A flat package can have any internal structure. With 27 packages, the layer is the directory structure: looking at `packages/` tells you the architecture in five seconds. If a contributor accidentally adds an upward edge, the build fails before the PR is even reviewed. The layer rule isn't aspiration — it's a wall.

---

## What this shape costs

Trade-offs are real. The 27-package layout is more expensive in three places:

- **More `package.json` files to maintain.** Version bumps span 19 publishable files (plus the private workspace-root `package.json` for tooling versions). We use `pnpm` workspace protocol (`workspace:*`) so internal deps are auto-linked, and a release script bumps all 19 in lockstep.
- **More `tsconfig.json` files.** Each package has its own. Project references handle the build graph. The cost is configuration footprint, not build speed.
- **A discovery cost when reading the codebase.** "Where does `Signal` live?" is one search now: `packages/core/src/types/signal.ts`. But "where does `defineCheck` live?" requires knowing the layer (`fitness`) and the framework subdir (`fitness/engine/src/framework/`). The package catalog ([`80-reference/01-package-catalog.md`](../80-reference/01-package-catalog.md)) is the antidote.

We've been comfortable with these costs. They're the price of the marketplace shape and the Tool-contract promise.

---

## A worked example

Tracing the dependency arrows for the `no-console-log` check we followed in [`01-fitness-loop.md`](./01-fitness-loop.md):

```
@opensip-tools/cli           ─── imports ───►  @opensip-tools/fitness
                                                       │
                                                       │ imports
                                                       ▼
                                              @opensip-tools/core
                                                       ▲
                                                       │ imports
                                                       │
@opensip-tools/checks-universal ─── imports ──────────┘
       │
       │ exports `noConsoleLog`
       ▼
   the CLI's loaded check registry, populated at startup
```

The `cli` imports `fitness` to get the `fitnessTool` (Layer 5 → Layer 3). It also imports the bundled language adapters to register them (Layer 5 → Layer 3). It does **not** import `checks-universal` directly — instead, the plugin loader walks `node_modules` at runtime and discovers any package whose name matches `@opensip-tools/checks-*`. The check pack imports `fitness` (for `defineCheck`) and `core` (for `Signal`), both lower layers. Every arrow points up.

---

## What's next

- **[`04-contract-surfaces.md`](./04-contract-surfaces.md)** — the public edges this layer cake exposes. The Tool contract sits at the top of Layer 3; the JSON output sits across Layer 2.
- **[`../80-reference/01-package-catalog.md`](../80-reference/01-package-catalog.md)** — every package, by layer, with one-line role and key exports. Use this when you're hunting for a symbol.
- **[`../90-conventions/02-layer-policy.md`](../90-conventions/02-layer-policy.md)** — the dep-cruiser config, rule by rule, with rationale.
