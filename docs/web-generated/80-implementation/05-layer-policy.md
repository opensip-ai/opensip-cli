---
status: current
last_verified: 2026-05-26
release: v2.0.0
title: "Layer policy"
audience: [contributors]
purpose: "The dependency-cruiser rules that enforce the five-layer package graph and the tool-internal partitioning rules (graph stages, dashboard panels), rule by rule, with rationale."
source-files:
  - .dependency-cruiser.cjs
  - pnpm-workspace.yaml
related-docs:
  - ../10-concepts/03-modular-monolith.md
  - ./04-coding-standards.md
  - ../70-reference/02-package-catalog.md
  - ../80-implementation/03-session-and-persistence.md
---
# Layer policy

The five-layer package graph (core → datastore/contracts → tools/libraries/adapters → checks → cli) is enforced by [dependency-cruiser](https://github.com/sverweij/dependency-cruiser). Build fails on any forbidden edge. This doc walks every rule and the reasoning.

For the conceptual layer narrative, see [`../10-concepts/03-modular-monolith.md`](/docs/opensip-tools/10-concepts/03-modular-monolith/).

The literal rules are at [`.dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.0/.dependency-cruiser.cjs).

---

## Generic hygiene rules

Three rules unrelated to the layer architecture but enforced workspace-wide.

### `no-circular`

```js
{ name: 'no-circular', from: {}, to: { circular: true } }
```

No circular dependencies between modules within a package. Type-only cycles are allowed (`tsPreCompilationDeps: false`); runtime cycles are forbidden. A circular runtime dep is a structural smell — usually means a type or constant belongs in a third file.

### `no-deprecated-core`

```js
{
  from: {},
  to: {
    dependencyTypes: ['core'],
    path: ['^(punycode|domain|constants|sys|_linklist|_stream_wrap)$'],
  },
}
```

No imports from deprecated/removed Node core modules. Catches accidental usage of legacy Node APIs.

### `not-to-spec` and `not-to-dev-dep`

Production code can't import test files; source code can't import devDependencies. These rules guard the runtime surface — a check pack accidentally importing vitest would crash any consumer who installed the pack as a regular dep.

```js
{ name: 'not-to-spec',
  from: { pathNot: ['/__tests__/', '\\.test\\.(ts|tsx)$'] },
  to:   { path: ['/__tests__/', '\\.test\\.(ts|tsx)$'] },
}

{ name: 'not-to-dev-dep',
  from: { path: '^packages/', pathNot: ['/__tests__/', '\\.test\\.(ts|tsx)$'] },
  to:   { dependencyTypes: ['npm-dev'] },
}
```

---

## Layer enforcement rules

The eight rules that pin the cross-package layer cake.

### `core-imports-nothing-workspace`

```js
{
  from: { path: '^packages/core/src/' },
  to: {
    path: [
      '^@opensip-tools/datastore',
      '^@opensip-tools/contracts',
      '^@opensip-tools/cli($|/)',
      '^@opensip-tools/fitness',
      '^@opensip-tools/simulation',
      '^@opensip-tools/lang-',
      '^@opensip-tools/checks-',
    ],
  },
}
```

The kernel imports nothing from the workspace. Period.

This is the load-bearing rule. The kernel is what every Tool depends on; if the kernel reached up to a Tool, every Tool would transitively import every other Tool. The Tool plugin model breaks; the layer cake collapses.

The rule's path-list is exhaustive — every package outside `packages/core/` is forbidden. Adding a new package below `core` would require updating this rule (it doesn't, today — the kernel is the bottom).

### `datastore-imports-core-only`

```js
{
  from: { path: '^packages/datastore/src/' },
  to: {
    path: [
      '^@opensip-tools/contracts',
      '^@opensip-tools/cli($|/)',
      '^@opensip-tools/fitness',
      '^@opensip-tools/simulation',
      '^@opensip-tools/lang-',
      '^@opensip-tools/checks-',
      '^@opensip-tools/graph',
    ],
  },
}
```

`@opensip-tools/datastore` is paradigm-agnostic infrastructure (SQLite + Drizzle wrapper, factory, migration runner). It depends on `core` only — not on any tool, lang pack, check pack, or contracts package.

The reasoning mirrors `contracts`: schemas live with their owning packages (sessions in contracts; baseline/catalog in graph; baseline in fitness). Datastore knows nothing about domain shapes — bundling them would invert the ownership and force schema changes to ripple through datastore.

For the deeper rationale (why a separate package, why not core, why not contracts), see [`../80-implementation/03-session-and-persistence.md`](/docs/opensip-tools/80-implementation/03-session-and-persistence/) and the persistence-migration decisions log.

### `contracts-imports-core-only`

```js
{
  from: { path: '^packages/contracts/src/' },
  to: {
    path: [
      '^@opensip-tools/cli($|/)',
      '^@opensip-tools/fitness',
      '^@opensip-tools/simulation',
      '^@opensip-tools/lang-',
      '^@opensip-tools/checks-',
    ],
  },
}
```

`contracts` depends only on `core`. It can't reach up to a tool, the CLI, or check packs.

The reasoning: contracts exists to define the contract surface (`CliOutput`, `CommandResult`, `EXIT_CODES`) that *every* Tool consumes. If it took a dep on one Tool, it'd be coupled to that Tool's lifecycle.

### `fitness-no-cli` and `simulation-no-cli`

```js
{ name: 'fitness-no-cli',     from: { path: '^packages/fitness/' },    to: { path: '^@opensip-tools/cli($|/)' } }
{ name: 'simulation-no-cli',  from: { path: '^packages/simulation/' }, to: { path: '^@opensip-tools/cli($|/)' } }
```

Tools cannot import the CLI. This would create a cycle (cli depends on every tool). Tools call back into shared CLI infrastructure via `ToolCliContext` (the inversion-of-control seam from the Tool contract).

### `check-pack-no-cli`

```js
{
  from: { path: '^packages/fitness/checks-' },
  to: {
    path: ['^@opensip-tools/cli($|/)', '^@opensip-tools/contracts'],
  },
}
```

Check packs are self-contained units of fitness-domain logic. They depend on `fitness` (for `defineCheck`) and `core` (for `Signal`, errors). They don't depend on the CLI or contracts — they're the marketplace shape, designed to be installable from npm without dragging the CLI in.

A consumer using `@opensip-tools/checks-typescript` from inside their own custom Tool gets the checks without the CLI's transitive deps.

### `lang-no-cli-or-contracts`

```js
{
  from: { path: '^packages/languages/lang-' },
  to: {
    path: ['^@opensip-tools/cli($|/)', '^@opensip-tools/contracts', '^@opensip-tools/checks-'],
  },
}
```

Language adapter packages depend only on `core` (for the `LanguageAdapter` contract). They don't reach into the CLI, contracts, or check packs.

The lang layer is below check packs in the implicit ordering, even though both sit at "Layer 3" in the conceptual model — a check pack imports `lang-typescript` (transitively, through the framework's adapter dispatch), but a lang pack never imports a check pack.

### `lang-no-fitness-except-typescript`

```js
{
  from: { path: '^packages/languages/lang-', pathNot: '^packages/languages/lang-typescript/' },
  to: { path: '^@opensip-tools/fitness' },
}
```

The documented exception. `@opensip-tools/lang-typescript` re-exports `filterContent`, `clearFilterCache`, and `FilteredContent` from `@opensip-tools/fitness`. Those moved out of `core` during an earlier refactor but the typescript adapter still re-exports them for downstream consumers.

The exception is named so any *other* lang pack reaching into fitness trips a different rule. If we ever do remove the typescript adapter's fitness import, this rule becomes a flat "lang packs depend only on core."

---

## Tool-internal partitioning rules

Beyond the cross-package layer cake, two tools define their own internal-shape rules. These don't enforce the package layering — they enforce per-tool stage discipline (graph) and dashboard-panel isolation.

### Graph tool — the six-stage pipeline and adapter-package isolation

Ten rules in `.dependency-cruiser.cjs` keep the graph tool's stages clean and the adapter packs isolated. Six pin the original cross-stage discipline (rules-no-parser, renderers-no-pipeline, visitors-resolvers-disjoint, etc.); four landed in v2.0.0 when the graph language adapters were extracted into their own publishable npm packages under `packages/graph/graph-*/`; one is the `info`-severity allow-rule for the documented SARIF cross-tool edge.

**Engine ↔ adapter-pack boundaries** (the v2.0.0 split):

- **`graph-no-cli`** — graph engine doesn't import the CLI.
- **`graph-no-check-packs`** — graph engine never reaches into fitness check packs.
- **`graph-engine-no-adapter-packs`** *(v2.0.0)* — the engine package must not depend on any `@opensip-tools/graph-*` adapter pack. Adapters are downstream consumers discovered through the registry walker, not import edges. The inverse (engine → adapter) would create a cycle and defeat the package split. (Engine `__tests__/` are exempt — tests may pull adapter packs as devDeps.)
- **`graph-adapters-disjoint`** *(v2.0.0)* — adapter packs must not import each other from production source. Each pack implements the contract for one language; cross-pack imports would couple parser ecosystems together. (Test sources may consume sibling adapter packs as devDeps for multi-adapter contract / registry / `pickAdapter` coverage.)
- **`graph-adapters-no-cli`** *(v2.0.0)* — adapter packs must not depend on `@opensip-tools/cli`.
- **`graph-adapters-no-fitness-or-checks`** *(v2.0.0)* — adapter packs must not depend on `@opensip-tools/fitness` or any `@opensip-tools/checks-*` package (peer-layer isolation).

**In-engine stage discipline** (unchanged from the pre-split layout, just with no `engine/src/lang-*` subtrees to police):

- **`graph-rules-no-parser`** — Stage 4 rules consume frozen catalog/indexes only; they must not import any pipeline stage.
- **`graph-renderers-no-pipeline`** — Stage 5 renderers consume `Signal[]` and a `RenderContext`; no `pipeline/` or `rules/` import.
- **`graph-visitors-resolvers-disjoint`** — inventory visitors don't import edge resolvers. Now scoped to `packages/graph/graph-typescript/src/` (the TS adapter is the only adapter with the visitor/resolver split).
- **`graph-resolvers-visitors-disjoint`** — symmetric counterpart.
- **`graph-may-import-fitness-sarif`** — `info`-severity allow rule that records (but does not reject) the documented `graph/engine/src/render/sarif.ts → @opensip-tools/fitness` peer-layer edge from DEC-3.

**Dropped in v2.0.0** (recorded here so future spelunkers don't wonder where they went):

- `graph-no-typescript-import-outside-lang-typescript` — the engine no longer declares `typescript` as a dependency (it ships only in `@opensip-tools/graph-typescript`). No engine source file can import the TS compiler API; the package edge enforces this by construction.
- `graph-no-tree-sitter-import-outside-lang-packs` — same story for tree-sitter. The engine has no tree-sitter dep; tree-sitter ships only as a dep of the `@opensip-tools/graph-(python|rust|go|java)` adapter packs.
- `graph-pipeline-no-lang-import` and `graph-orchestrate-no-direct-lang-import` — with all five adapter subtrees relocated into their own packages, the engine has no `engine/src/lang-*` directory to police. The package-edge rule `graph-engine-no-adapter-packs` takes over and is strictly stronger because pnpm + the lockfile enforce package edges by construction.

These mirror the conceptual six-stage pipeline ([`../40-graph/01-stages-and-catalog.md`](/docs/opensip-tools/40-graph/01-stages-and-catalog/)) and the language-pluggability layering ([`../40-graph/03-adding-a-language.md`](/docs/opensip-tools/40-graph/03-adding-a-language/)). Stages can't reach forward; visitors and resolvers share helpers, not each other; rules and renderers consume frozen data; language-specific code is quarantined to its own publishable adapter package.

### Dashboard — panel isolation

Six rules guard the dashboard's HTML-generator package against the failure modes that broke earlier panel layouts:

- **`dashboard-no-graph-import`** — dashboard panels don't pull `@opensip-tools/graph` (the dashboard receives a serialized `GraphCatalog`; the graph engine's runtime never ships to the browser).
- **`dashboard-code-paths-self-contained`** — the Code Paths panel's helpers don't import other panels.
- **`dashboard-views-disjoint`** — each Code Paths view stays in its own file; views can't import each other.
- **`dashboard-algorithms-no-view-deps`** — Code Paths algorithms (Tarjan, BFS, etc.) don't import any view-specific code.
- **`dashboard-no-side-stylesheets`** — only the central CSS module emits styles.
- **`dashboard-no-ui-framework`** — no React, Vue, Svelte, or other UI-framework imports inside the dashboard. The dashboard is hand-written DOM; bundling a framework would balloon the static HTML.

These rules exist because the dashboard ships as a single self-contained `index.html`. Every layering violation here would either bloat the file, break the no-server promise, or reintroduce the panel-cross-talk bugs the v3 refactor untangled.

---

## What this enforces in practice

Concrete examples of edges that fail the build:

- **`packages/core/src/foo.ts` imports from `@opensip-tools/fitness`** — `core-imports-nothing-workspace` fails. Move the fitness-using code to a higher layer.
- **`packages/fitness/engine/src/foo.ts` imports from `@opensip-tools/cli`** — `fitness-no-cli` fails. Use `ToolCliContext` instead.
- **`packages/fitness/checks-typescript/src/foo.ts` imports from `@opensip-tools/cli`** — `check-pack-no-cli` fails. Check packs only depend on fitness + core.
- **`packages/languages/lang-rust/src/foo.ts` imports from `@opensip-tools/fitness`** — `lang-no-fitness-except-typescript` fails. Only the typescript adapter is exempt.
- **`packages/contracts/src/foo.ts` imports from `@opensip-tools/simulation`** — `contracts-imports-core-only` fails. contracts talks to core only.
- **`packages/graph/engine/src/rules/foo.ts` imports `typescript` or anything under `pipeline/`** — `graph-rules-no-parser` fails. Rules consume frozen catalog/indexes only.
- **`packages/graph/engine/src/render/foo.ts` imports from `pipeline/` or `rules/`** — `graph-renderers-no-pipeline` fails. Renderers consume `Signal[]`.
- **`packages/graph/engine/src/pipeline/inventory-visitors/foo.ts` imports from `pipeline/edge-resolvers/`** — `graph-visitors-resolvers-disjoint` fails (and the symmetric counterpart). They share helpers, not each other.
- **A circular import inside any package** — `no-circular` fails. Refactor.

All of these surface during `pnpm depcruise` (run as part of `pnpm lint`). Each violation prints the offending file, the import line, and the rule name.

---

## How to add a new exception

The three existing exceptions (`tsPreCompilationDeps: false` for type-only edges; `lang-typescript → fitness` for legacy re-exports; `graph → fitness` via `render/sarif.ts` for the SARIF helpers per DEC-3) cover the realistic cases. New exceptions are rare and require justification.

Process:

1. Confirm the edge is genuinely necessary — most "I need this" cases turn out to be a different module belonging at a different layer.
2. Open a PR that:
   - Adds the rule exception in `.dependency-cruiser.cjs` with a `comment:` field describing the rationale.
   - Updates this doc with the new exception.
   - Updates [`../10-concepts/03-modular-monolith.md`](/docs/opensip-tools/10-concepts/03-modular-monolith/) if the layer rule's *meaning* changes.
3. Get review explicitly on the layer impact — not just the code-level change.

Exceptions are debt. Each one weakens the architectural promise. Add them when you must, and document them in plain English.

---

## What this doesn't enforce

A few patterns dep-cruiser can't catch but the workspace still cares about:

- **Public-API minimization.** A package can re-export anything from its `index.ts`; the dep-cruiser rules only see the modules that import it. Knip catches unused exports; the team's review catches over-exposed APIs.
- **Naming consistency.** Conventions like "checks live under `src/checks/`" or "tests are `*.test.ts`" are documented but not lint-enforced.
- **Layer sanity within a single package.** A package's internal subdirectories can have any shape; the rules only fire on cross-package edges.

These are review concerns. The layer rules pin the load-bearing constraint; the rest is the contributor's responsibility.

---

## What's next

- **[`04-coding-standards.md`](/docs/opensip-tools/80-implementation/04-coding-standards/)** — TypeScript and ESLint conventions inside the layered packages.
- **[`../10-concepts/03-modular-monolith.md`](/docs/opensip-tools/10-concepts/03-modular-monolith/)** — the conceptual narrative behind these rules.
- **[`../70-reference/02-package-catalog.md`](/docs/opensip-tools/70-reference/02-package-catalog/)** — the package list, organized by layer.
