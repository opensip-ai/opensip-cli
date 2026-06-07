---
status: active
last_verified: 2026-06-07
owner: opensip-tools
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
  The `cli-recipe-deprecated` check (checks-universal) flags a `cli.recipe`
  key in opensip-tools.config.yml and points the author at the per-tool
  `<tool>.recipe` replacement. The tolerant-resolution behaviour is covered by
  unit tests on the shared `resolveToolRecipeName` helper (contracts) and the
  per-tool registry-fallback paths (fit/graph/sim).
```

**Decision:** A default recipe is a **tool-scoped** setting. Each tool reads its
default recipe from its own config block — `fit.recipe`, `graph.recipe`,
`sim.recipe` — because recipe namespaces are disjoint (a fit recipe is not a
graph recipe). Resolution precedence per tool is: explicit `--recipe` flag >
`<tool>.recipe` > `cli.recipe` (deprecated cross-tool fallback) > the tool's
built-in `default` recipe. A recipe name that comes from **config** (either
`<tool>.recipe` or `cli.recipe`) but is absent from the active tool's registry
falls back to that tool's `default` recipe with a warning, instead of aborting
the run; an **explicit** `--recipe <name>` that is unknown still hard-fails
(typo protection). `cli.recipe` remains readable as a deprecated fallback for
backward compatibility and is flagged by a fitness check.

**Alternatives:**
- *Keep `cli.recipe` as the single cross-tool default (status quo).* Rejected:
  it forces one recipe name across tools with disjoint namespaces, so a fit
  recipe default leaks into `graph`/`sim` and aborts them with
  `Unknown graph recipe '<fit-recipe>'`. This is the bug that prompted the ADR.
- *Remove `cli.recipe` outright, per-tool only (hard cutover).* Rejected for
  now: every existing config using `cli.recipe` would break on upgrade with no
  grace path. We keep it as a deprecated, tolerant fallback and let the fitness
  check drive migration.
- *Make `cli.recipe` tolerant but keep it the only mechanism (no per-tool
  keys).* Rejected: tolerance alone hides the modelling error — the default is
  still expressed in a tool-agnostic block for a tool-scoped concept, so a
  project that genuinely wants different defaults per tool can't express it.

**Rationale:** Recipes are owned by each tool's recipe registry
(`fitness/engine/.../recipes`, `graph/engine/src/recipes`,
`simulation/engine/.../recipes`) and the namespaces do not overlap. Before this
ADR the CLI hydrated `opts.recipe` from the tool-agnostic `cli:` block in the
generic pre-action hook (`packages/cli/src/bootstrap/cli-defaults.ts`
`mergeConfigDefaults`), so the same default reached `fit`, `graph`, and `sim`
alike. In the parent `opensip` repo, `cli.recipe: opensip` (a *fit* recipe at
`opensip-tools/fit/recipes/opensip.mjs`) made `opensip-tools graph` fail with
`Unknown graph recipe 'opensip'`. The config block already has tool-scoped
siblings (`graph:` is read by `loadGraphConfig`; fitness owns its own sections),
so a per-tool `recipe` key is the natural, layering-consistent home. Tolerance
for config-sourced names keeps a shared `cli.recipe` (or a cross-pasted
`<tool>.recipe`) from breaking any single tool, while explicit-flag strictness
preserves the typo-catching guardrail.

**Consequences:**
- `mergeConfigDefaults` no longer copies `recipe` onto `opts`; `opts.recipe`
  now reflects only the explicit `--recipe` flag. Each tool resolves its own
  default via the shared `resolveToolRecipeName` helper in
  `@opensip-tools/contracts`, reading its own block plus the deprecated
  `cli.recipe` fallback.
- New config keys: `fit.recipe`, `graph.recipe`, `sim.recipe`. The graph loader
  (`loadGraphConfig`) and the fit/sim config readers project the `recipe` field.
- The recipe resolvers (`resolveRecipeToRules` in graph, `selectRecipe` in fit,
  the inline lookup in sim) accept a `tolerant` flag: config-sourced unknown →
  fall back to `default` + `logger.warn`; explicit-flag unknown → unchanged
  hard error.
- A `cli-recipe-deprecated` fitness check (checks-universal, `warning`) flags a
  `cli.recipe` key and suggests the `<tool>.recipe` replacement.
- Migration: the parent `opensip` repo moves `cli.recipe: opensip` →
  `fit.recipe: opensip`. Other adopters do the same; until they do, the
  deprecated fallback keeps their `fit` runs working and no longer breaks
  `graph`/`sim`.

**Related specs / ADRs:** [ADR-0021](ADR-0021-cross-tool-cli-flag-currency.md)
(cross-tool flag currency — the same "tools share a CLI surface but own their
own semantics" principle applied to flags).
