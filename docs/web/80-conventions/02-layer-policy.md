---
status: current
last_verified: 2026-05-15
title: "Layer policy"
audience: [contributors]
purpose: "The dependency-cruiser rules that enforce the five-layer architecture, rule by rule, with rationale."
source-files:
  - .dependency-cruiser.cjs
  - pnpm-workspace.yaml
related-docs:
  - ../10-mental-model/03-modular-monolith.md
  - ./01-coding-standards.md
  - ../70-reference/01-package-catalog.md
---
# Layer policy

The five-layer architecture (kernel → contracts → tools/lang/ → checks → cli) is enforced by [dependency-cruiser](https://github.com/sverweij/dependency-cruiser). Build fails on any forbidden edge. This doc walks every rule and the reasoning.

For the conceptual layer narrative, see [`../10-mental-model/03-modular-monolith.md`](/docs/opensip-tools/10-mental-model/03-modular-monolith/).

The literal rules are at [`.dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/.dependency-cruiser.cjs).

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

The five rules that pin the layer cake.

### `core-imports-nothing-workspace`

```js
{
  from: { path: '^packages/core/src/' },
  to: {
    path: [
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

### `lang-no-cli-or-shared`

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

## What this enforces in practice

Concrete examples of edges that fail the build:

- **`packages/core/src/foo.ts` imports from `@opensip-tools/fitness`** — `core-imports-nothing-workspace` fails. Move the fitness-using code to a higher layer.
- **`packages/fitness/engine/src/foo.ts` imports from `@opensip-tools/cli`** — `fitness-no-cli` fails. Use `ToolCliContext` instead.
- **`packages/fitness/checks-typescript/src/foo.ts` imports from `@opensip-tools/cli`** — `check-pack-no-cli` fails. Check packs only depend on fitness + core.
- **`packages/languages/lang-rust/src/foo.ts` imports from `@opensip-tools/fitness`** — `lang-no-fitness-except-typescript` fails. Only the typescript adapter is exempt.
- **`packages/contracts/src/foo.ts` imports from `@opensip-tools/simulation`** — `contracts-imports-core-only` fails. contracts talks to core only.
- **A circular import inside any package** — `no-circular` fails. Refactor.

All of these surface during `pnpm depcruise` (run as part of `pnpm lint`). Each violation prints the offending file, the import line, and the rule name.

---

## How to add a new exception

The two existing exceptions (`tsPreCompilationDeps: false` for type-only edges; `lang-typescript → fitness` for legacy re-exports) cover the realistic cases. New exceptions are rare and require justification.

Process:

1. Confirm the edge is genuinely necessary — most "I need this" cases turn out to be a different module belonging at a different layer.
2. Open a PR that:
   - Adds the rule exception in `.dependency-cruiser.cjs` with a `comment:` field describing the rationale.
   - Updates this doc with the new exception.
   - Updates [`../10-mental-model/03-modular-monolith.md`](/docs/opensip-tools/10-mental-model/03-modular-monolith/) if the layer rule's *meaning* changes.
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

- **[`01-coding-standards.md`](/docs/opensip-tools/80-conventions/01-coding-standards/)** — TypeScript and ESLint conventions inside the layered packages.
- **[`../10-mental-model/03-modular-monolith.md`](/docs/opensip-tools/10-mental-model/03-modular-monolith/)** — the conceptual narrative behind these rules.
- **[`../70-reference/01-package-catalog.md`](/docs/opensip-tools/70-reference/01-package-catalog/)** — the package list, organized by layer.
