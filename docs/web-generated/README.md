---
status: current
last_verified: 2026-07-07
release: v0.5.0
owner: opensip-cli
indexable: true
title: "opensip-cli Docs"
audience: [getting-started, contributors, plugin-authors, ci-integrators]
purpose: "Public documentation entry point for opensip-cli v0.5.0: product overview, fast paths, and the full reference map."
---
# opensip-cli Docs

OpenSIP CLI is a local-first engineering quality platform for codebases that need more than a linter. It gives you one CLI for fitness checks, simulation scenarios, static call-graph analysis, baselines, SARIF, dashboards, and your own Tool plugins.

It runs in your repo and in CI. It works offline. It is designed for teams that want their quality bar to be explicit, versioned, and enforceable.

## What You Can Do

| Need | Use |
|---|---|
| Enforce project-specific quality, security, and architecture rules | `opensip fit` with 160 built-in checks across seven packs, plus your own checks |
| Adopt without fixing every historical issue first | `fit --gate-save` once, then `fit --gate-compare` in CI |
| Run a multi-tool review in one command | `opensip suite run audit` for changed-scope fit, graph, and review-brief evidence |
| Understand reachability, dead ends, duplication, cycles, and blast radius | `opensip graph` with five graph adapters and eleven built-in graph rules |
| Review evidence-backed code-reduction opportunities (advisory) | `opensip yagni` with bundled detectors and optional graph evidence |
| Run load or chaos scenarios against a service you control | `opensip sim` |
| Bring existing scanners into the same report and gate | Opt in to one of 16 adapters, including Gitleaks, Semgrep, Ruff, golangci-lint, cargo-deny, Bandit, PMD, Cppcheck, OSV-Scanner, and Trivy |
| Share internal rules across repos | Publish or install fit packs and sim scenario packs |
| Add an entire command to the CLI | Build a Tool plugin and manage it with `opensip tools ...` |
| Give coding agents deterministic repo evidence | `opensip agent-catalog --json`, `opensip mcp`, filtered JSON, sessions, and graph impact |
| Show results to humans and CI systems | Open the local HTML report or export SARIF for code scanning |

