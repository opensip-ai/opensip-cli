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

**If you're an AI agent reading this:** the same docs work for you, but jump straight to [`70-reference/`](./70-reference/) for lookup-shaped material — the 00-40 sections are written narratively for human onboarding.

---

## How to read this

| If you're … | Read … |
|---|---|
| **Evaluating opensip-tools for the first time** | 00 (`01-what-is-opensip-tools` → `02-show-me-the-loops` → `03-vs-other-tools` → `04-faq`). Four short pages, ~10 minutes. Decide if the shape fits before going deeper. |
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
| **Wondering what gets sent to the cloud (and how to turn it off)** | 10 (`06-cloud-signal-sync`) — the pipeline, the exact payload, and the three opt-outs. |
| **Reviewing a PR that touches the kernel** | 80 (`05-layer-policy`) + 70 (`02-package-catalog`) for lookup. |
| **Looking for a specific package, command, or config field** | 70 — that's what it's for. |

---

## Reading order

### 00 — Start
*The single first-touch section. The first three pages decide for you (install, pitch, code samples); the next two compare and clarify (vs. other tools, FAQ); the last two deepen for committed readers (vocabulary, runtime layout).*

0. [**Quick start**](./00-start/00-quick-start.md) — Install and go: from a clean shell to a passing fitness run in four commands. Start here. (Already on `@opensip-tools/cli`? The upgrade/migration note lives here too.)
1. [**What is opensip-tools?**](./00-start/01-what-is-opensip-tools.md) — The pitch, the problem, the three loops. The conceptual front door — read it right after you've run the quick start.
2. [**Show me each loop**](./00-start/02-show-me-the-loops.md) — One code sample per tool: a fit check, a sim scenario, a graph rule.
3. [**vs. other tools**](./00-start/03-vs-other-tools.md) — Honest comparison with ESLint, Semgrep, Sonarqube, Snyk. When to use opensip-tools and when not to.
4. [**FAQ**](./00-start/04-faq.md) — Common questions about adoption, edge cases, and what opensip-tools deliberately doesn't do.
5. [**Vocabulary**](./00-start/05-vocabulary.md) — Tool, recipe, check, scenario, signaler, target, language adapter, plugin, session. The terms used everywhere.
6. [**System context**](./00-start/06-system-context.md) — Where opensip-tools sits between you, your codebase, CI, and OpenSIP Cloud. The runtime layout.

### 10 — Concepts
*The conceptual core. If you understand these six docs, you understand opensip-tools.*

7. [**The fitness loop**](./10-concepts/01-fitness-loop.md) — **The spine.** One check from definition to violation to gate decision. Threads through every later doc.
8. [**The tool-plugin model**](./10-concepts/02-tool-plugin-model.md) — Kernel + Tool contract + first-party tools + dispatcher. Why the CLI doesn't know what `fit` does.
9. [**Layered package graph**](./10-concepts/03-modular-monolith.md) — The 30-package monorepo, the layer rules, why dependency-cruiser exists.
10. [**Contract surfaces**](./10-concepts/04-contract-surfaces.md) — The system's public edges: CLI argv, Tool interface, plugin manifests, JSON output.
11. [**Architecture gate**](./10-concepts/05-architecture-gate.md) — Baseline workflow, drift detection, line-shift invariance, CI integration.
12. [**Cloud signal sync**](./10-concepts/06-cloud-signal-sync.md) — How an entitled run's findings reach OpenSIP Cloud: the pipeline, the `SignalBatch` payload, fail-closed entitlement, and the three opt-outs.

### 20 — Fit
*The fitness command's main flow. This is what 90% of users invoke.*

13. [**Recipes and checks**](./20-fit/01-recipes-and-checks.md) — What a recipe is, what a check is, how they compose. `defineCheck` and `defineRecipe`.
14. [**Targets and scope**](./20-fit/02-targets-and-scope.md) — Language detection, target registry, glob expansion, ignore handling.
15. [**Ignore directives**](./20-fit/03-ignore-directives.md) — Inline source-level suppression: `@fitness-ignore-next-line` and `@fitness-ignore-file`.
16. [**Output, gate, SARIF**](./20-fit/04-output-gate-sarif.md) — Render layer, baseline/compare flow, JSON shape, CI integration.

### 30 — Sim
*Simulation is opt-in and experimental — read after the fit loop is solid.*

17. [**Scenarios and recipes**](./30-sim/01-scenarios-and-recipes.md) — What a sim scenario is, the four kinds, recipe composition.
18. [**Execution model**](./30-sim/02-execution-model.md) — How the sim engine runs scenarios, reports findings, exits.

### 40 — Graph
*Static call-graph analysis: what `opensip-tools graph` produces and how the dashboard consumes it.*

