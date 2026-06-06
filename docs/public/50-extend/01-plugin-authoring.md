---
status: current
last_verified: 2026-05-27
release: v3.0.0
title: "Plugin authoring"
audience: [plugin-authors]
purpose: "Overview of the five ways to extend opensip-tools — from a dropped .mjs file to a full Tool plugin. Routes you to the right deep-dive."
source-files:
  - packages/core/src/tools/types.ts
  - packages/core/src/plugins/types.ts
related-docs:
  - ./02-project-local-plugins.md
  - ./03-publishable-packs.md
  - ./04-check-pack-architecture.md
  - ./05-language-adapters.md
  - ./06-full-tool-plugins.md
  - ../00-start/05-vocabulary.md
  - ../10-concepts/02-tool-plugin-model.md
---
# Plugin authoring

opensip-tools is extensible across five shapes, listed in increasing order of effort and capability. Pick the one that matches what you're trying to ship.

| # | Shape | When to use | Effort | Read |
|---|---|---|---|---|
| 1 | **Project-local check** — a `.mjs` file under `opensip-tools/fit/checks/` | Add one rule to one repo. No publishing. | ~10 lines | [Project-local plugins](./02-project-local-plugins.md) |
| 2 | **Project-local recipe** — a `.mjs` file under `opensip-tools/fit/recipes/` | Define a named lineup of checks for CI ("`quick-smoke` for pre-commit"). | ~10 lines | [Project-local plugins](./02-project-local-plugins.md) |
| 3 | **Project-local sim scenario** — a `.mjs` file under `opensip-tools/sim/scenarios/` | Run load / chaos simulations against your service. | ~30 lines | [Project-local plugins](./02-project-local-plugins.md) |
| 4 | **Publishable pack (fit-pack or sim-pack)** — an npm package declaring `opensipTools.kind` | Ship the same checks/scenarios across multiple projects, or organize a large in-repo set. | ~100-500 lines + tooling | [Publishable packs](./03-publishable-packs.md) |
| 5 | **Full Tool plugin** — an npm package declaring `opensipTools.kind: "tool"` | Your own subcommand. Fundamentally different from `fit`/`sim`/`graph` (e.g. `audit-sec`, `bench`). | ~50-150 lines per Tool | [Full Tool plugins](./06-full-tool-plugins.md) |

## Pick by question

**"I want to ban an API in my codebase."** → Shape 1 ([project-local check](./02-project-local-plugins.md), or the [Ban an API pattern](../60-guides/02-ban-an-api-pattern.md) guide for a walkthrough).

**"I want our team's quality bar shared across five repos."** → Shape 4 ([publishable packs](./03-publishable-packs.md)). Workspace pack if all five are in one monorepo, published npm pack if they're separate.

**"I want a different lineup of checks for pre-commit vs. CI."** → Shape 2 (two project-local recipes; select with `--recipe <name>`).

**"I want to simulate a load test as part of the gate."** → Shape 3 ([project-local sim scenario](./02-project-local-plugins.md)).

**"I want a security-audit tool that integrates with the CLI but isn't fit-shaped."** → Shape 5 ([full Tool plugin](./06-full-tool-plugins.md)). The Tool contract is the seam; the CLI doesn't know what your Tool does.

**"I want to add a new language to `graph`."** → Different surface — see [adding a language](../40-graph/03-adding-a-language.md). Graph language adapters use a separate contract from fit language adapters; both are documented but live in different sections.

**"I want to add a new language to `fit`."** → [Language adapters](./05-language-adapters.md). Authoring path for the fit-side adapter that strips strings/comments for a new language.

## The big mental model

Every shape above plugs into the same kernel. The CLI is a generic dispatcher; it discovers your package (by marker, exact pin, or the sim `scenarios-*` naming pattern), calls a known entry point (`tool.register()` for Tools, or reads `checks` / `recipes` / `scenarios` arrays for packs), and routes the rest. There are no hooks, no middleware, no event buses — just a registry walk at startup.

That's by design. The whole point of the platform is that adding a new tool or pack requires zero CLI changes. For the architecture: [the tool-plugin model](../10-concepts/02-tool-plugin-model.md) walks through it end-to-end.

## Where to go next

- **Authoring your first thing** → [Write your first check](../60-guides/01-write-your-first-check.md). Hands-on walkthrough with `init`, a custom check, a recipe, and a CI gate.
- **Reference for every check that ships** → [Checks reference](../70-reference/05-checks-index.md). Browse all 145+ built-in checks with descriptions and links to source.
- **Deep dive on what a "Tool" is architecturally** → [The tool-plugin model](../10-concepts/02-tool-plugin-model.md).
