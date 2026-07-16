---
status: current
last_verified: 2026-07-14
release: v0.7.0
owner: opensip-cli
indexable: true
title: "opensip-cli Docs"
audience: [getting-started, contributors, plugin-authors, ci-integrators]
purpose: "Public documentation entry point for opensip-cli v0.7.0: product overview, fast paths, and the full reference map."
---
# opensip-cli Docs

OpenSIP CLI is a local-first engineering quality platform for codebases that need more than a linter. It gives you one CLI for fitness checks, simulation scenarios, static call-graph analysis, baselines, SARIF, dashboards, and your own Tool plugins.

It runs in your repo and in CI. It works offline. It is designed for teams that want their quality bar to be explicit, versioned, and enforceable.

## What You Can Do

| Need | Use |
|---|---|
| Enforce project-specific quality, security, and architecture rules | `opensip fit` with 160 built-in checks across seven packs, plus your own checks |
| Adopt without fixing every historical issue first | `fit --gate-save` once, then `fit --gate-compare` in CI |
| Run a multi-tool review in one command | `opensip audit` for changed-scope fit, graph impact, and review-brief evidence |
| Understand reachability, dead ends, duplication, cycles, and blast radius | `opensip graph` with five graph adapters and eleven built-in graph rules |
| Review evidence-backed code-reduction opportunities (advisory) | `opensip yagni` with bundled detectors and optional graph evidence |
| Run load or chaos scenarios against a service you control | `opensip sim` |
| Bring existing scanners into the same report and gate | Opt in to one of 16 adapters, including Gitleaks, Semgrep, Ruff, golangci-lint, cargo-deny, Bandit, PMD, Cppcheck, OSV-Scanner, and Trivy |
| Share internal rules across repos | Publish or install fit packs and sim scenario packs |
| Add an entire command to the CLI | Build a Tool plugin and manage it with `opensip tools ...` |
| Give coding agents deterministic repo evidence | `opensip agent-catalog --json`, `opensip mcp` (`impact_files`, `select_tests`, `get_file_context`, `get_context_status`), `suite run agent-context`, filtered JSON, sessions, and graph impact |
| Show results to humans and CI systems | Open the local HTML report (including Change Impact for audit runs) or export SARIF for code scanning |

## Start Here

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
cd your-project
opensip audit
opensip init
opensip fit --recipe example
opensip report
```

That gets you from a clean shell to a changed-scope audit, a working project
scaffold, one passing fitness run, and the local HTML report. From there:

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
| Verify release artifacts | [Verifiable releases](./70-reference/13-verifiable-releases.md) |
| Inspect detection-quality methodology | [Detection quality](./70-reference/14-detection-quality.md) |
| Audit contract/version compatibility | [Compatibility policy](./70-reference/15-compatibility-policy.md) |
| Check whether a host is qualified | [Supported platforms](./70-reference/17-supported-platforms.md) |
| Profile or compare performance work | [Performance profiling](./70-reference/16-performance-profiling.md) |
| Connect Cursor, Claude Code, or Codex via MCP | [Connect MCP clients](./60-guides/08-connect-mcp-clients.md) |
| Run agent Discover / Edit / Final loops | [Use OpenSIP with AI agents](./60-guides/use-opensip-with-ai-agents.md) |
| Understand Change Impact and the offline HTML report | [Report](./70-reference/06-dashboard.md) |

## Command Map

The most common commands:

```bash
opensip init
opensip audit
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

`opensip audit` is the stable, host-owned shortcut for the curated built-in
review. Add `--open` for the human Change Impact report or `--json` for CI and
agents. Use `opensip suite run <name>` for configured multi-tool workflows. The
suite name `audit` is reserved for the built-in review (ADR-0159): a configured
`suites.audit` fails config validation, so both spellings always run the same
curated definition — pick another name (for example `audit-custom`) for a
custom workflow.

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

For every command, flag, exit code, and machine-output contract, use the [CLI command reference](./70-reference/01-cli-commands.md). For Tool plugin management specifically, use the [`tools` command reference](./70-reference/12-tools-command.md).

## Recommended Paths

| Role | Path |
|---|---|
| Evaluating opensip-cli | [What is opensip-cli?](./00-start/01-what-is-opensip-cli.md) -> [vs. other tools](./00-start/03-vs-other-tools.md) -> [Public benchmarks](./70-reference/12-public-benchmarks.md) -> [FAQ](./00-start/04-faq.md) |
| Understanding the two products | [What is opensip-cli?](./00-start/01-what-is-opensip-cli.md) -> [OpenSIP and OpenSIP CLI](./00-start/08-opensip-and-opensip-cli.md) |
| New user | [Quick start](./00-start/00-quick-start.md) -> [Initialize your first repo](./60-guides/00-initialize-your-first-repo.md) -> [Write your first check](./60-guides/01-write-your-first-check.md) |
| CI owner | [Output, gate, SARIF](./20-fit/04-output-gate-sarif.md) -> [Wire into CI](./60-guides/03-wire-into-ci.md) -> [Verifiable releases](./70-reference/13-verifiable-releases.md) -> [Adopt in a monorepo](./60-guides/04-adopt-in-a-monorepo.md) |
| Security adopter | [External tool adapters](./50-extend/08-external-tool-adapters.md) -> [`tools` command](./70-reference/12-tools-command.md) -> [Report](./70-reference/06-dashboard.md) |
| Plugin author | [Plugin authoring](./50-extend/01-plugin-authoring.md) -> [Publishable packs](./50-extend/03-publishable-packs.md) -> [Full Tool plugins](./50-extend/06-full-tool-plugins.md) -> [Command taxonomy](./50-extend/07-command-taxonomy.md) -> [External tool adapters](./50-extend/08-external-tool-adapters.md) |
| Graph adopter | [Use graph](./60-guides/06-use-graph.md) -> [Stages and catalog](./40-graph/01-stages-and-catalog.md) -> [Rules and gating](./40-graph/02-rules-and-gating.md) -> [Impact analysis](./40-graph/05-impact-analysis.md) |
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
25. [Impact analysis and trust](./40-graph/05-impact-analysis.md)

