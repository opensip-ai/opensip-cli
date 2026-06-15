# OpenSIP CLI

Codebase intelligence from your terminal.

OpenSIP CLI helps engineering teams understand code health, architecture risk,
and change impact before problems reach production. Run polyglot fitness
checks, map dependency blast radius, gate regressions in CI, and generate
local reports without sending your code to a SaaS by default.

[![npm](https://img.shields.io/npm/v/opensip-cli)](https://www.npmjs.com/package/opensip-cli)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-opensip.ai-2563eb)](https://opensip.ai/docs/opensip-cli/)
[![OpenSIP](https://img.shields.io/badge/part%20of-OpenSIP-7c3aed)](https://opensip.ai)

OpenSIP is built for teams that need to move quickly inside large or changing
codebases. It gives platform teams, staff engineers, architecture owners, and
product teams a shared way to see what is healthy, what is risky, and what
should not get worse.

- **Measure code health across languages** with 150+ included checks for
  TypeScript, Python, Go, Java, Rust, and C/C++.
- **See change impact before you merge** with static call graphs,
  blast-radius analysis, cycles, duplicated bodies, oversized functions, and
  architecture rules.
- **Turn tech debt into a managed baseline** by saving today's findings and
  failing CI only when new regressions appear.
- **Test operational behavior as code** with load, chaos, and adversarial
  simulation scenarios.
- **Stay local by default** with self-contained HTML reports and optional
  OpenSIP Cloud sync coming soon for teams that want history, visibility, and
  customer-facing workflows.

The npm package is `opensip-cli`; the installed command is `opensip`.

## Quick Start

Install the CLI:

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
```

Or install from npm:

```bash
npm install -g opensip-cli
```

Run OpenSIP in your project:

```bash
cd your-project
opensip init
opensip fit
opensip graph
opensip report
```

Want a smoke test before pointing it at real checks?

```bash
opensip fit --recipe example
opensip sim --recipe example
```

After the example runs pass, edit or remove the scaffolded files under
`opensip-cli/{fit,sim}/` and run the checks that matter for your codebase.

## What You Can Do

### Fitness Checks

Run first-party and custom checks across multiple languages from one CLI. Use
fitness checks to find risky patterns, enforce team standards, and catch
architectural drift before it spreads.

```bash
opensip fit
opensip fit --list
opensip fit --check <slug>
opensip fit --tags <tags>
```

### CI Ratchets

Baseline the findings you already have, then fail pull requests only when they
introduce net-new violations.

```bash
opensip fit --gate-save
opensip fit --gate-compare
```

### Code Graph

Build a static graph of your codebase so reviewers can answer the question
every risky change raises: "what breaks if this changes?"

```bash
opensip graph
opensip graph --json
opensip graph --sarif graph.sarif
```

### Simulation

Define simulation scenarios as code with personas, invariants, and assertions.
Use them to explore load, chaos, and adversarial behavior with repeatable
recipes.

```bash
opensip sim
opensip sim --recipes
opensip sim --recipe <name>
```

### Reports

Generate a self-contained HTML report that can be opened locally, shared as a
build artifact, or used as a lightweight review companion.

```bash
opensip report
```

### Extensible Tools

OpenSIP ships with `fit`, `graph`, and `sim`, but the CLI is a pluggable tool
platform. Add project-local checks, npm-packaged recipes, custom graph rules,
or entire tools that mount as first-class `opensip` subcommands. Use
`opensip plugin ...` for fit/sim packs and `opensip tools ...` for whole Tool
plugins.

## How It Works

```text
init -> analyze -> baseline -> gate -> report
```

1. `opensip init` detects your project and writes a local OpenSIP layout.
2. `opensip fit`, `opensip graph`, and `opensip sim` run local analysis.
3. Gate commands compare against saved baselines so existing debt does not
   block every pull request.
4. `opensip report` creates local HTML output for review and sharing.
5. OpenSIP Cloud sync is coming soon for teams that want centralized
   visibility.

## Commands

### Fitness

```bash
opensip fit                   # run the default fitness recipe
opensip fit --list            # list available checks
opensip fit --recipes         # list available recipes
opensip fit --check <slug>    # run one check
opensip fit --tags <tags>     # filter by tag
opensip fit --verbose         # show detailed findings
opensip fit --json            # emit machine-readable output
opensip fit --gate-save       # save the current baseline
opensip fit --gate-compare    # fail on regressions against the baseline
```

### Graph

```bash
opensip graph                 # build the call graph and run graph rules
opensip graph --json          # emit machine-readable output
opensip graph --sarif graph.sarif
opensip graph --gate-save
opensip graph --gate-compare
```

### Simulation

```bash
opensip sim                   # run the default simulation recipe
opensip sim --recipes         # list simulation recipes
opensip sim --recipe <name>   # run one recipe
opensip sim --json
```

### Project and Reports

```bash
opensip init
opensip report
opensip sessions list
opensip sessions show latest --tool fit
opensip configure  # stores an API key for future/private Cloud-compatible endpoints
```

### Plugins

```bash
opensip plugin list
opensip plugin add <package>
opensip plugin remove <package>
opensip plugin sync
```

### Tools

```bash
opensip tools list
opensip tools validate <spec>
opensip tools install <spec> [--global|--project]
opensip tools uninstall <name-or-id> [--global|--project]
```

## Project Layout

`opensip init` writes a small project-local layout:

```text
your-project/
  opensip-cli.config.yml
  opensip-cli/
    fit/
      checks/
      recipes/
    sim/
      scenarios/
      recipes/
    tools/           # optional authored Tool sidecars
    .runtime/        # generated state, gitignored
```

User-authored checks, recipes, scenarios, and authored Tool sidecars live
under `opensip-cli/`; loose `.js`/`.mjs` files can be nested under the reserved
`fit/{checks,recipes}` and `sim/{scenarios,recipes}` directories. Generated
runtime data and project-installed plugins live under `opensip-cli/.runtime/`.

## CI Integration

OpenSIP can be used as a ratchet in CI: save a baseline once, then compare new
runs against it on pull requests.

```bash
opensip fit --gate-save
opensip graph --gate-save

opensip fit --gate-compare
opensip graph --gate-compare
```

Use JSON or SARIF output when you want to feed findings into other systems:

```bash
opensip fit --json
opensip graph --sarif graph.sarif
```

## OpenSIP Cloud

OpenSIP CLI runs fully local by default. OpenSIP Cloud is coming soon; it is
not publicly available yet. The CLI already includes the API-key and signal
delivery plumbing so early/private integrations can target a compatible
endpoint, but local use does not require a Cloud account.

```bash
opensip configure
opensip fit --report-to https://your-opensip-instance/api/ingest
```

API key resolution order:

1. `--api-key`
2. `cli.apiKey` in `opensip-cli.config.yml`
3. `OPENSIP_API_KEY`
4. `~/.opensip-cli/config.yml`

Use `--no-cloud` when you want to disable any configured signal delivery for a
single run.

## Extensibility

OpenSIP CLI is built to be extended.

- Keep custom checks and scenarios private in your own repo.
- Package reusable checks, recipes, scenarios, or graph adapters as npm
  plugins.
- Build a full tool when `fit`, `graph`, or `sim` is not the right shape.
- Manage whole Tool plugins with `opensip tools list`, `opensip tools validate`,
  and `opensip tools install`.
- Share tools and packs with the OpenSIP community when they are useful beyond
  one codebase.

Project-authored Tool sidecars under `opensip-cli/tools/` are deny-by-default
because they run code from the repo. Allowlist them explicitly:

```bash
OPENSIP_CLI_ALLOW_PROJECT_TOOLS=my-tool opensip my-tool
```

npm-installed Tool plugins live under `~/.opensip-cli/plugins/tool/` by default,
or under `opensip-cli/.runtime/plugins/tool/` with `--project`. Authored
sidecar tools under `~/.opensip-cli/tools/` are trusted by default.

## Development

```bash
git clone https://github.com/opensip-ai/opensip-cli.git
cd opensip-cli
pnpm install
pnpm build
pnpm test
node packages/cli/dist/index.js --help
```

Useful local checks:

```bash
pnpm typecheck
pnpm test
pnpm docs:check
pnpm fit --no-cloud
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
