---
status: active
last_verified: 2026-06-11
owner: opensip-cli
---

# ADR-0022: Recipe defaults are tool-scoped

```yaml
id: ADR-0022
title: Recipe defaults are tool-scoped
date: 2026-06-07
status: active
supersedes: []
superseded_by: null
related: [ADR-0021]
tags: [cli, config, recipes, fit, graph, sim]
enforcement: mechanizable
enforcement-reason: >
  The composed strict config schema rejects `cli.recipe` as an unknown
  `cli:` key, and the shared `resolveToolRecipeName` helper only accepts an
  explicit flag value plus the active tool's `<tool>.recipe` value. Unit tests
  cover the shared precedence and the per-tool registry fallback paths
  (fit/graph/sim).
```

**Decision:** A default recipe is a **tool-scoped** setting. Each tool reads its
default recipe from its own config block — `fitness.recipe`, `graph.recipe`,
`simulation.recipe` — because recipe namespaces are disjoint (a fit recipe is not a
graph recipe). Resolution precedence per tool is: explicit `--recipe` flag >
`<tool>.recipe` > the tool's built-in `default` recipe. A recipe name that comes
from **config** (`<tool>.recipe`) but is absent from the active tool's registry
falls back to that tool's `default` recipe with a warning, instead of aborting the
run; an **explicit** `--recipe <name>` that is unknown still hard-fails (typo
protection). The deprecated `cli.recipe` fallback was removed in 3.0.0; the strict
config schema now rejects it.

**Alternatives:**
- *Keep `cli.recipe` as the single cross-tool default (status quo).* Rejected:
  it forces one recipe name across tools with disjoint namespaces, so a fit
  recipe default leaks into `graph`/`sim` and aborts them with
  `Unknown graph recipe '<fit-recipe>'`. This is the bug that prompted the ADR.
- *Remove `cli.recipe` outright, per-tool only (hard cutover).* Rejected during
  the 2.x migration window because every existing config using `cli.recipe` would
  break on upgrade with no grace path. Chosen for the 3.0.0 major release after
  the deprecation window.
- *Make `cli.recipe` tolerant but keep it the only mechanism (no per-tool
  keys).* Rejected: tolerance alone hides the modelling error — the default is
  still expressed in a tool-agnostic block for a tool-scoped concept, so a
  project that genuinely wants different defaults per tool can't express it.

**Rationale:** Recipes are owned by each tool's recipe registry
(`fitness/engine/.../recipes`, `graph/engine/src/recipes`,
`simulation/engine/.../recipes`) and the namespaces do not overlap. Before this
ADR the CLI hydrated `opts.recipe` from the tool-agnostic `cli:` block in the
generic pre-action hook, so the same default reached `fit`, `graph`, and `sim`
alike. In the parent `opensip` repo, `cli.recipe: opensip` (a *fit* recipe at
`opensip-cli/fit/recipes/opensip.mjs`) made `opensip graph` fail with
`Unknown graph recipe 'opensip'`. The config block already has tool-scoped
siblings (`fitness:`, `graph:`, `simulation:` are contributed to the composed
strict config schema by their owning tools), so a per-tool `recipe` key is the
natural, layering-consistent home. Tolerance for config-sourced names keeps a
cross-pasted `<tool>.recipe` from breaking any single tool, while explicit-flag
strictness preserves the typo-catching guardrail.

**Consequences:**
- `mergeConfigDefaults` no longer copies `recipe` onto `opts`; `opts.recipe`
  now reflects only the explicit `--recipe` flag. Each tool resolves its own
  default via the shared `resolveToolRecipeName` helper in
  `@opensip-cli/contracts`, reading only its own block.
- Config keys: `fitness.recipe`, `graph.recipe`, `simulation.recipe`.
- The recipe resolvers (`resolveRecipeToRules` in graph, `selectRecipe` in fit,
  the inline lookup in sim) accept a `tolerant` flag: config-sourced unknown →
  fall back to `default` + `logger.warn`; explicit-flag unknown → unchanged
  hard error.
- The 2.x `cli-recipe-deprecated` check is removed with the compatibility path;
  the strict config schema now catches `cli.recipe`.
- Migration: move `cli.recipe: <name>` to the owning tool block, such as
  `fitness.recipe: <name>`, `graph.recipe: <name>`, or
  `simulation.recipe: <name>`.

**Related specs / ADRs:** [ADR-0021](ADR-0021-cross-tool-cli-flag-currency.md)
(cross-tool flag currency — the same "tools share a CLI surface but own their
own semantics" principle applied to flags).
