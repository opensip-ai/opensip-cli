---
status: current
last_verified: 2026-05-22
release: v1.3.x
owner: opensip-tools
indexable: true
title: "opensip-tools Architecture"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "Teaching path through opensip-tools — what it is, how it thinks, how it runs — plus a lookup-shaped reference catalog."
---
# opensip-tools Architecture

A teaching path through opensip-tools. Read sections 00–20 top-to-bottom on your first pass to build a working mental model. Then jump around: subsystems (60) for narrative deep-dives, runtime (50) for execution mechanics, reference (80) when you need to look something up.

These docs are written for engineers fluent in TypeScript and Node tooling. Voice is second-person, narrative, and assumes you can read source. Every claim traces to source files; every doc carries a verification trail in its frontmatter.

**If you're an AI agent reading this:** the same docs work for you, but jump straight to [`80-reference/`](/docs/opensip-tools/80-reference/) for lookup-shaped material — the 00-30 sections are written narratively for human onboarding.

---

## How to read this

| If you're … | Read … |
|---|---|
| **Brand new to opensip-tools** | 00 → 10 → 20 in order. ~10 docs, ~90 minutes. You'll have a working mental model. |
| **Writing your first check or recipe** | 00 → 10 → 70 (`02-plugin-authoring`). The middle is unnecessary at first. |
| **Adding a fitness language adapter or check pack** | 60 (`01-language-adapters`, `02-check-packs`). Self-contained. |
| **Adding a graph language adapter** | 40 (`03-adding-a-language`). The contract test suite is the spec. |
| **Wiring opensip-tools into CI** | 20 (`04-output-gate-sarif`) + 60 (`03-architecture-gate`). |
| **Reviewing a PR that touches the kernel** | 90 (`02-layer-policy`) + 80 (`01-package-catalog`) for lookup. |
| **Looking for a specific package, command, or config field** | 80 — that's what it's for. |

---

## Reading order

### 00 — Orientation
*Read once. Establishes context for everything below.*

0. [**Quick start**](/docs/opensip-tools/00-orientation/00-quick-start/) — Four commands from clean shell to a passing fitness run. **Start here** if you want hands-on context before the conceptual material.
1. [**What is opensip-tools**](/docs/opensip-tools/00-orientation/01-what-is-opensip-tools/) — The product, the problem, the philosophy.
2. [**Vocabulary**](/docs/opensip-tools/00-orientation/02-vocabulary/) — Tool, recipe, check, scenario, signaler, target, language adapter, plugin, session. The terms used everywhere.
3. [**System context**](/docs/opensip-tools/00-orientation/03-system-context/) — Where opensip-tools sits between you, your codebase, CI, and OpenSIP Cloud. The runtime layout.

### 10 — Mental model
*The conceptual core. If you understand these four docs, you understand opensip-tools.*

4. [**The fitness loop**](/docs/opensip-tools/10-mental-model/01-fitness-loop/) — **The spine.** One check from definition to violation to gate decision. Threads through every later doc.
5. [**The tool-plugin model**](/docs/opensip-tools/10-mental-model/02-tool-plugin-model/) — Kernel + Tool contract + first-party tools + dispatcher. Why the CLI doesn't know what `fit` does.
6. [**Layered package graph**](/docs/opensip-tools/10-mental-model/03-modular-monolith/) — The 19-package monorepo, the layer rules, why dependency-cruiser exists.
7. [**Contract surfaces**](/docs/opensip-tools/10-mental-model/04-contract-surfaces/) — The system's public edges: CLI argv, Tool interface, plugin manifests, JSON output.

### 20 — The fit loop
*The fitness command's main flow. This is what 90% of users invoke.*

8. [**Recipes and checks**](/docs/opensip-tools/20-the-fit-loop/01-recipes-and-checks/) — What a recipe is, what a check is, how they compose. `defineCheck` and `defineRecipe`.
9. [**Targets and scope**](/docs/opensip-tools/20-the-fit-loop/02-targets-and-scope/) — Language detection, target registry, glob expansion, ignore handling.
10. [**Ignore directives**](/docs/opensip-tools/20-the-fit-loop/03-ignore-directives/) — Inline source-level suppression: `@fitness-ignore-next-line` and `@fitness-ignore-file`.
11. [**Output, gate, SARIF**](/docs/opensip-tools/20-the-fit-loop/04-output-gate-sarif/) — Render layer, baseline/compare flow, JSON shape, CI integration.

### 30 — The sim loop
*Simulation is opt-in and experimental — read after the fit loop is solid.*

12. [**Scenarios and recipes**](/docs/opensip-tools/30-the-sim-loop/01-scenarios-and-recipes/) — What a sim scenario is, the four kinds, recipe composition.
13. [**Execution model**](/docs/opensip-tools/30-the-sim-loop/02-execution-model/) — How the sim engine runs scenarios, reports findings, exits.

