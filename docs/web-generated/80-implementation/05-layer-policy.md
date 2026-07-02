---
status: current
last_verified: 2026-06-14
release: v0.2.2
title: "Layer policy"
audience: [contributors]
purpose: "The dependency-cruiser rules that enforce the six-layer package graph and the tool-internal partitioning rules (graph stages, dashboard panels), rule by rule, with rationale."
source-files:
  - .config/dependency-cruiser.cjs
  - pnpm-workspace.yaml
related-docs:
  - ../10-concepts/03-modular-monolith.md
  - ./04-coding-standards.md
  - ../70-reference/02-package-catalog.md
  - ../80-implementation/03-session-and-persistence.md
---
# Layer policy

The six-layer package graph (core → substrates → shared libraries/adapters → tools → check/adapter packs → cli) is enforced by [dependency-cruiser](https://github.com/sverweij/dependency-cruiser). Build fails on any forbidden edge. This doc walks every rule and the reasoning.

For the conceptual layer narrative, see [`../10-concepts/03-modular-monolith.md`](/docs/opensip-cli/10-concepts/03-modular-monolith/).

The literal rules are at [`.config/dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/.config/dependency-cruiser.cjs).

---

## Generic hygiene rules

Three rules unrelated to the layer architecture but enforced workspace-wide.

### `no-circular`

```js
{ name: 'no-circular', from: {}, to: { circular: true } }
```

No circular dependencies between modules within a package. The main pass ignores type-only edges (`tsPreCompilationDeps: false`) so it flags only runtime cycles; the type-aware pass (`.config/dependency-cruiser.types.cjs`) re-runs `no-circular` over the type-inclusive graph, so type-only cycles are caught too. A circular dep — runtime or type-only — is a structural smell, usually meaning a type or constant belongs in a third file.

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

### `not-to-spec` and dev-dependency hygiene

Production code can't import test files, and source code can't import undeclared runtime dependencies. These guards protect the runtime surface — a check pack accidentally importing vitest would crash any consumer who installed the pack as a regular dep.

```js
{ name: 'not-to-spec',
  from: { pathNot: ['/__tests__/', '\\.test\\.(ts|tsx)$'] },
  to:   { path: ['/__tests__/', '\\.test\\.(ts|tsx)$'] },
}
```

`not-to-spec` lives in dependency-cruiser because it is a workspace file edge. Dev-dependency hygiene lives in ESLint (`import-x/no-extraneous-dependencies`, `.config/eslint.config.mjs`) because dependency-cruiser intentionally drops almost all `node_modules` edges under this config; a `to: { dependencyTypes: ['npm-dev'] }` cruiser rule would be structurally inert here.

---

## Layer enforcement rules

The rules that pin the cross-package layer cake. The set below covers the load-bearing ones (core, datastore, contracts, config, fitness/simulation/graph, language/check/adapter-pack isolation). Several runtime packages carry their own narrow allowlist rules in the same shape: `session-store-imports-core-datastore-contracts-only`, `output-imports-core-contracts-only`, `config-imports-core-only`, `targeting-imports-config-core-only` (ADR-0037), `dashboard-imports-only-core-contracts`, `cli-live-imports-core-cli-ui-only` (ADR-0058 — shared live-run state machine; tools must not import `ink` directly), and `cli-ui-no-workspace-deps` / `cli-ui-no-tools` for the leaf UI kit. They read exactly like the ones below — a `from` package, a forbidden `to` path-list.

### `core-imports-nothing-workspace`

```js
{
  from: { path: '^packages/core/src/' },
  to: {
    path: '^packages/',
    pathNot: '^packages/core/',
  },
}
```

The kernel imports nothing from the workspace. Period.

This is the load-bearing rule. The kernel is what every Tool depends on; if the kernel reached up to a Tool, every Tool would transitively import every other Tool. The Tool plugin model breaks; the layer cake collapses.

The kernel is also where genuinely *shared* substrate lives so it doesn't get duplicated across peer tools. Besides `Registry<T>` and `RunScope`, core now hosts the **generic recipe substrate** (`packages/core/src/recipes/` — `RecipeRegistry<T>`, selector resolution, per-unit config override), hoisted out of fitness so fitness, simulation, and graph share one selection + config-override mechanism (ADR-0005). Execution strategy stays tool-owned; only the generic selection machinery is shared. Because it lives *in* core, it's available to every layer above without inverting the dependency arrow.

The rule is future-proof by shape: any target under `packages/` is forbidden unless it is still inside `packages/core/`. Adding a new package cannot accidentally create an unguarded core back-edge.

### `datastore-imports-core-only`

```js
{
  from: { path: '^packages/datastore/src/' },
  to: {
    path: [
      '^@opensip-cli/contracts',
      '^opensip-cli($|/)',
      '^@opensip-cli/fitness',
      '^@opensip-cli/simulation',
      '^@opensip-cli/lang-',
      '^@opensip-cli/checks-',
      '^@opensip-cli/graph',
    ],
  },
}
```

`@opensip-cli/datastore` is paradigm-agnostic infrastructure (SQLite + Drizzle wrapper, factory, migration runner). It depends on `core` only — not on any tool, lang pack, check pack, or contracts package.

The reasoning mirrors `contracts`: schemas live with their owning packages (sessions in contracts; baseline/catalog in graph; baseline in fitness). Datastore knows nothing about domain shapes — bundling them would invert the ownership and force schema changes to ripple through datastore.

For the deeper rationale (why a separate package, why not core, why not contracts), see [`../80-implementation/03-session-and-persistence.md`](/docs/opensip-cli/80-implementation/03-session-and-persistence/) and the persistence-migration decisions log.

### `contracts-imports-core-only`

```js
{
  from: { path: '^packages/contracts/src/' },
  to: {
    path: [
      '^opensip-cli($|/)',
      '^@opensip-cli/fitness',
      '^@opensip-cli/simulation',
      '^@opensip-cli/lang-',
      '^@opensip-cli/checks-',
    ],
  },
}
```

`contracts` depends only on `core`. It can't reach up to a tool, the CLI, or check packs.

The reasoning: contracts exists to define the contract facade (`SignalEnvelope`, `CommandResult`, `EXIT_CODES`, `StoredSession`, and small tool-facing helpers such as `defineCommand`) that *every* Tool consumes. If it took a dep on one Tool, it'd be coupled to that Tool's lifecycle. Runtime services such as persistence, rendering, config loading, and tool execution stay outside contracts.

### `fitness-no-cli` and `simulation-no-cli`

```js
{ name: 'fitness-no-cli',     from: { path: '^packages/fitness/' },    to: { path: '^opensip-cli($|/)' } }
{ name: 'simulation-no-cli',  from: { path: '^packages/simulation/' }, to: { path: '^opensip-cli($|/)' } }
```

Tools cannot import the CLI. This would create a cycle (cli depends on every tool). Tools call back into shared CLI infrastructure via `ToolCliContext` (the inversion-of-control seam from the Tool contract).

### `check-pack-no-cli`

```js
{
  from: { path: '^packages/fitness/checks-' },
  to: {
    path: ['^opensip-cli($|/)', '^@opensip-cli/contracts'],
  },
}
```

Check packs are self-contained units of fitness-domain logic. They depend on `fitness` (for `defineCheck`) and `core` (for `Signal`, errors). They don't depend on the CLI or contracts — they're the marketplace shape, designed to be installable from npm without dragging the CLI in.

A consumer using `@opensip-cli/checks-typescript` from inside their own custom Tool gets the checks without the CLI's transitive deps.

### `lang-no-cli-or-contracts`

```js
{
  from: { path: '^packages/languages/lang-' },
  to: {
    path: ['^opensip-cli($|/)', '^@opensip-cli/contracts', '^@opensip-cli/checks-'],
  },
}
```

Language adapter packages depend only on `core` (for the `LanguageAdapter` contract). They don't reach into the CLI, contracts, or check packs.

The lang layer is below check packs in the implicit ordering, even though both sit at "Layer 3" in the conceptual model — a check pack imports `lang-typescript` (transitively, through the framework's adapter dispatch), but a lang pack never imports a check pack.

### `lang-no-fitness`

```js
{
  name: 'lang-no-fitness',
  from: { path: '^packages/languages/lang-' },
  to: { path: '^packages/fitness/engine/' },
}
```

A flat rule: *no* lang pack reaches up into fitness. The historical `lang-typescript → fitness` exception (`@opensip-cli/lang-typescript` re-exporting `filterContent`, `clearFilterCache`, `FilteredContent`) was paid down by moving those symbols into the adapter package itself — they now live in [`packages/languages/lang-typescript/src/filter.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/languages/lang-typescript/src/filter.ts) alongside the rest of the TS-aware string/comment stripping. With that, the rule simplified from the named carve-out (`lang-no-fitness-except-typescript`) to the unconditional form above.

### Output-boundary rules (ADR-0011)

[ADR-0011](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0011-signal-output-currency-formatter-sink.md) makes the `SignalEnvelope` the single output currency: a tool engine *returns* an envelope and **never renders or delivers its own output**. The CLI composition root maps flags → (formatter × sink). Four guards keep that honest — three dependency-cruiser rules plus one fitness check, because the contract has both an *import* shape and a *call* shape:

- **`tool-engines-no-output-formatters`** — a tool engine (`packages/{fitness,graph,simulation}/engine/src/`) must not import an `@opensip-cli/output` formatter (`output/src/format/`). Rendering belongs to the composition root.
- **`tool-engines-no-output-sinks`** — a tool engine must not import an `@opensip-cli/output` sink (`output/src/sink/`). Cloud/file egress is resolved only at the root.
- **`tool-engines-no-output-barrel`** — a tool engine must not import the `@opensip-cli/output` barrel at all. The barrel (`output/src/index.ts`) re-exports both formatters and sinks, so the two granular rules above can't see a barrel import; this third rule closes that vector. After the migration a tool engine has zero production `@opensip-cli/output` imports.

  All three are production-source-only — test files are globally excluded, so graph's relocated golden SARIF test may import `formatSignalSarif` from the barrel.

- **`no-direct-stdout-in-tool-engine`** (a project-local dogfood fitness check, slug `no-direct-stdout-in-tool-engine`, [`opensip-cli/fit/checks/no-direct-stdout-in-tool-engine.mjs`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/opensip-cli/fit/checks/no-direct-stdout-in-tool-engine.mjs)) — catches the call shape no import can catch: a tool engine writing run output straight to **stdout** (`process.stdout.write`, `console.log`/`.info`/`.debug`). Scope is **stdout only** — `console.error`/`.warn` are deliberately absent because stderr is the legitimate diagnostics channel (error messages, warnings, failure notices are not run output). The check fires only inside the three tool engines. Legitimate direct stdout (subprocess IPC, file-export transports) is exempted per-file via `@fitness-ignore-file no-direct-stdout-in-tool-engine` with a justification.

- **`one-outcome-shape`** ([`opensip-cli/fit/checks/one-outcome-shape.mjs`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/opensip-cli/fit/checks/one-outcome-shape.mjs), ADR-0065) — public machine JSON must go through `renderOutcome` / host emit seams, not `process.stdout.write(JSON.stringify(...))`.

- **`raw-stream-output-guarded`** ([`opensip-cli/fit/checks/raw-stream-output-guarded.mjs`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/opensip-cli/fit/checks/raw-stream-output-guarded.mjs), ADR-0065) — `output: 'raw-stream'` command specs must document their reason category in-file.

  The complementary positive contract is the `CommandResult` return type: a tool returns its envelope/result and routes output through the `ToolCliContext` seam (`cli.render` / `cli.emitJson` / `cli.emitEnvelope` / `cli.emitError` / `cli.deliverSignals` / `cli.writeArtifact` / `cli.writeSarif`).

---

## Tool-internal partitioning rules

Beyond the cross-package layer cake, two tools define their own internal-shape rules. These don't enforce the package layering — they enforce per-tool stage discipline (graph) and dashboard-panel isolation.

### Graph tool — the seven-stage pipeline and adapter-package isolation

A cluster of rules in `.config/dependency-cruiser.cjs` keep the graph tool's stages clean and the adapter packs isolated. Some pin the original cross-stage discipline (rules-no-parser, renderers-no-pipeline, visitors-resolvers-disjoint); the rest landed when the graph language adapters were extracted into their own publishable npm packages under `packages/graph/graph-*/` (and again when the four tree-sitter adapters were consolidated onto a shared `graph-adapter-common` scaffolding package). The former `info`-severity SARIF allow-rule is gone — graph no longer imports fitness at all (see below).

**Engine ↔ adapter-pack boundaries** (the adapter-package split):

- **`graph-no-cli`** — graph engine doesn't import the CLI.
- **`graph-no-check-packs`** — graph engine never reaches into fitness check packs.
- **`graph-engine-no-adapter-packs`** — the engine package must not depend on any `@opensip-cli/graph-*` adapter pack. Adapters are downstream consumers discovered through the registry walker, not import edges. The inverse (engine → adapter) would create a cycle and defeat the package split. (Engine `__tests__/` are exempt — tests may pull adapter packs as devDeps.)
- **`graph-adapters-disjoint`** — adapter packs must not import each other from production source. Each pack implements the contract for one language; cross-pack imports would couple parser ecosystems together. The rule is pattern-based (`graph-[a-z0-9-]+`) so every adapter pack — including future ones — is covered by construction; it carves out the shared `graph-adapter-common` package (which every tree-sitter adapter is *meant* to consume) and self-imports. (Test sources may consume sibling adapter packs as devDeps for multi-adapter contract / registry / `pickAdapter` coverage.)
- **`graph-common-no-adapters`** — the shared scaffolding package `@opensip-cli/graph-adapter-common` (which hosts the `web-tree-sitter` WASM `parseProject` template the four tree-sitter adapters reuse) must never reach *back down* into a specific language adapter. The layering is engine → common → adapters; a back-edge would invert it and re-couple the parser ecosystems the disjoint rule keeps apart. `graph-adapter-common` may depend only on the engine (`@opensip-cli/graph`), core, glob, and `web-tree-sitter`.
- **`graph-adapters-no-cli`** — adapter packs must not depend on `opensip-cli`.
- **`graph-adapters-no-fitness-or-checks`** — adapter packs must not depend on `@opensip-cli/fitness` or any `@opensip-cli/checks-*` package (peer-layer isolation).

**In-engine stage discipline** (unchanged from the pre-split layout, just with no `engine/src/lang-*` subtrees to police):

- **`graph-rules-no-parser`** — Stage 4 rules consume frozen catalog/indexes only; they must not import any pipeline stage.
- **`graph-renderers-no-pipeline`** — Stage 5 renderers consume `Signal[]` and a `RenderContext`; no `pipeline/` or `rules/` import.
- **`graph-visitors-resolvers-disjoint`** — inventory visitors don't import edge resolvers. Now scoped to `packages/graph/graph-typescript/src/` (the TS adapter is the only adapter with the visitor/resolver split).
- **`graph-resolvers-visitors-disjoint`** — symmetric counterpart.

**Cross-tool decoupling** (graph and fitness are now fully independent):

- **`graph-no-fitness`** — graph production source must not import `@opensip-cli/fitness`. The former sole edge was the SARIF / cloud-report helper; per ADR-0011 SARIF is now the single shared `formatSignalSarif` formatter in `@opensip-cli/output`, applied at the composition root — graph returns a `SignalEnvelope` and imports neither fitness nor `@opensip-cli/output`. There is no longer any sanctioned exception. (Test files may use devDeps.)
- **`fitness-no-graph`** — fitness production source must not import `@opensip-cli/graph`. The former dashboard-reads-graph edge is gone: the CLI is now the report composition root and each tool contributes its own report data via the `Tool.collectReportData` seam. (Test files may use devDeps.)

**Superseded graph checks** (recorded here so future contributors know which
package-edge rules took over):

- `graph-no-typescript-import-outside-lang-typescript` — the engine no longer declares `typescript` as a dependency (it ships only in `@opensip-cli/graph-typescript`). No engine source file can import the TS compiler API; the package edge enforces this by construction.
- `graph-no-tree-sitter-import-outside-lang-packs` — same story for tree-sitter. The engine has no tree-sitter dep; `web-tree-sitter` ships only as a dep of `@opensip-cli/graph-adapter-common` (the shared WASM-grammar scaffolding) and, transitively, the `@opensip-cli/graph-(python|rust|go|java)` adapter packs that consume it.
- `graph-pipeline-no-lang-import` and `graph-orchestrate-no-direct-lang-import` — with all five adapter subtrees relocated into their own packages, the engine has no `engine/src/lang-*` directory to police. The package-edge rule `graph-engine-no-adapter-packs` takes over and is strictly stronger because pnpm + the lockfile enforce package edges by construction.

These mirror the conceptual seven-stage pipeline ([`../40-graph/01-stages-and-catalog.md`](/docs/opensip-cli/40-graph/01-stages-and-catalog/)) and the language-pluggability layering ([`../40-graph/03-adding-a-language.md`](/docs/opensip-cli/40-graph/03-adding-a-language/)). Stages can't reach forward; visitors and resolvers share helpers, not each other; rules and renderers consume frozen data; language-specific code is quarantined to its own publishable adapter package.

### Dashboard — panel isolation

Six rules guard the dashboard's HTML-generator package against the failure modes that broke earlier panel layouts:

- **`dashboard-no-graph-import`** — dashboard panels don't pull `@opensip-cli/graph` (the dashboard receives a serialized `GraphCatalog`; the graph engine's runtime never ships to the browser).
- **`dashboard-code-paths-self-contained`** — the Code Paths panel's helpers don't import other panels.
- **`dashboard-views-disjoint`** — each Code Paths view stays in its own file; views can't import each other.
- **`dashboard-algorithms-no-view-deps`** — Code Paths algorithms (Tarjan, BFS, etc.) don't import any view-specific code.
- **`dashboard-no-side-stylesheets`** — only the central CSS module emits styles.
- **`dashboard-no-ui-framework`** — no React, Vue, Svelte, or other UI-framework imports inside the dashboard. The dashboard is hand-written DOM; bundling a framework would balloon the static HTML.

