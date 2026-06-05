---
status: current
last_verified: 2026-06-04
release: v2.6.x
title: "Layered package graph"
audience: [contributors]
purpose: "The 30-package monorepo, the five-layer dependency rule, why dependency-cruiser exists, and the trade-offs."
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
  - ../70-reference/02-package-catalog.md
  - ../80-implementation/05-layer-policy.md
---
# Layered package graph

Thirty packages. Five layers. One enforced rule: dependencies flow up only.

This document is the conceptual map. For the lookup-shaped catalog of every package's role and exports, jump to [`70-reference/02-package-catalog.md`](/docs/opensip-tools/70-reference/02-package-catalog/). For the literal dep-cruiser rules, see [`80-implementation/05-layer-policy.md`](/docs/opensip-tools/80-implementation/05-layer-policy/).

> **What you'll understand after this:**
> - Why opensip-tools ships as 30 packages instead of one.
> - The five layers, in order, and what each one is for.
> - How the layer rule is enforced (and what happens if you break it).
> - How type-only edges are caught by a second cruiser pass, and the two cross-layer exceptions that were paid down.
> - Trade-offs: what this shape buys you, what it costs.

---

## The five layers

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer 5  ┌──────────────────────────────────────────────────┐    │
│           │                opensip-tools                │    │
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
│           │  datastore   contracts   session-store   reporting │   │
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

**Layer 2 — `@opensip-tools/datastore`, `@opensip-tools/contracts`, `@opensip-tools/session-store`, and `@opensip-tools/output`.** Four packages above the kernel, each depending only on `core` and (where noted) on lower siblings within this layer — never on a tool.

- **`@opensip-tools/datastore`** is the persistence kernel — the `DataStore` interface, the SQLite + Drizzle implementation, the in-memory backend for tests, the workspace migration store under `migrations/`. Paradigm-agnostic infrastructure: tools and session-store own their domain schemas (sessions in session-store; baseline/catalog in graph; baseline in fitness) and register them with the datastore at open time. Depends on `core` only.
- **`@opensip-tools/contracts`** is the shared contract layer between Tools and the runner: the `SignalEnvelope` shape every tool returns (with its `verdict`/`units[]`/`signals[]`), the `CommandResult` discriminated union the renderer dispatches on, the exit-code constants, the cross-tool `StoredSession` type, and the `GraphCatalog` type surface that the graph tool produces and the dashboard consumes. A types-and-constants surface — the `SessionRepo` runtime and sessions schema live in `session-store`, not here. Imports `core` and `datastore`. Does not import any tool.
- **`@opensip-tools/session-store`** owns session persistence: the `SessionRepo` runtime, the `sessions`/`session_checks`/`session_findings` schema, and the `generateSessionId`/`sanitizeForFilename` helpers. Depends on `core`, `datastore`, and `contracts` (for the `StoredSession` shape it round-trips).
- **`@opensip-tools/output`** (renamed from `@opensip-tools/reporting`, ADR-0011) owns all machine output: pure `(envelope) => string` formatters under `format/` (json, sarif, table) and effectful `sink/` delivery (cloud egress, entitlement). The CLI composition root composes a formatter with a sink per the run's flags; tool engines no longer import it. Depends on `core` and `contracts` only.

**Layer 3 — Tools, shared libraries, and language adapters.** Peer packages, all depending on `contracts`, `datastore`, and `core`. Three groups at this layer:

