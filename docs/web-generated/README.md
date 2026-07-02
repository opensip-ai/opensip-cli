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
| Install, initialize, and run the first smoke test | [Quick start](/docs/opensip-cli/00-start/00-quick-start/) |
| Understand what OpenSIP CLI is for | [What is opensip-cli?](/docs/opensip-cli/00-start/01-what-is-opensip-cli/) |
| See fit, sim, graph, and yagni side by side | [Show me each loop](/docs/opensip-cli/00-start/02-show-me-the-loops/) |
| Initialize a repo carefully | [Initialize your first repo](/docs/opensip-cli/60-guides/00-initialize-your-first-repo/) |
| Write a custom fitness check | [Write your first check](/docs/opensip-cli/60-guides/01-write-your-first-check/) |
| Use graph on a real project | [Use graph](/docs/opensip-cli/60-guides/06-use-graph/) |
| Create your own CLI subcommand | [Create your first Tool](/docs/opensip-cli/60-guides/07-create-your-first-tool/) |
| Wire the release gate into CI | [Wire into CI](/docs/opensip-cli/60-guides/03-wire-into-ci/) |
| Connect Cursor, Claude Code, or Codex via MCP | [Connect MCP clients](/docs/opensip-cli/60-guides/08-connect-mcp-clients/) |

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

For every command, flag, exit code, and machine-output contract, use the [CLI command reference](/docs/opensip-cli/70-reference/01-cli-commands/). For Tool plugin management specifically, use the [`tools` command reference](/docs/opensip-cli/70-reference/12-tools-command/).

## Recommended Paths

| Role | Path |
|---|---|
| Evaluating opensip-cli | [What is opensip-cli?](/docs/opensip-cli/00-start/01-what-is-opensip-cli/) -> [vs. other tools](/docs/opensip-cli/00-start/03-vs-other-tools/) -> [FAQ](/docs/opensip-cli/00-start/04-faq/) |
| Understanding the two products | [What is opensip-cli?](/docs/opensip-cli/00-start/01-what-is-opensip-cli/) -> [OpenSIP and OpenSIP CLI](/docs/opensip-cli/00-start/08-opensip-and-opensip-cli/) |
| New user | [Quick start](/docs/opensip-cli/00-start/00-quick-start/) -> [Initialize your first repo](/docs/opensip-cli/60-guides/00-initialize-your-first-repo/) -> [Write your first check](/docs/opensip-cli/60-guides/01-write-your-first-check/) |
| CI owner | [Output, gate, SARIF](/docs/opensip-cli/20-fit/04-output-gate-sarif/) -> [Wire into CI](/docs/opensip-cli/60-guides/03-wire-into-ci/) -> [Adopt in a monorepo](/docs/opensip-cli/60-guides/04-adopt-in-a-monorepo/) |
| Plugin author | [Plugin authoring](/docs/opensip-cli/50-extend/01-plugin-authoring/) -> [Publishable packs](/docs/opensip-cli/50-extend/03-publishable-packs/) -> [Full Tool plugins](/docs/opensip-cli/50-extend/06-full-tool-plugins/) -> [External tool adapters](/docs/opensip-cli/50-extend/08-external-tool-adapters/) |
| Graph adopter | [Use graph](/docs/opensip-cli/60-guides/06-use-graph/) -> [Stages and catalog](/docs/opensip-cli/40-graph/01-stages-and-catalog/) -> [Rules and gating](/docs/opensip-cli/40-graph/02-rules-and-gating/) |
| AI agent (CLI + MCP) | [Use OpenSIP with AI agents](/docs/opensip-cli/60-guides/use-opensip-with-ai-agents/) -> [Connect MCP clients](/docs/opensip-cli/60-guides/08-connect-mcp-clients/) |
| Contributor | [Architecture overview](/docs/opensip-cli/00-start/07-architecture-overview/) -> [Layered package graph](/docs/opensip-cli/10-concepts/03-modular-monolith/) -> [Layer policy](/docs/opensip-cli/80-implementation/05-layer-policy/) |

## Full Docs Map

### 00 - Start

0. [Quick start](/docs/opensip-cli/00-start/00-quick-start/)
1. [What is opensip-cli?](/docs/opensip-cli/00-start/01-what-is-opensip-cli/)
2. [Show me each loop](/docs/opensip-cli/00-start/02-show-me-the-loops/)
3. [vs. other tools](/docs/opensip-cli/00-start/03-vs-other-tools/)
4. [FAQ](/docs/opensip-cli/00-start/04-faq/)
5. [Vocabulary](/docs/opensip-cli/00-start/05-vocabulary/)
6. [System context](/docs/opensip-cli/00-start/06-system-context/)
7. [Architecture overview](/docs/opensip-cli/00-start/07-architecture-overview/)
8. [OpenSIP and OpenSIP CLI](/docs/opensip-cli/00-start/08-opensip-and-opensip-cli/)

### 10 - Concepts

8. [The fitness loop](/docs/opensip-cli/10-concepts/01-fitness-loop/)
9. [The tool-plugin model](/docs/opensip-cli/10-concepts/02-tool-plugin-model/)
10. [Layered package graph](/docs/opensip-cli/10-concepts/03-modular-monolith/)
11. [Contract surfaces](/docs/opensip-cli/10-concepts/04-contract-surfaces/)
12. [Architecture gate](/docs/opensip-cli/10-concepts/05-architecture-gate/)
13. [CLI output rendering](/docs/opensip-cli/10-concepts/06-cli-output-rendering/)
14. [Cloud signal sync](/docs/opensip-cli/10-concepts/06-cloud-signal-sync/)

