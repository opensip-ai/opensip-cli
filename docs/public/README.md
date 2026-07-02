---
status: current
last_verified: 2026-06-27
release: v0.2.4
owner: opensip-cli
indexable: true
title: "opensip-cli Docs"
audience: [getting-started, contributors, plugin-authors, ci-integrators]
purpose: "Public documentation entry point for opensip-cli v0.2.4: product overview, fast paths, and the full reference map."
---
# opensip-cli Docs

OpenSIP CLI is a local-first engineering quality platform for codebases that need more than a linter. It gives you one CLI for fitness checks, simulation scenarios, static call-graph analysis, baselines, SARIF, dashboards, and your own Tool plugins.

It runs in your repo and in CI. It works offline. It is designed for teams that want their quality bar to be explicit, versioned, and enforceable.

## What You Can Do

| Need | Use |
|---|---|
| Enforce project-specific quality, security, and architecture rules | `opensip fit` with 151 built-in checks across seven packs, plus your own checks |
| Adopt without fixing every historical issue first | `fit --gate-save` once, then `fit --gate-compare` in CI |
| Understand reachability, dead ends, duplication, cycles, and blast radius | `opensip graph` with five graph adapters and eleven built-in graph rules |
| Review evidence-backed code-reduction opportunities (advisory) | `opensip yagni` with bundled detectors and optional graph evidence |
| Run load or chaos scenarios against a service you control | `opensip sim` |
| Share internal rules across repos | Publish or install fit packs and sim scenario packs |
| Add an entire command to the CLI | Build a Tool plugin and manage it with `opensip tools ...` |
| Show results to humans | Open the local HTML report or export SARIF for code scanning |