19. [**Stages and catalog**](./40-graph/01-stages-and-catalog.md) — The seven-stage pipeline (discover → inventory → edges → indexes → features → rules → render) and the catalog's on-disk shape.
20. [**Rules and gating**](./40-graph/02-rules-and-gating.md) — The ten rules, entry-point inference, `--gate-save`/`--gate-compare`, SARIF output.
21. [**Adding a language**](./40-graph/03-adding-a-language.md) — Step-by-step guide for writing a new `GraphLanguageAdapter`.

### 50 — Extend
*Author plugins. Project-local `.mjs` files, publishable check packs, language adapters, full Tool plugins.*

22. [**Plugin authoring**](./50-extend/01-plugin-authoring.md) — Overview of the five extension shapes. Routes you to the right deep-dive.
23. [**Project-local plugins**](./50-extend/02-project-local-plugins.md) — Loose `.mjs` files for check, recipe, sim scenario. The fastest path.
24. [**Publishable packs**](./50-extend/03-publishable-packs.md) — Workspace + npm-pack authoring walkthrough; migration recipe from loose `.mjs`.
25. [**Check pack architecture**](./50-extend/04-check-pack-architecture.md) — Platform internals: pack contract, scope filters, parameterization, discovery.
26. [**Language adapters**](./50-extend/05-language-adapters.md) — What an adapter is, the six bundled, authoring a new one.
27. [**Full Tool plugins**](./50-extend/06-full-tool-plugins.md) — Your own subcommand. The Tool contract.

### 60 — Guides
*Task-led walkthroughs. Pick the one that matches "I want to …".*

28. [**Write your first check**](./60-guides/01-write-your-first-check.md) — From `init` to `--gate-save` in 15 minutes. The starting walkthrough.
29. [**Ban an API pattern**](./60-guides/02-ban-an-api-pattern.md) — Concrete recipe: "block all uses of `crypto.createCipher`". Covers regex vs. AST.
30. [**Wire into CI**](./60-guides/03-wire-into-ci.md) — GitHub Actions example with SARIF upload + baseline gate.
31. [**Adopt in a monorepo**](./60-guides/04-adopt-in-a-monorepo.md) — Workspace-package graduation + baseline-gate flow for large repos.
32. [**Migrate from ESLint**](./60-guides/05-migrate-from-eslint.md) — Which rules belong in ESLint, which belong in opensip-tools, how they coexist.

### 70 — Reference
*Lookup-shaped. Not for sequential reading.*

33. [**CLI commands**](./70-reference/01-cli-commands.md) — Every command, its flags, when to use each.
34. [**Package catalog**](./70-reference/02-package-catalog.md) — All 30 packages with one-line role and key exports. Grouped by layer.
35. [**Configuration**](./70-reference/03-configuration.md) — `opensip-tools.config.yml` schema, every field, defaults.
36. [**JSON output schema**](./70-reference/04-json-output-schema.md) — The `SignalEnvelope` shape consumed by CI and dashboards.
37. [**Checks reference**](./70-reference/05-checks-index.md) — Browsable index of every built-in fit check, grouped by pack and primary tag. Auto-generated from source.
38. [**Dashboard**](./70-reference/06-dashboard.md) — The HTML report: what it shows, when it opens, where it lives.

### 80 — Internals
*For contributors and PR reviewers. Runtime mechanics, layer policy, doc conventions, website integration.*

39. [**CLI dispatch**](./80-implementation/01-cli-dispatch.md) — argv parsing, tool registration, command tree assembly.
40. [**Plugin loader**](./80-implementation/02-plugin-loader.md) — Source-file auto-discovery, npm-package pinning, `plugin sync`.
41. [**Session and persistence**](./80-implementation/03-session-and-persistence.md) — Runtime dir layout, sessions, reports, logs, cache, baseline.
42. [**Coding standards**](./80-implementation/04-coding-standards.md) — TS strictness, error handling, exit codes, ESLint posture.
43. [**Layer policy**](./80-implementation/05-layer-policy.md) — Dependency-cruiser rules, allowed imports, why the kernel can't import a tool.
44. [**Doc conventions**](./80-implementation/06-doc-conventions.md) — Voice, frontmatter, diagrams, verification trails.
45. [**Website integration**](./80-implementation/07-website-integration.md) — How opensip.ai consumes `docs/web-generated/`: proxy, route, manifest contract.

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

See [`./80-implementation/06-doc-conventions.md`](./80-implementation/06-doc-conventions.md) for the full conventions.

---

## Relationship to other docs

- **[`README.md`](../../README.md)** — Marketing-shaped product README. Start *here* for architecture, not there.

---

## Status

Doc set authored 2026-05-15 against opensip-tools v1.0.0; re-verified against v2.0.0 at 2026-05-26 (SQLite + Drizzle persistence kernel `@opensip-tools/datastore` extracted; marker-based plugin discovery added alongside scope-prefix; graph language adapters promoted from internal subdirs to publishable `@opensip-tools/graph-*` packages with Go and Java support; `@opensip-tools/cli-ui` extracted from `cli/`; `@opensip-tools/checks-rust` added). The package count, the layer rules, the command surface, and the JSON output schema all reflect the current release.
