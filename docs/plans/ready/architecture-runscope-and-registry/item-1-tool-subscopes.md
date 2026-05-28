# Item 1 — Tool-specific RunScope subscopes (simulation, graph)

Follow-up to the RunScope + Registry refactor (PR #2). Migrates the
last four module-level singletons onto per-`RunScope` storage using
D7's grouped + TypeScript module augmentation pattern.

## In scope

| Singleton (before)                                       | After                              |
| -------------------------------------------------------- | ---------------------------------- |
| `scenarioRegistry` (simulation/engine/framework/registry)| `scope.simulation.scenarios`       |
| `defaultSimulationRecipeRegistry` (simulation/recipes)   | `scope.simulation.recipes`         |
| graph lang-adapter `registry` (graph/engine/lang-adapter)| `scope.graph.adapters`             |
| graph rules `registry` (graph/engine/rules)              | `scope.graph.rules`                |

## D7 in one paragraph

Kernel concerns stay flat on `RunScope` (`logger`, `parseCache`,
`tools`, `languages`, ...). Tool-specific concerns nest under the
tool's name and are added via TypeScript **module augmentation** in
each tool's package. Each tool's subscope is optional — a graph-only
run carries no `scope.simulation`, and vice versa. Consumers
null-check or assert on first read.

## How `scope.{simulation,graph}` get populated

The kernel doesn't know simulation or graph exist — that's the point
of D7. We extend the `Tool` contract with an optional `extendScope?`
hook that the pre-action-hook calls **after** constructing each per-run
`RunScope` and **before** entering it via `enterScope`. Each registered
tool gets a chance to populate its own augmented slot.

```typescript
// Tool contract addition (packages/core/src/tools/types.ts)
extendScope?(scope: RunScope): void
```

This avoids three rejected alternatives:

- **Option C / "tool's `register(cli)` mutates `cli.scope`"** doesn't
  work because `cli.scope` isn't constructed at `register()` time —
  `register()` runs once at CLI startup, the scope is rebuilt per
  action invocation. `cli.scope` (a getter) actively throws when read
  outside an action body.
- **Constructor injection on `RunScope`** would force core to import
  simulation / graph types — a layer-rule violation.
- **`unknown` slot** is the T3 anti-pattern D7 explicitly rejects.

## Mutability

Subscope slots in the augmentation are declared mutable (no
`readonly` qualifier on the optional field), even though the kernel
fields on `RunScope` are class-level `readonly`. Tools assign via
`scope.simulation = { ... }` inside `extendScope`. The narrowness is
intentional: only the owning tool's `extendScope` hook mutates that
slot, and only during scope construction.

## `defineSimulationRecipe` change

`defineSimulationRecipe()` used to register the recipe into the
module-level singleton as a side effect (the "double-registration"
pattern: defined here, then re-iterated by the plugin loader). This
mirrors the `defineX` scenario factories before they were migrated
(commit `1a0a71b`). Item 1 closes the symmetry: `defineSimulationRecipe`
now returns the recipe without registering. The plugin loader's
explicit-array path is the single registration channel.

## Commit plan (~12 commits)

1. `docs(plans): Item 1 design notes` — this file.
2. `feat(core): extendScope hook on Tool contract` — optional, no-op default.
3. `feat(simulation): RunScope.simulation namespace via module augmentation`.
4. `refactor(simulation): plugin loader registers into scope.simulation.scenarios`.
5. `refactor(simulation): recipe service reads scope.simulation.scenarios`.
6. `refactor(simulation): cli/sim.ts reads scope.simulation.{scenarios,recipes}`.
7. `refactor(simulation): defineSimulationRecipe returns recipe; loader registers`.
8. `refactor(simulation): tool extendScope populates scope.simulation`.
9. `refactor(simulation): delete scenarioRegistry / defaultSimulationRecipeRegistry singletons`.
10. `feat(graph): RunScope.graph namespace via module augmentation`.
11. `refactor(graph): orchestrate + heap-preflight + rules read scope.graph`.
12. `refactor(graph): tool extendScope populates scope.graph; delete singletons`.
13. `test(simulation,graph): per-scope registry isolation smoke test`.

Tests update alongside each refactor; the dedicated isolation smoke
test mirrors `cli/__tests__/saas-mode-smoke.test.ts` and proves two
concurrent scopes carry independent simulation + graph registries.