### 40 — The graph loop
*Static call-graph analysis: what `opensip-tools graph` produces and how the dashboard consumes it.*

14. [**Stages and catalog**](/docs/opensip-tools/40-the-graph-loop/01-stages-and-catalog/) — The six-stage pipeline (discover → inventory → edges → indexes → rules → render) and the catalog's on-disk shape.
15. [**Rules and gating**](/docs/opensip-tools/40-the-graph-loop/02-rules-and-gating/) — The five rules, entry-point inference, `--gate-save`/`--gate-compare`, SARIF output.
16. [**Adding a language**](/docs/opensip-tools/40-the-graph-loop/03-adding-a-language/) — Step-by-step guide for writing a new `GraphLanguageAdapter`.

### 50 — Runtime
*How the system actually executes. Read after the loops for the mechanics behind the narrative.*

17. [**CLI dispatch**](/docs/opensip-tools/50-runtime/01-cli-dispatch/) — argv parsing, tool registration, command tree assembly.
18. [**Plugin loader**](/docs/opensip-tools/50-runtime/02-plugin-loader/) — Source-file auto-discovery, npm-package pinning, `plugin sync`.
19. [**Session and persistence**](/docs/opensip-tools/50-runtime/03-session-and-persistence/) — Runtime dir layout, sessions, reports, logs, cache, baseline.

### 60 — Subsystems
*Narrative deep-dives. Each spans multiple packages; each gets a single end-to-end story.*

20. [**Language adapters**](/docs/opensip-tools/60-subsystems/01-language-adapters/) — What an adapter is, the six bundled, authoring a new one.
21. [**Check pack architecture**](/docs/opensip-tools/60-subsystems/02-check-packs/) — Built-in packs, scope filters, parameterization, marketplace shape.
22. [**Architecture gate**](/docs/opensip-tools/60-subsystems/03-architecture-gate/) — Baseline workflow, drift detection, line-shift invariance, CI integration.

### 70 — Surfaces
*The edges of the system. What users and external systems touch.*

23. [**CLI command tree**](/docs/opensip-tools/70-surfaces/01-cli-command-tree/) — Every command, its flags, when to use each.
24. [**Plugin authoring**](/docs/opensip-tools/70-surfaces/02-plugin-authoring/) — Write your own check, recipe, scenario, or full Tool.
25. [**Dashboard**](/docs/opensip-tools/70-surfaces/03-dashboard/) — The HTML report: what it shows, when it opens, where it lives.

### 80 — Reference
*Lookup-shaped. Not for sequential reading.*

26. [**Package catalog**](/docs/opensip-tools/80-reference/01-package-catalog/) — All 19 packages with one-line role and key exports. Grouped by layer.
27. [**Configuration**](/docs/opensip-tools/80-reference/02-configuration/) — `opensip-tools.config.yml` schema, every field, defaults.
28. [**JSON output schema**](/docs/opensip-tools/80-reference/03-json-output-schema/) — The `CliOutput` shape consumed by CI and dashboards.

### 90 — Conventions
*Policy and style. For contributors.*

29. [**Coding standards**](/docs/opensip-tools/90-conventions/01-coding-standards/) — TS strictness, error handling, exit codes, ESLint posture.
30. [**Layer policy**](/docs/opensip-tools/90-conventions/02-layer-policy/) — Dependency-cruiser rules, allowed imports, why the kernel can't import a tool.
31. [**Doc conventions**](/docs/opensip-tools/90-conventions/03-doc-conventions/) — Voice, frontmatter, diagrams, verification trails.

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

See [`./90-conventions/03-doc-conventions.md`](/docs/opensip-tools/90-conventions/03-doc-conventions/) for the full conventions.

---

## Relationship to other docs

- **[`docs/coverage-status.md`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/docs/coverage-status.md)** — Test coverage snapshot.
- **[`docs/json-output-schema.md`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/docs/json-output-schema.md)** — JSON output reference (mirrored into [`80-reference/03-json-output-schema.md`](/docs/opensip-tools/80-reference/03-json-output-schema/)).
- **[`docs/release-smoke-test.md`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/docs/release-smoke-test.md)** — Release verification checklist.
- **[`README.md`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/README.md)** — Marketing-shaped product README. Start *here* for architecture, not there.

---

## Status

Doc set authored 2026-05-15 against opensip-tools v1.0.0; re-verified against v1.3.x at 2026-05-22 (third tool `graph` and language-pluggability layer added; broken plan links pruned; JSON output union widened to include `graph`). The package count, the layer rules, the command surface, and the JSON output schema all reflect the current release.
