---
status: current
last_verified: 2026-05-22
release: v2.0.x
owner: opensip-tools
indexable: true
title: "opensip-tools Architecture"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "Teaching path through opensip-tools — what it is, how it thinks, how it runs — plus a lookup-shaped reference catalog."
---
# opensip-tools Architecture

A teaching path through opensip-tools. Read sections 00–20 top-to-bottom on your first pass to build a working mental model. Then jump around: per-tool (20, 30, 40) for the loops you care about, guides (60) for task-led walkthroughs, reference (70) when you need to look something up, internals (80) for contributor-only depth.

These docs are written for engineers fluent in TypeScript and Node tooling. Voice is second-person, narrative, and assumes you can read source. Every claim traces to source files; every doc carries a verification trail in its frontmatter.

**If you're an AI agent reading this:** the same docs work for you, but jump straight to [`70-reference/`](/docs/opensip-tools/70-reference/) for lookup-shaped material — the 00-40 sections are written narratively for human onboarding.

---

## How to read this

| If you're … | Read … |
|---|---|
| **Evaluating opensip-tools for the first time** | 00 (`00-what-is-opensip-tools` → `02-show-me-the-loops` → `03-vs-other-tools` → `04-faq`). Four short pages, ~10 minutes. Decide if the shape fits before going deeper. |
| **Looking for a specific check** | 70 (`05-checks-index`) — browsable list of all 145+ built-in checks, grouped by pack and tag. |
| **Brand new and committed to learning** | 00 → 10 → 20 in order. ~12 docs, ~90 minutes. You'll have a working mental model. |
| **Writing your first check or recipe** | 60 (`01-write-your-first-check`) — task-led walkthrough. Then 50 (`02-project-local-plugins`) for depth. |
| **Shipping a publishable check pack** | 50 (`03-publishable-packs`) for the authoring path, then (`04-check-pack-architecture`) for the platform internals. |
| **Adding a fitness language adapter** | 50 (`05-language-adapters`). Self-contained. |
| **Building a full Tool plugin (own subcommand)** | 50 (`06-full-tool-plugins`) + 10 (`02-tool-plugin-model`) for the architecture. |
| **Adding a graph language adapter** | 40 (`03-adding-a-language`). The contract test suite is the spec. |
| **Wiring opensip-tools into CI** | 60 (`03-wire-into-ci`) — full walkthrough with GitHub Actions example. Or 20 (`04-output-gate-sarif`) for the gate model alone. |
| **Adopting in a large monorepo** | 60 (`04-adopt-in-a-monorepo`) — workspace package graduation + baseline-gate flow. |
| **Migrating from ESLint (or coexisting with it)** | 60 (`05-migrate-from-eslint`) — which rules belong where. |
| **Reviewing a PR that touches the kernel** | 80 (`05-layer-policy`) + 70 (`02-package-catalog`) for lookup. |
| **Looking for a specific package, command, or config field** | 70 — that's what it's for. |

---

## Reading order

### 00 — Start
*The single first-touch section. The first three pages decide for you (pitch, install, code samples); the next two compare and clarify (vs. other tools, FAQ); the last two deepen for committed readers (vocabulary, runtime layout).*

0. [**What is opensip-tools?**](/docs/opensip-tools/00-start/00-what-is-opensip-tools/) — Front door: the pitch, the problem, the three loops, the install. Read this even if you read nothing else.
1. [**Quick start**](/docs/opensip-tools/00-start/01-quick-start/) — Four commands from clean shell to a passing fitness run.
2. [**Show me each loop**](/docs/opensip-tools/00-start/02-show-me-the-loops/) — One code sample per tool: a fit check, a sim scenario, a graph rule.
3. [**vs. other tools**](/docs/opensip-tools/00-start/03-vs-other-tools/) — Honest comparison with ESLint, Semgrep, Sonarqube, Snyk. When to use opensip-tools and when not to.
4. [**FAQ**](/docs/opensip-tools/00-start/04-faq/) — Common questions about adoption, edge cases, and what opensip-tools deliberately doesn't do.
5. [**Vocabulary**](/docs/opensip-tools/00-start/05-vocabulary/) — Tool, recipe, check, scenario, signaler, target, language adapter, plugin, session. The terms used everywhere.
6. [**System context**](/docs/opensip-tools/00-start/06-system-context/) — Where opensip-tools sits between you, your codebase, CI, and OpenSIP Cloud. The runtime layout.