## Start Here

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
cd your-project
opensip suite run audit
opensip init
opensip fit --recipe example
opensip report
```

That gets you from a clean shell to a changed-scope audit, a working project
scaffold, one passing fitness run, and the local HTML report. From there:

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
| Verify release artifacts | [Verifiable releases](/docs/opensip-cli/70-reference/13-verifiable-releases/) |
| Inspect detection-quality methodology | [Detection quality](/docs/opensip-cli/70-reference/14-detection-quality/) |
| Audit contract/version compatibility | [Compatibility policy](/docs/opensip-cli/70-reference/15-compatibility-policy/) |
| Connect Cursor, Claude Code, or Codex via MCP | [Connect MCP clients](/docs/opensip-cli/60-guides/08-connect-mcp-clients/) |

## Command Map

The most common commands:

```bash
opensip init
opensip suite run audit
opensip fit
opensip fit list
opensip fit recipes
opensip fit --check <slug>
opensip fit --gate-save
opensip fit --gate-compare
opensip graph
opensip graph --list-files
opensip graph --workspace
opensip graph impact --changed --json --top 20
opensip yagni
opensip yagni --json
opensip sim --recipe <name>
opensip agent-catalog --json
opensip mcp --cwd /path/to/repo
opensip report
```

Whole Tool plugins are managed through the `tools` group:

```bash
opensip tools list
opensip tools list --available [--lang <language>]
opensip tools doctor
opensip tools validate <spec>
opensip tools install <spec> [--global|--project]
opensip tools uninstall <name-or-id> [--global|--project] [--purge-data]
opensip tools data-purge <tool-id>
```

Opt-in scanner adapters use the same Tool plugin path and then mount normal
commands:

```bash
opensip tools list --available --lang python
opensip tools install @opensip-cli/tool-gitleaks
opensip gitleaks doctor
opensip gitleaks --json --gate-save
```

Adapters currently cover secrets, SAST/structural search, Python/Go/Rust linting,
dependency vulnerabilities, Java analysis, and C/C++ static analysis. The adapter
package does not install the scanner binary; `opensip <tool> doctor` verifies the
local binary and prerequisites.

For every command, flag, exit code, and machine-output contract, use the [CLI command reference](/docs/opensip-cli/70-reference/01-cli-commands/). For Tool plugin management specifically, use the [`tools` command reference](/docs/opensip-cli/70-reference/12-tools-command/).

## Recommended Paths

| Role | Path |
|---|---|
| Evaluating opensip-cli | [What is opensip-cli?](/docs/opensip-cli/00-start/01-what-is-opensip-cli/) -> [vs. other tools](/docs/opensip-cli/00-start/03-vs-other-tools/) -> [Public benchmarks](/docs/opensip-cli/70-reference/12-public-benchmarks/) -> [FAQ](/docs/opensip-cli/00-start/04-faq/) |
| Understanding the two products | [What is opensip-cli?](/docs/opensip-cli/00-start/01-what-is-opensip-cli/) -> [OpenSIP and OpenSIP CLI](/docs/opensip-cli/00-start/08-opensip-and-opensip-cli/) |
| New user | [Quick start](/docs/opensip-cli/00-start/00-quick-start/) -> [Initialize your first repo](/docs/opensip-cli/60-guides/00-initialize-your-first-repo/) -> [Write your first check](/docs/opensip-cli/60-guides/01-write-your-first-check/) |
| CI owner | [Output, gate, SARIF](/docs/opensip-cli/20-fit/04-output-gate-sarif/) -> [Wire into CI](/docs/opensip-cli/60-guides/03-wire-into-ci/) -> [Verifiable releases](/docs/opensip-cli/70-reference/13-verifiable-releases/) -> [Adopt in a monorepo](/docs/opensip-cli/60-guides/04-adopt-in-a-monorepo/) |
| Security adopter | [External tool adapters](/docs/opensip-cli/50-extend/08-external-tool-adapters/) -> [`tools` command](/docs/opensip-cli/70-reference/12-tools-command/) -> [Report](/docs/opensip-cli/70-reference/06-dashboard/) |
| Plugin author | [Plugin authoring](/docs/opensip-cli/50-extend/01-plugin-authoring/) -> [Publishable packs](/docs/opensip-cli/50-extend/03-publishable-packs/) -> [Full Tool plugins](/docs/opensip-cli/50-extend/06-full-tool-plugins/) -> [Command taxonomy](/docs/opensip-cli/50-extend/07-command-taxonomy/) -> [External tool adapters](/docs/opensip-cli/50-extend/08-external-tool-adapters/) |
| Graph adopter | [Use graph](/docs/opensip-cli/60-guides/06-use-graph/) -> [Stages and catalog](/docs/opensip-cli/40-graph/01-stages-and-catalog/) -> [Rules and gating](/docs/opensip-cli/40-graph/02-rules-and-gating/) -> [Impact analysis](/docs/opensip-cli/40-graph/05-impact-analysis/) |
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
25. [Impact analysis and trust](/docs/opensip-cli/40-graph/05-impact-analysis/)

### 50 - Extend

26. [Plugin authoring](/docs/opensip-cli/50-extend/01-plugin-authoring/)
27. [Project-local plugins](/docs/opensip-cli/50-extend/02-project-local-plugins/)
28. [Publishable packs](/docs/opensip-cli/50-extend/03-publishable-packs/)
29. [Check pack architecture](/docs/opensip-cli/50-extend/04-check-pack-architecture/)
30. [Language adapters](/docs/opensip-cli/50-extend/05-language-adapters/)
31. [Full Tool plugins](/docs/opensip-cli/50-extend/06-full-tool-plugins/)
32. [Command surface taxonomy](/docs/opensip-cli/50-extend/07-command-taxonomy/)
33. [External tool adapters](/docs/opensip-cli/50-extend/08-external-tool-adapters/)

### 55 - Yagni

34. [Command reference](/docs/opensip-cli/55-yagni/01-command-reference/)

### 60 - Guides

35. [Initialize your first repo](/docs/opensip-cli/60-guides/00-initialize-your-first-repo/)
36. [Write your first check](/docs/opensip-cli/60-guides/01-write-your-first-check/)
37. [Ban an API pattern](/docs/opensip-cli/60-guides/02-ban-an-api-pattern/)
38. [Wire into CI](/docs/opensip-cli/60-guides/03-wire-into-ci/)
39. [Adopt in a monorepo](/docs/opensip-cli/60-guides/04-adopt-in-a-monorepo/)
40. [Migrate from ESLint](/docs/opensip-cli/60-guides/05-migrate-from-eslint/)
41. [Use graph](/docs/opensip-cli/60-guides/06-use-graph/)
42. [Create your first Tool](/docs/opensip-cli/60-guides/07-create-your-first-tool/)
43. [Use OpenSIP with AI agents](/docs/opensip-cli/60-guides/use-opensip-with-ai-agents/)
44. [Connect MCP clients](/docs/opensip-cli/60-guides/08-connect-mcp-clients/)
45. [Send CLI findings to OpenSIP Cloud](/docs/opensip-cli/60-guides/cloud-handoff/)

### 70 - Reference

46. [CLI commands](/docs/opensip-cli/70-reference/01-cli-commands/)
47. [Package catalog](/docs/opensip-cli/70-reference/02-package-catalog/)
48. [Configuration](/docs/opensip-cli/70-reference/03-configuration/)
49. [JSON output schema](/docs/opensip-cli/70-reference/04-json-output-schema/)
50. [Checks reference](/docs/opensip-cli/70-reference/05-checks-index/)
51. [Report](/docs/opensip-cli/70-reference/06-dashboard/)
52. [Supply-chain security](/docs/opensip-cli/70-reference/08-supply-chain-security/)
53. [Environment variables](/docs/opensip-cli/70-reference/10-environment-variables/)
54. [Performance SLOs](/docs/opensip-cli/70-reference/11-performance-slos/)
55. [Public benchmarks](/docs/opensip-cli/70-reference/12-public-benchmarks/)
56. [`tools` command](/docs/opensip-cli/70-reference/12-tools-command/)
57. [Verifiable releases](/docs/opensip-cli/70-reference/13-verifiable-releases/)
58. [Detection quality](/docs/opensip-cli/70-reference/14-detection-quality/)
59. [Compatibility policy](/docs/opensip-cli/70-reference/15-compatibility-policy/)

### 80 - Internals

60. [CLI dispatch](/docs/opensip-cli/80-implementation/01-cli-dispatch/)
61. [Plugin loader](/docs/opensip-cli/80-implementation/02-plugin-loader/)
62. [Session and persistence](/docs/opensip-cli/80-implementation/03-session-and-persistence/)
63. [Coding standards](/docs/opensip-cli/80-implementation/04-coding-standards/)
64. [Layer policy](/docs/opensip-cli/80-implementation/05-layer-policy/)
65. [Doc conventions](/docs/opensip-cli/80-implementation/06-doc-conventions/)
66. [Website integration](/docs/opensip-cli/80-implementation/07-website-integration/)
67. [Tool live view](/docs/opensip-cli/80-implementation/08-tool-live-view/)
68. [Architecture map](/docs/opensip-cli/80-implementation/architecture-map/)

## Factual Baseline

This v0.5.0 doc set was rechecked against the source on 2026-07-07:

- 160 built-in fitness checks across seven packs.
- 55 publishable workspace packages, plus the private `@opensip-cli/test-support` package.
- Four bundled first-party tools: `fit`, `graph`, `sim`, and `yagni`.
- Six fitness language adapters: TypeScript/JavaScript, Python, Rust, Go, Java, and C/C++.
- Five graph language adapters: TypeScript, Python, Rust, Go, and Java.
- First-party Tool commands are mounted through `CommandSpec`; installed Tool
  plugins and external scanner adapters use the same contract.

The docs in `70-reference/` are lookup-shaped. The docs in `80-implementation/` are contributor-facing internals. Start with the guides unless you are reviewing a PR or writing platform code.
