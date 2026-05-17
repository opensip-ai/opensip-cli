---
status: current
last_verified: 2026-05-15
title: "Layered package graph"
audience: [contributors]
purpose: "The 18-package monorepo, the five-layer dependency rule, why dependency-cruiser exists, and the trade-offs."
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
  - ../70-reference/01-package-catalog.md
  - ../80-conventions/02-layer-policy.md
---
# Layered package graph

Eighteen packages. Five layers. One enforced rule: dependencies flow up only.

This document is the conceptual map. For the lookup-shaped catalog of every package's role and exports, jump to [`70-reference/01-package-catalog.md`](/docs/opensip-tools/70-reference/01-package-catalog/). For the literal dep-cruiser rules, see [`80-conventions/02-layer-policy.md`](/docs/opensip-tools/80-conventions/02-layer-policy/).

> **What you'll understand after this:**
> - Why opensip-tools ships as 18 packages instead of one.
> - The five layers, in order, and what each one is for.
> - How the layer rule is enforced (and what happens if you break it).
> - The two documented exceptions and why they exist.
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
│           │ checks-cpp  checks-go  checks-java  checks-python │   │
│           │     checks-typescript    checks-universal         │   │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 3  ┌──────────┬───────────┴───────────┬───────────────┐    │
│           │ fitness  │ simulation │ lang-cpp lang-go lang-…  │    │
│           └──────────┴────────────┴──────────────────────────┘    │
│                                  ▲                                 │
│  Layer 2  ┌──────────────────────┴───────────────────────────┐    │
│           │            @opensip-tools/contracts             │    │
│           └──────────────────────────────────────────────────┘    │
│                                  ▲                                 │
│  Layer 1  ┌──────────────────────┴───────────────────────────┐    │
│           │              @opensip-tools/core                 │    │
│           └──────────────────────────────────────────────────┘    │
│                                                                    │
│            (arrows mean "depends on" — strictly upward)            │
└────────────────────────────────────────────────────────────────────┘
```

**Layer 1 — `@opensip-tools/core`.** The kernel. Ships types, errors, IDs, the logger, the path resolver, the language-adapter contract, the plugin discovery mechanics, and the Tool registry. No knowledge of fitness, simulation, or any other tool. No dependency on Commander, Ink, or any UI library.

**Layer 2 — `@opensip-tools/contracts`.** The shared contract layer between Tools and the runner: the `CliOutput`/`CheckOutput`/`FindingOutput` shape every tool produces, the `CommandResult` discriminated union the renderer dispatches on, the exit-code constants, and the session persistence helpers (session writer, dashboard HTML generator). Depends on `core` only. Does not import any tool.

**Layer 3 — `@opensip-tools/fitness`, `@opensip-tools/simulation`, `@opensip-tools/lang-*`.** Peer packages, all depending on `contracts` and `core`. Each tool engine (`fitness`, `simulation`) implements the `Tool` contract. Each language adapter (`lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp`) implements the `LanguageAdapter` contract.

**Layer 4 — `@opensip-tools/checks-*`.** Six check packs: `checks-universal`, `checks-typescript`, `checks-python`, `checks-go`, `checks-java`, `checks-cpp`. Each pack depends on `fitness` (for `defineCheck`) and `core` (for `Signal`, errors, the language adapter type). Check packs do **not** depend on `cli` or `contracts` — they're the marketplace shape, designed to be installable from npm without dragging the CLI in.

**Layer 5 — `@opensip-tools/cli`.** The composition root. Imports every first-party tool and language adapter, registers them, builds the Commander tree, runs the dispatcher. The only package that knows everything below it.

That's it. Five layers, eighteen packages.

---

## How the layer rule is enforced

The layer rule — "dependencies flow up only" — is enforced by [dependency-cruiser](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/.dependency-cruiser.cjs) at lint time. The relevant rules:

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

// fitness / simulation cannot import cli (would create a cycle).
{ name: 'fitness-no-cli',     from: { path: '^packages/fitness/' },    to: { path: '^@opensip-tools/cli($|/)' } }
{ name: 'simulation-no-cli',  from: { path: '^packages/simulation/' }, to: { path: '^@opensip-tools/cli($|/)' } }

// checks-* cannot reach into cli or contracts.
{ name: 'check-pack-no-cli', /* ... */ }

// lang-* cannot reach into cli, contracts, or checks-*.
{ name: 'lang-no-cli-or-shared', /* ... */ }
```

The build runs `pnpm depcruise` as part of the standard `pnpm lint` flow. A forbidden import is a build failure with a precise message: which file, which import, which rule. Refactor the offending edge or move the symbol to a layer where it belongs.