These rules exist because the dashboard ships as a single self-contained `index.html`. Every layering violation here would either bloat the file, break the no-server promise, or reintroduce panel-cross-talk bugs.

---

## What this enforces in practice

Concrete examples of edges that fail the build:

- **`packages/core/src/foo.ts` imports from `@opensip-cli/fitness`** — `core-imports-nothing-workspace` fails. Move the fitness-using code to a higher layer.
- **`packages/fitness/engine/src/foo.ts` imports from `opensip-cli`** — `fitness-no-cli` fails. Use `ToolCliContext` instead.
- **`packages/fitness/checks-typescript/src/foo.ts` imports from `opensip-cli`** — `check-pack-no-cli` fails. Check packs only depend on fitness + core.
- **`packages/languages/lang-rust/src/foo.ts` imports from `@opensip-cli/fitness`** — `lang-no-fitness` fails. No lang pack may import fitness (the old typescript carve-out is gone).
- **`packages/contracts/src/foo.ts` imports from `@opensip-cli/simulation`** — `contracts-imports-core-only` fails. contracts talks to core only.
- **`packages/graph/engine/src/rules/foo.ts` imports `typescript` or anything under `pipeline/`** — `graph-rules-no-parser` fails. Rules consume frozen catalog/indexes only.
- **`packages/graph/engine/src/render/foo.ts` imports from `pipeline/` or `rules/`** — `graph-renderers-no-pipeline` fails. Renderers consume `Signal[]`.
- **`packages/graph/engine/src/pipeline/inventory-visitors/foo.ts` imports from `pipeline/edge-resolvers/`** — `graph-visitors-resolvers-disjoint` fails (and the symmetric counterpart). They share helpers, not each other.
- **A circular import inside any package** — `no-circular` fails. Refactor.

