---
status: current
last_verified: 2026-05-16
owner: opensip-tools
indexable: true
title: "opensip-tools Architecture"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "Teaching path through opensip-tools — what it is, how it thinks, how it runs — plus a lookup-shaped reference catalog."
---
# opensip-tools Architecture

A teaching path through opensip-tools. Read sections 00–20 top-to-bottom on your first pass to build a working mental model. Then jump around: subsystems (50) for narrative deep-dives, runtime (40) for execution mechanics, reference (70) when you need to look something up.

These docs are written for engineers fluent in TypeScript and Node tooling. Voice is second-person, narrative, and assumes you can read source. Every claim traces to source files; every doc carries a verification trail in its frontmatter.

**If you're an AI agent reading this:** the same docs work for you, but jump straight to [`70-reference/`](./70-reference/) for lookup-shaped material — the 00-30 sections are written narratively for human onboarding.

---

## How to read this

| If you're … | Read … |
|---|---|
| **Brand new to opensip-tools** | 00 → 10 → 20 in order. ~10 docs, ~90 minutes. You'll have a working mental model. |
| **Writing your first check or recipe** | 00 → 10 → 60 (`02-plugin-authoring`). The middle is unnecessary at first. |
| **Adding a language adapter or check pack** | 50 (`01-language-adapters`, `02-check-packs`). Self-contained. |
| **Wiring opensip-tools into CI** | 20 (`04-output-gate-sarif`) + 50 (`03-architecture-gate`). |
| **Reviewing a PR that touches the kernel** | 80 (`02-layer-policy`) + 70 (`01-package-catalog`) for lookup. |
| **Looking for a specific package, command, or config field** | 70 — that's what it's for. |

---

## Reading order

### 00 — Orientation
*Read once. Establishes context for everything below.*

0. [**Quick start**](./00-orientation/00-quick-start.md) — Four commands from clean shell to a passing fitness run. **Start here** if you want hands-on context before the conceptual material.
1. [**What is opensip-tools**](./00-orientation/01-what-is-opensip-tools.md) — The product, the problem, the philosophy.
2. [**Vocabulary**](./00-orientation/02-vocabulary.md) — Tool, recipe, check, scenario, signaler, target, language adapter, plugin, session. The terms used everywhere.
3. [**System context**](./00-orientation/03-system-context.md) — Where opensip-tools sits between you, your codebase, CI, and OpenSIP Cloud. The runtime layout.

### 10 — Mental model
*The conceptual core. If you understand these four docs, you understand opensip-tools.*

4. [**The fitness loop**](./10-mental-model/01-fitness-loop.md) — **The spine.** One check from definition to violation to gate decision. Threads through every later doc.
5. [**The tool-plugin model**](./10-mental-model/02-tool-plugin-model.md) — Kernel + Tool contract + first-party tools + dispatcher. Why the CLI doesn't know what `fit` does.
6. [**Layered package graph**](./10-mental-model/03-modular-monolith.md) — The 17-package monorepo, the layer rules, why dependency-cruiser exists.
7. [**Contract surfaces**](./10-mental-model/04-contract-surfaces.md) — The system's public edges: CLI argv, Tool interface, plugin manifests, JSON output.

### 20 — The fit loop
*The fitness command's main flow. This is what 90% of users invoke.*

8. [**Recipes and checks**](./20-the-fit-loop/01-recipes-and-checks.md) — What a recipe is, what a check is, how they compose. `defineCheck` and `defineRecipe`.
9. [**Targets and scope**](./20-the-fit-loop/02-targets-and-scope.md) — Language detection, target registry, glob expansion, ignore handling.
10. [**Ignore directives**](./20-the-fit-loop/03-ignore-directives.md) — Inline source-level suppression: `@fitness-ignore-next-line`, `@fitness-ignore-file`, `@fitness-ignore-block`.
11. [**Output, gate, SARIF**](./20-the-fit-loop/04-output-gate-sarif.md) — Render layer, baseline/compare flow, JSON shape, CI integration.

### 30 — The sim loop
*Simulation is opt-in and experimental — read after the fit loop is solid.*