---

## The three documented exceptions

Real codebases have edge cases. This one has three, all written into [`.dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/.dependency-cruiser.cjs).

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

`@opensip-tools/graph` imports `buildSarifLog`, `chunkSarifRuns`, and `reportToCloud` from `@opensip-tools/fitness` (DEC-3 in [`docs/plans/graph-tool-v2-design.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/docs/plans/graph-tool-v2-design.md) Appendix C). Both packages sit at Layer 3 (the tools/lang peer layer); cross-tool imports at the same layer are allowed when the alternative is a duplicate implementation that would drift over time. The dep-cruiser rule restricts the edge to the single permitted file and tags it `info`-severity so the build records but does not reject:

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

## Why 18 packages and not 1

A single mega-package was considered. It would compile faster, ship faster, and have a simpler `package.json`. We chose against it for three load-bearing reasons:

### 1. The marketplace shape

A check pack like `@opensip-tools/checks-python` has to be installable on its own. A user who only writes Python should be able to:

```bash
opensip-tools plugin add @opensip-tools/checks-python
```

…and not pull in the JavaScript universe. With a single mega-package, every install pulls every check. With 18 packages, an install pulls only what's needed. (Today the bundled distribution still installs everything; tomorrow's tree-shaken or selectively-installed distribution doesn't have to.)

### 2. The Tool contract's promise

The Tool contract says "any npm package can be a Tool." That promise only holds if a Tool can depend on `@opensip-tools/core` *without* depending on `@opensip-tools/cli`. With a mega-package, importing `core` would import the entire CLI, including Commander and Ink. A third-party Tool that runs in a non-CLI context (a CI plugin, a server-side runner, a future GUI) couldn't shed those deps.

### 3. The layer rule needs to be visible

A flat package can have any internal structure. With 18 packages, the layer is the directory structure: looking at `packages/` tells you the architecture in five seconds. If a contributor accidentally adds an upward edge, the build fails before the PR is even reviewed. The layer rule isn't aspiration — it's a wall.

---

## What this shape costs

Trade-offs are real. The 18-package layout is more expensive in three places:

- **More `package.json` files to maintain.** Version bumps span 17 files. We use `pnpm` workspace protocol (`workspace:*`) so internal deps are auto-linked, and a release script bumps all 17 in lockstep.
- **More `tsconfig.json` files.** Each package has its own. Project references handle the build graph. The cost is configuration footprint, not build speed.
- **A discovery cost when reading the codebase.** "Where does `Signal` live?" is one search now: `packages/core/src/types/signal.ts`. But "where does `defineCheck` live?" requires knowing the layer (`fitness`) and the framework subdir (`fitness/engine/src/framework/`). The package catalog ([`70-reference/01-package-catalog.md`](/docs/opensip-tools/70-reference/01-package-catalog/)) is the antidote.

We've been comfortable with these costs. They're the price of the marketplace shape and the Tool-contract promise.

---

## A worked example

Tracing the dependency arrows for the `no-console-log` check we followed in [`01-fitness-loop.md`](/docs/opensip-tools/10-mental-model/01-fitness-loop/):

```
@opensip-tools/cli           ─── imports ───►  @opensip-tools/fitness
                                                       │
                                                       │ imports
                                                       ▼
                                              @opensip-tools/core
                                                       ▲
                                                       │ imports
                                                       │
@opensip-tools/checks-typescript ─── imports ──────────┘
       │
       │ exports `noConsoleLogCheck`
       ▼
   the CLI's loaded check registry, populated at startup
```

The `cli` imports `fitness` to get the `fitnessTool` (Layer 5 → Layer 3). It also imports the bundled language adapters to register them (Layer 5 → Layer 3). It does **not** import `checks-typescript` directly — instead, the plugin loader walks `node_modules` at runtime and discovers any package whose name matches `@opensip-tools/checks-*`. The check pack imports `fitness` (for `defineCheck`) and `core` (for `Signal`), both lower layers. Every arrow points up.

---

## What's next

- **[`04-contract-surfaces.md`](/docs/opensip-tools/10-mental-model/04-contract-surfaces/)** — the public edges this layer cake exposes. The Tool contract sits at the top of Layer 3; the JSON output sits across Layer 2.
- **[`../70-reference/01-package-catalog.md`](/docs/opensip-tools/70-reference/01-package-catalog/)** — every package, by layer, with one-line role and key exports. Use this when you're hunting for a symbol.
- **[`../80-conventions/02-layer-policy.md`](/docs/opensip-tools/80-conventions/02-layer-policy/)** — the dep-cruiser config, rule by rule, with rationale.