All of these surface during `pnpm depcruise` — and, re-run over the type-inclusive graph, during `pnpm depcruise:types`. Both run as part of `pnpm lint`. Each violation prints the offending file, the import line, and the rule name.

---

## How to add a new exception

There are **no standing layer exceptions**. `tsPreCompilationDeps: false` on the main pass is not one: it only defers type-only edges to the type-aware pass (`.config/dependency-cruiser.types.cjs`, `tsPreCompilationDeps: true`), which re-runs the full ruleset over the type-inclusive graph — so a type-only layer inversion or cycle is rejected just like a runtime one. The two earlier cross-package exceptions were both paid down — `lang-typescript → fitness` (by moving `filterContent` into the adapter) and `graph → fitness` via `render/sarif.ts` (by moving SARIF formatting and cloud delivery into `@opensip-cli/output` and applying them at the CLI composition root). New exceptions are rare and require justification.

Process:

1. Confirm the edge is genuinely necessary — most "I need this" cases turn out to be a different module belonging at a different layer.
2. Open a PR that:
   - Adds the rule exception in `.config/dependency-cruiser.cjs` with a `comment:` field describing the rationale.
   - Updates this doc with the new exception.
   - Updates [`../10-concepts/03-modular-monolith.md`](/docs/opensip-cli/10-concepts/03-modular-monolith/) if the layer rule's *meaning* changes.