### 10 — Concepts
*The conceptual core. If you understand these five docs, you understand opensip-tools.*

7. [**The fitness loop**](/docs/opensip-tools/10-concepts/01-fitness-loop/) — **The spine.** One check from definition to violation to gate decision. Threads through every later doc.
8. [**The tool-plugin model**](/docs/opensip-tools/10-concepts/02-tool-plugin-model/) — Kernel + Tool contract + first-party tools + dispatcher. Why the CLI doesn't know what `fit` does.
9. [**Layered package graph**](/docs/opensip-tools/10-concepts/03-modular-monolith/) — The 29-package monorepo, the layer rules, why dependency-cruiser exists.
10. [**Contract surfaces**](/docs/opensip-tools/10-concepts/04-contract-surfaces/) — The system's public edges: CLI argv, Tool interface, plugin manifests, JSON output.
11. [**Architecture gate**](/docs/opensip-tools/10-concepts/05-architecture-gate/) — Baseline workflow, drift detection, line-shift invariance, CI integration.

### 20 — Fit
*The fitness command's main flow. This is what 90% of users invoke.*

12. [**Recipes and checks**](/docs/opensip-tools/20-fit/01-recipes-and-checks/) — What a recipe is, what a check is, how they compose. `defineCheck` and `defineRecipe`.
13. [**Targets and scope**](/docs/opensip-tools/20-fit/02-targets-and-scope/) — Language detection, target registry, glob expansion, ignore handling.
14. [**Ignore directives**](/docs/opensip-tools/20-fit/03-ignore-directives/) — Inline source-level suppression: `@fitness-ignore-next-line` and `@fitness-ignore-file`.
15. [**Output, gate, SARIF**](/docs/opensip-tools/20-fit/04-output-gate-sarif/) — Render layer, baseline/compare flow, JSON shape, CI integration.

### 30 — Sim
*Simulation is opt-in and experimental — read after the fit loop is solid.*

16. [**Scenarios and recipes**](/docs/opensip-tools/30-sim/01-scenarios-and-recipes/) — What a sim scenario is, the four kinds, recipe composition.
17. [**Execution model**](/docs/opensip-tools/30-sim/02-execution-model/) — How the sim engine runs scenarios, reports findings, exits.

### 40 — Graph
*Static call-graph analysis: what `opensip-tools graph` produces and how the dashboard consumes it.*

18. [**Stages and catalog**](/docs/opensip-tools/40-graph/01-stages-and-catalog/) — The six-stage pipeline (discover → inventory → edges → indexes → rules → render) and the catalog's on-disk shape.
19. [**Rules and gating**](/docs/opensip-tools/40-graph/02-rules-and-gating/) — The six rules, entry-point inference, `--gate-save`/`--gate-compare`, SARIF output.
20. [**Adding a language**](/docs/opensip-tools/40-graph/03-adding-a-language/) — Step-by-step guide for writing a new `GraphLanguageAdapter`.

### 50 — Extend
*Author plugins. Project-local `.mjs` files, publishable check packs, language adapters, full Tool plugins.*

21. [**Plugin authoring**](/docs/opensip-tools/50-extend/01-plugin-authoring/) — Overview of the five extension shapes. Routes you to the right deep-dive.
22. [**Project-local plugins**](/docs/opensip-tools/50-extend/02-project-local-plugins/) — Loose `.mjs` files for check, recipe, sim scenario. The fastest path.
23. [**Publishable packs**](/docs/opensip-tools/50-extend/03-publishable-packs/) — Workspace + npm-pack authoring walkthrough; migration recipe from loose `.mjs`.
24. [**Check pack architecture**](/docs/opensip-tools/50-extend/04-check-pack-architecture/) — Platform internals: pack contract, scope filters, parameterization, discovery.
25. [**Language adapters**](/docs/opensip-tools/50-extend/05-language-adapters/) — What an adapter is, the six bundled, authoring a new one.
26. [**Full Tool plugins**](/docs/opensip-tools/50-extend/06-full-tool-plugins/) — Your own subcommand. The Tool contract.