## Start Here

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
cd your-project
opensip init
opensip fit --recipe example
```

That gets you from a clean shell to a working project scaffold and one passing fitness run. From there:

| If you want to ... | Read |
|---|---|
| Install, initialize, and run the first smoke test | [Quick start](./00-start/00-quick-start.md) |
| Understand what OpenSIP CLI is for | [What is opensip-cli?](./00-start/01-what-is-opensip-cli.md) |
| See fit, sim, graph, and yagni side by side | [Show me each loop](./00-start/02-show-me-the-loops.md) |
| Initialize a repo carefully | [Initialize your first repo](./60-guides/00-initialize-your-first-repo.md) |
| Write a custom fitness check | [Write your first check](./60-guides/01-write-your-first-check.md) |
| Use graph on a real project | [Use graph](./60-guides/06-use-graph.md) |
| Create your own CLI subcommand | [Create your first Tool](./60-guides/07-create-your-first-tool.md) |
| Wire the release gate into CI | [Wire into CI](./60-guides/03-wire-into-ci.md) |
| Connect Cursor, Claude Code, or Codex via MCP | [Connect MCP clients](./60-guides/08-connect-mcp-clients.md) |

## Command Map

The most common commands:

```bash
opensip init
opensip fit
opensip fit --list
opensip fit --check <slug>
opensip fit --gate-save
opensip fit --gate-compare
opensip graph
opensip graph --list-files
opensip graph --workspace
opensip yagni
opensip yagni --json
opensip sim --recipe <name>
opensip report
```

Whole Tool plugins are managed through the `tools` group:

```bash
opensip tools list
opensip tools validate <spec>
opensip tools install <spec> [--global|--project]
opensip tools uninstall <name-or-id> [--global|--project] [--purge-data]
opensip tools data-purge <tool-id>
```

For every command, flag, exit code, and machine-output contract, use the [CLI command reference](./70-reference/01-cli-commands.md). For Tool plugin management specifically, use the [`tools` command reference](./70-reference/12-tools-command.md).

## Recommended Paths

| Role | Path |
|---|---|
| Evaluating opensip-cli | [What is opensip-cli?](./00-start/01-what-is-opensip-cli.md) -> [vs. other tools](./00-start/03-vs-other-tools.md) -> [FAQ](./00-start/04-faq.md) |
| Understanding the two products | [What is opensip-cli?](./00-start/01-what-is-opensip-cli.md) -> [OpenSIP and OpenSIP CLI](./00-start/08-opensip-and-opensip-cli.md) |
| New user | [Quick start](./00-start/00-quick-start.md) -> [Initialize your first repo](./60-guides/00-initialize-your-first-repo.md) -> [Write your first check](./60-guides/01-write-your-first-check.md) |
| CI owner | [Output, gate, SARIF](./20-fit/04-output-gate-sarif.md) -> [Wire into CI](./60-guides/03-wire-into-ci.md) -> [Adopt in a monorepo](./60-guides/04-adopt-in-a-monorepo.md) |
| Plugin author | [Plugin authoring](./50-extend/01-plugin-authoring.md) -> [Publishable packs](./50-extend/03-publishable-packs.md) -> [Full Tool plugins](./50-extend/06-full-tool-plugins.md) -> [External tool adapters](./50-extend/08-external-tool-adapters.md) |
| Graph adopter | [Use graph](./60-guides/06-use-graph.md) -> [Stages and catalog](./40-graph/01-stages-and-catalog.md) -> [Rules and gating](./40-graph/02-rules-and-gating.md) |
| AI agent (CLI + MCP) | [Use OpenSIP with AI agents](./60-guides/use-opensip-with-ai-agents.md) -> [Connect MCP clients](./60-guides/08-connect-mcp-clients.md) |
| Contributor | [Architecture overview](./00-start/07-architecture-overview.md) -> [Layered package graph](./10-concepts/03-modular-monolith.md) -> [Layer policy](./80-implementation/05-layer-policy.md) |

## Full Docs Map

### 00 - Start

0. [Quick start](./00-start/00-quick-start.md)
1. [What is opensip-cli?](./00-start/01-what-is-opensip-cli.md)
2. [Show me each loop](./00-start/02-show-me-the-loops.md)
3. [vs. other tools](./00-start/03-vs-other-tools.md)
4. [FAQ](./00-start/04-faq.md)
5. [Vocabulary](./00-start/05-vocabulary.md)
6. [System context](./00-start/06-system-context.md)
7. [Architecture overview](./00-start/07-architecture-overview.md)
8. [OpenSIP and OpenSIP CLI](./00-start/08-opensip-and-opensip-cli.md)

### 10 - Concepts

8. [The fitness loop](./10-concepts/01-fitness-loop.md)
9. [The tool-plugin model](./10-concepts/02-tool-plugin-model.md)
10. [Layered package graph](./10-concepts/03-modular-monolith.md)
11. [Contract surfaces](./10-concepts/04-contract-surfaces.md)
12. [Architecture gate](./10-concepts/05-architecture-gate.md)
13. [CLI output rendering](./10-concepts/06-cli-output-rendering.md)
14. [Cloud signal sync](./10-concepts/06-cloud-signal-sync.md)

### 20 - Fit

15. [Recipes and checks](./20-fit/01-recipes-and-checks.md)
16. [Targets and scope](./20-fit/02-targets-and-scope.md)
17. [Ignore directives](./20-fit/03-ignore-directives.md)
18. [Output, gate, SARIF](./20-fit/04-output-gate-sarif.md)

### 30 - Sim

19. [Scenarios and recipes](./30-sim/01-scenarios-and-recipes.md)
20. [Execution model](./30-sim/02-execution-model.md)

### 40 - Graph

21. [Stages and catalog](./40-graph/01-stages-and-catalog.md)
22. [Rules and gating](./40-graph/02-rules-and-gating.md)
23. [Adding a language](./40-graph/03-adding-a-language.md)
24. [Suppressing findings](./40-graph/04-suppressing-findings.md)

### 55 - Yagni

25. [Command reference](./55-yagni/01-command-reference.md)

### 50 - Extend

26. [Plugin authoring](./50-extend/01-plugin-authoring.md)
27. [Project-local plugins](./50-extend/02-project-local-plugins.md)
28. [Publishable packs](./50-extend/03-publishable-packs.md)
29. [Check pack architecture](./50-extend/04-check-pack-architecture.md)
30. [Language adapters](./50-extend/05-language-adapters.md)
31. [Full Tool plugins](./50-extend/06-full-tool-plugins.md)

### 60 - Guides

32. [Initialize your first repo](./60-guides/00-initialize-your-first-repo.md)
33. [Write your first check](./60-guides/01-write-your-first-check.md)
34. [Ban an API pattern](./60-guides/02-ban-an-api-pattern.md)
35. [Wire into CI](./60-guides/03-wire-into-ci.md)
36. [Adopt in a monorepo](./60-guides/04-adopt-in-a-monorepo.md)
37. [Migrate from ESLint](./60-guides/05-migrate-from-eslint.md)
38. [Use graph](./60-guides/06-use-graph.md)
39. [Create your first Tool](./60-guides/07-create-your-first-tool.md)
40. [Use OpenSIP with AI agents](./60-guides/use-opensip-with-ai-agents.md)
41. [Connect MCP clients](./60-guides/08-connect-mcp-clients.md)

### 70 - Reference

42. [CLI commands](./70-reference/01-cli-commands.md)
43. [Package catalog](./70-reference/02-package-catalog.md)
44. [Configuration](./70-reference/03-configuration.md)
45. [JSON output schema](./70-reference/04-json-output-schema.md)
46. [Checks reference](./70-reference/05-checks-index.md)
47. [Report](./70-reference/06-dashboard.md)
48. [Supply-chain security](./70-reference/08-supply-chain-security.md)
49. [Environment variables](./70-reference/10-environment-variables.md)
50. [`tools` command](./70-reference/12-tools-command.md)

### 80 - Internals

51. [CLI dispatch](./80-implementation/01-cli-dispatch.md)
52. [Plugin loader](./80-implementation/02-plugin-loader.md)
53. [Session and persistence](./80-implementation/03-session-and-persistence.md)
54. [Coding standards](./80-implementation/04-coding-standards.md)
55. [Layer policy](./80-implementation/05-layer-policy.md)
56. [Doc conventions](./80-implementation/06-doc-conventions.md)
57. [Website integration](./80-implementation/07-website-integration.md)

## Factual Baseline

This v0.2.4 doc set was rechecked against the source on 2026-06-27:

- 151 built-in fitness checks across seven packs.
- 42 publishable workspace packages, plus the private `@opensip-cli/test-support` package.
- Four bundled first-party tools: `fit`, `graph`, `sim`, and `yagni`.
- Six fitness language adapters: TypeScript/JavaScript, Python, Rust, Go, Java, and C/C++.
- Five graph language adapters: TypeScript, Python, Rust, Go, and Java.
- First-party Tool commands are mounted through `CommandSpec`; third-party Tool plugins use the same contract.

The docs in `70-reference/` are lookup-shaped. The docs in `80-implementation/` are contributor-facing internals. Start with the guides unless you are reviewing a PR or writing platform code.