3. Get review explicitly on the layer impact — not just the code-level change.

Exceptions are debt. Each one weakens the architectural promise. Add them when you must, and document them in plain English.

---

## What this doesn't enforce

A few patterns dep-cruiser can't catch but the workspace still cares about:

- **Public-API minimization.** A package can re-export anything from its `index.ts`; the dep-cruiser rules only see the modules that import it. Knip catches unused exports; the team's review catches over-exposed APIs.
- **Naming consistency.** Conventions like "checks live under `src/checks/`" or "tests are `*.test.ts`" are documented but not lint-enforced.
- **Layer sanity within a single package.** A package's internal subdirectories can have any shape; the rules only fire on cross-package edges.

These are review concerns. The layer rules pin the load-bearing constraint; the rest is the contributor's responsibility.

### Tool failure reporting (ADR-0077)

Handler-time command failures split across three packages by design:

- **`@opensip-cli/core`** — `ReportFailureDetail`, `createToolLogger`, `ToolCliContext.reportFailure` type
- **`@opensip-cli/contracts`** — `mapToolErrorToExitCode` exit policy
- **`opensip-cli` (cli package)** — `resolveReportFailure`, `createReportFailure` fan-out, worker `reportedFailure` replay

Core must not import contracts for the failure input type; the CLI composition root combines both.

---

## What's next

- **[`04-coding-standards.md`](/docs/opensip-cli/80-implementation/04-coding-standards/)** — TypeScript and ESLint conventions inside the layered packages.
- **[`../10-concepts/03-modular-monolith.md`](/docs/opensip-cli/10-concepts/03-modular-monolith/)** — the conceptual narrative behind these rules.
- **[`../70-reference/02-package-catalog.md`](/docs/opensip-cli/70-reference/02-package-catalog/)** — the package list, organized by layer.
