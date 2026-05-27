---
status: current
last_verified: 2026-05-27
release: v2.0.x
title: "Adopt in a monorepo"
audience: [plugin-authors, ci-integrators]
purpose: "Task-led: introduce opensip-tools to a large polyglot monorepo. Workspace-package graduation, per-package targets, scoped baselines."
source-files:
  - packages/cli/src/commands/init.ts
  - packages/fitness/engine/src/targets/index.ts
related-docs:
  - ./01-write-your-first-check.md
  - ./03-wire-into-ci.md
  - ../50-extend/01-plugin-authoring.md
  - ../20-fit/02-targets-and-scope.md
---
# Adopt in a monorepo

opensip-tools is designed to feel light at the start (loose `.mjs` files + the default recipe) and scale up as the team's bar grows (workspace npm packages, per-target glob filtering, per-package baselines). This guide walks the path most teams take.

## Day 1: scaffold + smoke

```bash
cd path/to/monorepo
opensip-tools init
opensip-tools fit --recipe example   # exit 0 — wiring works
```

You now have:

```
monorepo-root/
├── opensip-tools.config.yml
└── opensip-tools/
    ├── fit/checks/example-check.mjs   ← the seed for your custom checks
    ├── fit/recipes/example-recipe.mjs
    └── sim/…
```

Read [write your first check](/docs/opensip-tools/60-guides/01-write-your-first-check/) and replace the example with one rule that matters to your team. The smallest possible scope ("FIXME comments are forbidden in `packages/api/`") is fine — adopting one rule beats adopting a recipe of fifteen.

## Day 2-7: add 5–10 rules + a recipe

The pattern most teams settle on: a `quality` recipe that runs all of their custom checks plus a curated subset of built-in checks. Example:

```js
// opensip-tools/fit/recipes/quality.mjs
export const recipes = [{
  id: 'URCP_quality',
  name: 'quality',
  displayName: 'Quality',
  description: 'Architectural + correctness checks for monorepo',
  checks: {
    type: 'tags',
    include: ['architecture', 'quality'],
    // Exclude built-ins that don't apply to your codebase
    exclude: ['no-todo-comments', 'public-api-jsdoc'],
  },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
```

Run `opensip-tools fit --recipe quality --findings` locally. Fix anything obvious. The rest stays in the baseline.

## Day 7+: lock in the baseline + CI

Once the recipe is stable:

```bash
opensip-tools fit --recipe quality --gate-save
git add -f opensip-tools/.runtime/baseline.sarif
git commit -m "chore(fit): seed quality baseline"
```

Then add the [CI step](/docs/opensip-tools/60-guides/03-wire-into-ci/). PRs see *"is this getting worse?"*. The team fixes baseline cases as they touch the surrounding code.

## When `.mjs` files outgrow themselves

The loose `.mjs` shape works fine through ~10-15 checks. Past that you'll want:

- TypeScript types for `defineCheck` (autocomplete on the recipe shape)
- Shared helper functions (your three security checks all want the same "does this file import `crypto`?" predicate)
- Per-check tests (`vitest`)
- A way to publish your checks to other teams in your org

Graduate `opensip-tools/fit/` to a workspace npm package. The runtime tolerates both shapes — discovery works either way — so this is purely a developer-ergonomics upgrade.

### The graduation

```bash
cd opensip-tools/fit
# Convert to a workspace npm package
```