### 20 - Fit

15. [Recipes and checks](/docs/opensip-cli/20-fit/01-recipes-and-checks/)
16. [Targets and scope](/docs/opensip-cli/20-fit/02-targets-and-scope/)
17. [Ignore directives](/docs/opensip-cli/20-fit/03-ignore-directives/)
18. [Output, gate, SARIF](/docs/opensip-cli/20-fit/04-output-gate-sarif/)

### 30 - Sim

19. [Scenarios and recipes](/docs/opensip-cli/30-sim/01-scenarios-and-recipes/)
20. [Execution model](/docs/opensip-cli/30-sim/02-execution-model/)

### 40 - Graph

21. [Stages and catalog](/docs/opensip-cli/40-graph/01-stages-and-catalog/)
22. [Rules and gating](/docs/opensip-cli/40-graph/02-rules-and-gating/)
23. [Adding a language](/docs/opensip-cli/40-graph/03-adding-a-language/)
24. [Suppressing findings](/docs/opensip-cli/40-graph/04-suppressing-findings/)

### 55 - Yagni

25. [Command reference](/docs/opensip-cli/55-yagni/01-command-reference/)

### 50 - Extend

26. [Plugin authoring](/docs/opensip-cli/50-extend/01-plugin-authoring/)
27. [Project-local plugins](/docs/opensip-cli/50-extend/02-project-local-plugins/)
28. [Publishable packs](/docs/opensip-cli/50-extend/03-publishable-packs/)
29. [Check pack architecture](/docs/opensip-cli/50-extend/04-check-pack-architecture/)
30. [Language adapters](/docs/opensip-cli/50-extend/05-language-adapters/)
31. [Full Tool plugins](/docs/opensip-cli/50-extend/06-full-tool-plugins/)

### 60 - Guides

32. [Initialize your first repo](/docs/opensip-cli/60-guides/00-initialize-your-first-repo/)
33. [Write your first check](/docs/opensip-cli/60-guides/01-write-your-first-check/)
34. [Ban an API pattern](/docs/opensip-cli/60-guides/02-ban-an-api-pattern/)
35. [Wire into CI](/docs/opensip-cli/60-guides/03-wire-into-ci/)
36. [Adopt in a monorepo](/docs/opensip-cli/60-guides/04-adopt-in-a-monorepo/)
37. [Migrate from ESLint](/docs/opensip-cli/60-guides/05-migrate-from-eslint/)
38. [Use graph](/docs/opensip-cli/60-guides/06-use-graph/)
39. [Create your first Tool](/docs/opensip-cli/60-guides/07-create-your-first-tool/)
40. [Use OpenSIP with AI agents](/docs/opensip-cli/60-guides/use-opensip-with-ai-agents/)
41. [Connect MCP clients](/docs/opensip-cli/60-guides/08-connect-mcp-clients/)

### 70 - Reference

42. [CLI commands](/docs/opensip-cli/70-reference/01-cli-commands/)
43. [Package catalog](/docs/opensip-cli/70-reference/02-package-catalog/)
44. [Configuration](/docs/opensip-cli/70-reference/03-configuration/)
45. [JSON output schema](/docs/opensip-cli/70-reference/04-json-output-schema/)
46. [Checks reference](/docs/opensip-cli/70-reference/05-checks-index/)
47. [Report](/docs/opensip-cli/70-reference/06-dashboard/)
48. [Supply-chain security](/docs/opensip-cli/70-reference/08-supply-chain-security/)
49. [Environment variables](/docs/opensip-cli/70-reference/10-environment-variables/)
50. [`tools` command](/docs/opensip-cli/70-reference/12-tools-command/)

### 80 - Internals

51. [CLI dispatch](/docs/opensip-cli/80-implementation/01-cli-dispatch/)
52. [Plugin loader](/docs/opensip-cli/80-implementation/02-plugin-loader/)
53. [Session and persistence](/docs/opensip-cli/80-implementation/03-session-and-persistence/)
54. [Coding standards](/docs/opensip-cli/80-implementation/04-coding-standards/)
55. [Layer policy](/docs/opensip-cli/80-implementation/05-layer-policy/)
56. [Doc conventions](/docs/opensip-cli/80-implementation/06-doc-conventions/)
57. [Website integration](/docs/opensip-cli/80-implementation/07-website-integration/)

## Factual Baseline

This v0.2.4 doc set was rechecked against the source on 2026-06-27:

- 151 built-in fitness checks across seven packs.
- 42 publishable workspace packages, plus the private `@opensip-cli/test-support` package.
- Four bundled first-party tools: `fit`, `graph`, `sim`, and `yagni`.
- Six fitness language adapters: TypeScript/JavaScript, Python, Rust, Go, Java, and C/C++.
- Five graph language adapters: TypeScript, Python, Rust, Go, and Java.
- First-party Tool commands are mounted through `CommandSpec`; third-party Tool plugins use the same contract.

The docs in `70-reference/` are lookup-shaped. The docs in `80-implementation/` are contributor-facing internals. Start with the guides unless you are reviewing a PR or writing platform code.