### 50 - Extend

26. [Plugin authoring](./50-extend/01-plugin-authoring.md)
27. [Project-local plugins](./50-extend/02-project-local-plugins.md)
28. [Publishable packs](./50-extend/03-publishable-packs.md)
29. [Check pack architecture](./50-extend/04-check-pack-architecture.md)
30. [Language adapters](./50-extend/05-language-adapters.md)
31. [Full Tool plugins](./50-extend/06-full-tool-plugins.md)
32. [Command surface taxonomy](./50-extend/07-command-taxonomy.md)
33. [External tool adapters](./50-extend/08-external-tool-adapters.md)

### 55 - Yagni

34. [Command reference](./55-yagni/01-command-reference.md)

### 60 - Guides

35. [Initialize your first repo](./60-guides/00-initialize-your-first-repo.md)
36. [Write your first check](./60-guides/01-write-your-first-check.md)
37. [Ban an API pattern](./60-guides/02-ban-an-api-pattern.md)
38. [Wire into CI](./60-guides/03-wire-into-ci.md)
39. [Adopt in a monorepo](./60-guides/04-adopt-in-a-monorepo.md)
40. [Migrate from ESLint](./60-guides/05-migrate-from-eslint.md)
41. [Use graph](./60-guides/06-use-graph.md)
42. [Create your first Tool](./60-guides/07-create-your-first-tool.md)
43. [Use OpenSIP with AI agents](./60-guides/use-opensip-with-ai-agents.md)
44. [Connect MCP clients](./60-guides/08-connect-mcp-clients.md)
45. [Send CLI findings to OpenSIP Cloud](./60-guides/cloud-handoff.md)

### 70 - Reference

46. [CLI commands](./70-reference/01-cli-commands.md)
47. [Package catalog](./70-reference/02-package-catalog.md)
48. [Configuration](./70-reference/03-configuration.md)
49. [JSON output schema](./70-reference/04-json-output-schema.md)
50. [Checks reference](./70-reference/05-checks-index.md)
51. [Report](./70-reference/06-dashboard.md)
52. [Supply-chain security](./70-reference/08-supply-chain-security.md)
53. [Environment variables](./70-reference/10-environment-variables.md)
54. [Performance SLOs](./70-reference/11-performance-slos.md)
55. [Public benchmarks](./70-reference/12-public-benchmarks.md)
56. [`tools` command](./70-reference/12-tools-command.md)
57. [Verifiable releases](./70-reference/13-verifiable-releases.md)
58. [Detection quality](./70-reference/14-detection-quality.md)
59. [Compatibility policy](./70-reference/15-compatibility-policy.md)
60. [Performance profiling](./70-reference/16-performance-profiling.md)
61. [Supported platforms](./70-reference/17-supported-platforms.md)

### 80 - Internals

60. [CLI dispatch](./80-implementation/01-cli-dispatch.md)
61. [Plugin loader](./80-implementation/02-plugin-loader.md)
62. [Session and persistence](./80-implementation/03-session-and-persistence.md)
63. [Coding standards](./80-implementation/04-coding-standards.md)
64. [Layer policy](./80-implementation/05-layer-policy.md)
65. [Doc conventions](./80-implementation/06-doc-conventions.md)
66. [Website integration](./80-implementation/07-website-integration.md)
67. [Tool live view](./80-implementation/08-tool-live-view.md)
68. [Architecture map](./80-implementation/architecture-map.md)

## Factual Baseline

This v0.7.0 doc set was rechecked against the source on 2026-07-11:

- 160 built-in fitness checks across seven packs.
- 57 publishable workspace packages, plus the three private workspace packages
  `@opensip-cli/agent-eval`, `@opensip-cli/test-support`, and
  `@opensip-cli/checks-dogfood`; the generated
  `80-implementation/architecture-map.md` is the authoritative current inventory.
- Five bundled first-party tools (declared in
  `packages/cli/src/bootstrap/bundled-tools.manifest.json`): `fit`, `graph`,
  `sim`, `yagni`, and `mcp`. The four analysis tools render live views; `mcp` is a
  raw stdio server.
- Six fitness language adapters: TypeScript/JavaScript, Python, Rust, Go, Java, and C/C++.
- Five graph language adapters: TypeScript, Python, Rust, Go, and Java.
- First-party Tool commands are mounted through `CommandSpec`; installed Tool
  plugins and external scanner adapters use the same contract.

The docs in `70-reference/` are lookup-shaped. The docs in `80-implementation/` are contributor-facing internals. Start with the guides unless you are reviewing a PR or writing platform code.