### 60 — Guides
*Task-led walkthroughs. Pick the one that matches "I want to …".*

27. [**Write your first check**](/docs/opensip-tools/60-guides/01-write-your-first-check/) — From `init` to `--gate-save` in 15 minutes. The starting walkthrough.
28. [**Ban an API pattern**](/docs/opensip-tools/60-guides/02-ban-an-api-pattern/) — Concrete recipe: "block all uses of `crypto.createCipher`". Covers regex vs. AST.
29. [**Wire into CI**](/docs/opensip-tools/60-guides/03-wire-into-ci/) — GitHub Actions example with SARIF upload + baseline gate.
30. [**Adopt in a monorepo**](/docs/opensip-tools/60-guides/04-adopt-in-a-monorepo/) — Workspace-package graduation + baseline-gate flow for large repos.
31. [**Migrate from ESLint**](/docs/opensip-tools/60-guides/05-migrate-from-eslint/) — Which rules belong in ESLint, which belong in opensip-tools, how they coexist.

### 70 — Reference
*Lookup-shaped. Not for sequential reading.*

32. [**CLI commands**](/docs/opensip-tools/70-reference/01-cli-commands/) — Every command, its flags, when to use each.
33. [**Package catalog**](/docs/opensip-tools/70-reference/02-package-catalog/) — All 29 packages with one-line role and key exports. Grouped by layer.
34. [**Configuration**](/docs/opensip-tools/70-reference/03-configuration/) — `opensip-tools.config.yml` schema, every field, defaults.
35. [**JSON output schema**](/docs/opensip-tools/70-reference/04-json-output-schema/) — The `CliOutput` shape consumed by CI and dashboards.
36. [**Checks reference**](/docs/opensip-tools/70-reference/05-checks-index/) — Browsable index of every built-in fit check, grouped by pack and primary tag. Auto-generated from source.
37. [**Dashboard**](/docs/opensip-tools/70-reference/06-dashboard/) — The HTML report: what it shows, when it opens, where it lives.

### 80 — Internals
*For contributors and PR reviewers. Runtime mechanics, layer policy, doc conventions, website integration.*

38. [**CLI dispatch**](/docs/opensip-tools/80-implementation/01-cli-dispatch/) — argv parsing, tool registration, command tree assembly.
39. [**Plugin loader**](/docs/opensip-tools/80-implementation/02-plugin-loader/) — Source-file auto-discovery, npm-package pinning, `plugin sync`.
40. [**Session and persistence**](/docs/opensip-tools/80-implementation/03-session-and-persistence/) — Runtime dir layout, sessions, reports, logs, cache, baseline.
41. [**Coding standards**](/docs/opensip-tools/80-implementation/04-coding-standards/) — TS strictness, error handling, exit codes, ESLint posture.
42. [**Layer policy**](/docs/opensip-tools/80-implementation/05-layer-policy/) — Dependency-cruiser rules, allowed imports, why the kernel can't import a tool.
43. [**Doc conventions**](/docs/opensip-tools/80-implementation/06-doc-conventions/) — Voice, frontmatter, diagrams, verification trails.
44. [**Website integration**](/docs/opensip-tools/80-implementation/07-website-integration/) — How opensip.ai consumes `docs/web-generated/`: proxy, route, manifest contract.

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

See [`./80-implementation/06-doc-conventions.md`](/docs/opensip-tools/80-implementation/06-doc-conventions/) for the full conventions.

---

## Relationship to other docs

- **[`README.md`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/README.md)** — Marketing-shaped product README. Start *here* for architecture, not there.

---

## Status

Doc set authored 2026-05-15 against opensip-tools v1.0.0; re-verified against v2.0.0 at 2026-05-26 (SQLite + Drizzle persistence kernel `@opensip-tools/datastore` extracted; marker-based plugin discovery added alongside scope-prefix; graph language adapters promoted from internal subdirs to publishable `@opensip-tools/graph-*` packages with Go and Java support; `@opensip-tools/cli-ui` extracted from `cli/`; `@opensip-tools/checks-rust` added). The package count, the layer rules, the command surface, and the JSON output schema all reflect the current release.