```json
// opensip-tools/fit/package.json
{
  "name": "@your-scope/fit",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "opensipTools": { "kind": "fit-pack" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@opensip-tools/fitness": "workspace:*",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

```jsonc
// opensip-tools/fit/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "outDir": "./dist",
    "declaration": true
  },
  "include": ["src/**/*", "checks/**/*", "recipes/**/*", "index.ts"]
}
```

```ts
// opensip-tools/fit/index.ts
export { default as noFixme } from './checks/no-fixme.js';
// …re-export every check
export const checks = [noFixme /*, ...*/];
export const recipes = [/* import recipe defs */];
```

Then in your monorepo's root `pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'opensip-tools/*'   # ← this is what makes discovery work
```

```jsonc
// root package.json
{
  "devDependencies": {
    "@your-scope/fit": "workspace:*"
  }
}
```

Then `pnpm install`. The workspace symlinks `@your-scope/fit` into `node_modules/`. opensip-tools's marker-based discovery finds it via the `opensipTools.kind` field and loads it on the next `fit` run.

The `kind` marker is what makes discovery work — your pack can use any npm scope you own (`@acme/fit`, `@my-internal-org/checks-platform`). The kind tells opensip-tools "this is a fit-pack"; the rest is your naming. Same shape for sim packs with `"kind": "sim-pack"`.

For TS-based packs you also need to build (`pnpm -F @your-scope/fit build`) so the `main` field resolves to real JS. The runtime doesn't load TypeScript directly — it loads what your `package.json#main` points at.

## Per-package targets

By default, `opensip-tools fit` runs every check against every matched file in the repo. In a monorepo with strict per-package boundaries, you usually want narrower scoping:

```yaml
# opensip-tools.config.yml
targets:
  api-server:
    languages: [typescript]
    concerns: [backend, server]
    include: ['packages/api/src/**/*.ts']
    exclude: ['**/__tests__/**']

  dashboard:
    languages: [typescript]
    concerns: [frontend]
    include: ['apps/dashboard/src/**/*.{ts,tsx}']
    exclude: ['**/__tests__/**', '**/*.stories.tsx']

  shared-libs:
    languages: [typescript]
    concerns: [shared]
    include: ['packages/{contracts,core,utils}/src/**/*.ts']
```

Each check's `scope: { languages, concerns }` filters which targets it runs against. A check with `scope: { concerns: ['backend'] }` runs against `api-server` only. The full target-matching model is in [targets and scope](/docs/opensip-tools/20-fit/02-targets-and-scope/).

## Scoped baselines

For a really large monorepo, you may want per-package baselines so one team's drift doesn't drag others. Today, opensip-tools stores one project-level baseline in SQLite — but you can scope runs by target via the `--target` flag:

```bash
opensip-tools fit --target api-server --gate-compare
opensip-tools fit --target dashboard --gate-compare
```

Each runs only the checks that match that target's scope. Run them as separate CI jobs to parallelize. (True multi-baseline support — one baseline per target — is on the roadmap; today, the single baseline holds findings across all targets, but the per-target invocation still gates correctly because new findings have to be new in some target.)

## When to use sim or graph

This guide focused on `fit` because that's where adoption usually starts. Once `fit` is running:

- **`graph`** — adds static call-graph rules (orphan code, duplicated bodies, dead paths). Five rules, no authoring required, runs in ~15s cold / ~2.5s incremental on a large repo. See [graph stages and catalog](/docs/opensip-tools/40-graph/01-stages-and-catalog/).
- **`sim`** — load / chaos / invariant simulation. Opt-in, experimental. Useful if you have a service to simulate against. See [scenarios and recipes](/docs/opensip-tools/30-sim/01-scenarios-and-recipes/).

Both share the same baseline-gate model and the same CLI shape. Add them when the team has bandwidth.

## Where to go next

| You want to … | Go to … |
|---|---|
| Full CI walkthrough with GitHub Actions YAML | [Wire into CI](/docs/opensip-tools/60-guides/03-wire-into-ci/) |
| Detailed plugin-authoring docs | [Plugin authoring](/docs/opensip-tools/50-extend/01-plugin-authoring/) |
| Target-matching deep dive | [Targets and scope](/docs/opensip-tools/20-fit/02-targets-and-scope/) |
| Coexist with ESLint / migrate over time | [Migrate from ESLint](/docs/opensip-tools/60-guides/05-migrate-from-eslint/) |