- **Tools** — `@opensip-tools/fitness`, `@opensip-tools/simulation`, `@opensip-tools/graph`. Each implements the `Tool` contract and contributes its own CLI subcommand surface.
- **Shared libraries** — `@opensip-tools/dashboard` (self-contained HTML report renderer; consumed by fitness's `dashboard` command and the auto-open hook) and `@opensip-tools/cli-ui` (Ink/React presentational primitives — `Banner`, `Spinner`, `RunHeader`, `theme` — extracted from `cli/` so tools that ship a live view depend on the UI kit without pulling in the dispatcher). Neither implements the `Tool` contract; they are libraries Tools consume.
- **Language adapters** — `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp` implement the `LanguageAdapter` contract used by fitness checks. The graph engine has its own `GraphLanguageAdapter` contract, implemented by five publishable adapter packages: `graph-typescript`, `graph-python`, `graph-rust`, `graph-go`, `graph-java` (the latter four share `graph-adapter-common`, a scaffolding package hosting the tree-sitter discover/parse/walk/cache-key factories). The fitness `lang-*` packages and the graph `graph-*` packages are unrelated siblings at this layer — different contracts, different parser stacks; see [`50-extend/05-language-adapters.md`](/docs/opensip-tools/50-extend/05-language-adapters/) for the distinction.

**Layer 4 — `@opensip-tools/checks-*`.** Seven check packs: `checks-universal`, `checks-typescript`, `checks-python`, `checks-go`, `checks-java`, `checks-cpp`, `checks-rust`. Each pack depends on `fitness` (for `defineCheck`) and `core` (for `Signal`, errors, the language adapter type). Check packs do **not** depend on `cli` or `contracts` — they're the marketplace shape, designed to be installable from npm without dragging the CLI in.

**Layer 5 — `opensip-tools`.** The composition root. Imports every first-party tool and language adapter, registers them, builds the Commander tree, runs the dispatcher. The only package that knows everything below it.

That's it. Five layers, thirty packages.

---

## How the layer rule is enforced

The layer rule — "dependencies flow up only" — is enforced by [dependency-cruiser](https://github.com/opensip-ai/opensip-tools/blob/v2.6.2/.dependency-cruiser.cjs) at lint time. The relevant rules:

```js
// core imports nothing else from the workspace.
{ name: 'core-imports-nothing-workspace',
  from: { path: '^packages/core/src/' },
  to:   { path: ['^@opensip-tools/contracts', '^opensip-tools($|/)',
                 '^@opensip-tools/fitness',    '^@opensip-tools/simulation',
                 '^@opensip-tools/lang-',      '^@opensip-tools/checks-'] },
}

// contracts imports only core.
{ name: 'contracts-imports-core-only', /* ... */ }

// fitness / simulation / graph cannot import cli (would create a cycle).
{ name: 'fitness-no-cli',     from: { path: '^packages/fitness/' },    to: { path: '^opensip-tools($|/)' } }
{ name: 'simulation-no-cli',  from: { path: '^packages/simulation/' }, to: { path: '^opensip-tools($|/)' } }
{ name: 'graph-no-cli',       from: { path: '^packages/graph/' },      to: { path: '^opensip-tools($|/)' } }

// checks-* cannot reach into cli or contracts.
{ name: 'check-pack-no-cli', /* ... */ }

// lang-* cannot reach into cli, contracts, or checks-*.
{ name: 'lang-no-cli-or-shared', /* ... */ }
```

The build runs `pnpm depcruise` as part of the standard `pnpm lint` flow. A forbidden import is a build failure with a precise message: which file, which import, which rule. Refactor the offending edge or move the symbol to a layer where it belongs.

---

## Two cruiser passes — no standing layer exception

Real codebases have edge cases. Two earlier cross-layer exceptions once lived in [`.dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.2/.dependency-cruiser.cjs); both have since been **paid down** and deleted:

- **`lang-typescript` → `fitness`** (the `filterContent` back-edge): `filterContent` / `clearFilterCache` / `FilteredContent` now live in `@opensip-tools/lang-typescript` itself, so no lang pack reaches up into a tool. The `lang-no-fitness-except-typescript` rule is gone.
- **`graph` → `fitness`** (SARIF reuse): SARIF is now the single shared `formatSignalSarif` formatter in `@opensip-tools/output`, applied at the composition root (ADR-0011) — `graph` returns a `SignalEnvelope` and imports neither fitness nor `@opensip-tools/output`. The `graph-may-import-fitness-sarif` info-exception is gone.

What remains is not an exception but a *second lens*. The layer ruleset runs twice, and both passes gate `pnpm lint`.

### Type-only edges are caught by the type-aware pass

The **runtime pass** ([`.dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.2/.dependency-cruiser.cjs)) sets `tsPreCompilationDeps: false`, so type-only imports (`import type { ... }`) don't count as edges. It models what actually runs: two files that only `import type` from each other form no runtime cycle, and TypeScript erases those imports, so flagging them would be a false positive.

That leaves a blind spot — a type-only *layer inversion* or *cycle* would be invisible to the runtime pass. The **type-aware pass** ([`.dependency-cruiser.types.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.2/.dependency-cruiser.types.cjs)) closes it: it flips `tsPreCompilationDeps: true` and re-runs the **same** `forbidden` ruleset over the type-inclusive graph. Every directional layer rule — and `no-circular` — therefore also fires on type-only edges.

The upshot: there is **no** standing "you may `import type` upward" allowance. A type-only import from a lower layer into a higher one trips the type-aware pass exactly as a runtime import trips the runtime pass. (The historical type-only cycles that predated this pass were paid down before it was promoted from visibility-only to gating.)

---

## Why 30 packages and not 1

A single mega-package was considered. It would compile faster, ship faster, and have a simpler `package.json`. We chose against it for three load-bearing reasons:

### 1. The marketplace shape

A check pack like `@opensip-tools/checks-python` has to be installable on its own. A user who only writes Python should be able to:

```bash
opensip-tools plugin add @opensip-tools/checks-python
```

…and not pull in the JavaScript universe. With a single mega-package, every install pulls every check. With 30 packages, an install pulls only what's needed. (Today the bundled distribution still installs everything; tomorrow's tree-shaken or selectively-installed distribution doesn't have to.)

### 2. The Tool contract's promise

The Tool contract says "any npm package can be a Tool." That promise only holds if a Tool can depend on `@opensip-tools/core` *without* depending on `opensip-tools`. With a mega-package, importing `core` would import the entire CLI, including Commander and Ink. A third-party Tool that runs in a non-CLI context (a CI plugin, a server-side runner, a future GUI) couldn't shed those deps.

### 3. The layer rule needs to be visible

A flat package can have any internal structure. With 30 packages, the layer is the directory structure: looking at `packages/` tells you the architecture in five seconds. If a contributor accidentally adds an upward edge, the build fails before the PR is even reviewed. The layer rule isn't aspiration — it's a wall.

---

## What this shape costs

Trade-offs are real. The 30-package layout is more expensive in three places:

- **More `package.json` files to maintain.** Version bumps span 30 publishable files (plus the private workspace-root `package.json` for tooling versions). We use `pnpm` workspace protocol (`workspace:*`) so internal deps are auto-linked, and a release script bumps all 30 in lockstep.
- **More `tsconfig.json` files.** Each package has its own. Project references handle the build graph. The cost is configuration footprint, not build speed.
- **A discovery cost when reading the codebase.** "Where does `Signal` live?" is one search now: `packages/core/src/types/signal.ts`. But "where does `defineCheck` live?" requires knowing the layer (`fitness`) and the framework subdir (`fitness/engine/src/framework/`). The package catalog ([`70-reference/02-package-catalog.md`](/docs/opensip-tools/70-reference/02-package-catalog/)) is the antidote.

We've been comfortable with these costs. They're the price of the marketplace shape and the Tool-contract promise.

---

## A worked example

Tracing the dependency arrows for the `no-console-log` check we followed in [`01-fitness-loop.md`](/docs/opensip-tools/10-concepts/01-fitness-loop/):

```
opensip-tools           ─── imports ───►  @opensip-tools/fitness
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

The `cli` imports `fitness` to get the `fitnessTool` (Layer 5 → Layer 3). It also imports the bundled language adapters to register them (Layer 5 → Layer 3). It does **not** import `checks-universal` directly — instead, the plugin loader walks `node_modules` at runtime and discovers any package declaring `opensipTools.kind: "fit-pack"` (the `@opensip-tools/checks-*` name prefix is a deprecated fallback; see ADR-0007). The check pack imports `fitness` (for `defineCheck`) and `core` (for `Signal`), both lower layers. Every arrow points up.

---

## What's next

- **[`04-contract-surfaces.md`](/docs/opensip-tools/10-concepts/04-contract-surfaces/)** — the public edges this layer cake exposes. The Tool contract sits at the top of Layer 3; the JSON output sits across Layer 2.
- **[`../70-reference/02-package-catalog.md`](/docs/opensip-tools/70-reference/02-package-catalog/)** — every package, by layer, with one-line role and key exports. Use this when you're hunting for a symbol.
- **[`../80-implementation/05-layer-policy.md`](/docs/opensip-tools/80-implementation/05-layer-policy/)** — the dep-cruiser config, rule by rule, with rationale.