12. [**Scenarios and recipes**](./30-the-sim-loop/01-scenarios-and-recipes.md) — What a sim scenario is, the four kinds, recipe composition.
13. [**Execution model**](./30-the-sim-loop/02-execution-model.md) — How the sim engine runs scenarios, reports findings, exits.

### 40 — Runtime
*How the system actually executes. Read after the loops for the mechanics behind the narrative.*

14. [**CLI dispatch**](./40-runtime/01-cli-dispatch.md) — argv parsing, tool registration, command tree assembly.
15. [**Plugin loader**](./40-runtime/02-plugin-loader.md) — Source-file auto-discovery, npm-package pinning, `plugin sync`.
16. [**Session and persistence**](./40-runtime/03-session-and-persistence.md) — Runtime dir layout, sessions, reports, logs, cache, baseline.

### 50 — Subsystems
*Narrative deep-dives. Each spans multiple packages; each gets a single end-to-end story.*

17. [**Language adapters**](./50-subsystems/01-language-adapters.md) — What an adapter is, the six bundled, authoring a new one.
18. [**Check pack architecture**](./50-subsystems/02-check-packs.md) — Built-in packs, scope filters, parameterization, marketplace shape.
19. [**Architecture gate**](./50-subsystems/03-architecture-gate.md) — Baseline workflow, drift detection, line-shift invariance, CI integration.

### 60 — Surfaces
*The edges of the system. What users and external systems touch.*

20. [**CLI command tree**](./60-surfaces/01-cli-command-tree.md) — Every command, its flags, when to use each.
21. [**Plugin authoring**](./60-surfaces/02-plugin-authoring.md) — Write your own check, recipe, scenario, or full Tool.
22. [**Dashboard**](./60-surfaces/03-dashboard.md) — The HTML report: what it shows, when it opens, where it lives.

### 70 — Reference
*Lookup-shaped. Not for sequential reading.*

23. [**Package catalog**](./70-reference/01-package-catalog.md) — All 17 packages with one-line role and key exports. Grouped by layer.
24. [**Configuration**](./70-reference/02-configuration.md) — `opensip-tools.config.yml` schema, every field, defaults.
25. [**JSON output schema**](./70-reference/03-json-output-schema.md) — The `CliOutput` shape consumed by CI and dashboards.

### 80 — Conventions
*Policy and style. For contributors.*

26. [**Coding standards**](./80-conventions/01-coding-standards.md) — TS strictness, error handling, exit codes, ESLint posture.
27. [**Layer policy**](./80-conventions/02-layer-policy.md) — Dependency-cruiser rules, allowed imports, why the kernel can't import a tool.
28. [**Doc conventions**](./80-conventions/03-doc-conventions.md) — Voice, frontmatter, diagrams, verification trails.

---

## Conventions

### Voice
- Second-person, narrative.
- Assumes engineering fluency — doesn't re-explain `tsconfig`, `glob pattern`, or `ESM module`.
- Present tense for current behavior; past for history; future (always labelled) for roadmap.

### Frontmatter
Every doc carries `title`, `audience`, `purpose`, `last_verified: YYYY-MM-DD`, `source-files`, `related-docs`.

### Diagrams
ASCII boxes inline by default — they survive plain-text rendering, code review, and grep. Mermaid where a real graph would help. No binary images.

### Worked example
A single hypothetical project — a TypeScript service called `acme-api` with a Python data pipeline — threads through multiple docs. Each runtime doc has a "Where the example lands" section so you can see the same scenario at every layer.

See [`./80-conventions/03-doc-conventions.md`](./80-conventions/03-doc-conventions.md) for the full conventions.

---

## Relationship to other docs

- **[`docs/coverage-status.md`](../coverage-status.md)** — Test coverage snapshot.
- **[`docs/json-output-schema.md`](../json-output-schema.md)** — JSON output reference (mirrored into [`70-reference/03-json-output-schema.md`](./70-reference/03-json-output-schema.md)).
- **[`docs/release-smoke-test.md`](../release-smoke-test.md)** — Release verification checklist.
- **[`README.md`](../../README.md)** — Marketing-shaped product README. Start *here* for architecture, not there.

---

## Status

Doc set authored 2026-05-15 against opensip-tools v1.0.0. The package count, the layer rules, the command surface, and the JSON output schema all reflect the v1 release.
