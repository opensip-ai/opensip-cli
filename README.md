# OpenSIP CLI

[![npm](https://img.shields.io/npm/v/opensip-cli)](https://www.npmjs.com/package/opensip-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-opensip.ai-2563eb)](https://opensip.ai/docs/opensip-cli/)
[![OpenSIP](https://img.shields.io/badge/part%20of-OpenSIP-7c3aed)](https://opensip.ai)

OpenSIP CLI is the command-line interface for measuring, mapping, and gating
codebase health. The npm package is `opensip-cli`; the installed command is
`opensip`.

It ships as a pluggable tool platform with three first-party tools:

- `fit`: polyglot fitness checks and CI ratchets.
- `graph`: static call graph, blast-radius analysis, and architecture rules.
- `sim`: simulation scenarios for load, chaos, and adversarial behavior.

## Install

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
```

Or install from npm:

```bash
npm install -g opensip-cli
opensip --help
```

## Quick Start

```bash
cd your-project
opensip init
opensip fit --recipe example
opensip sim --recipe example
```

After the example runs pass, edit or remove the scaffolded files under
`opensip-cli/{fit,sim}/` and run the real checks:

```bash
opensip fit
opensip graph
opensip report
```

## Launch Features

- **Fitness checks**: roughly 165 included checks across TypeScript, Python,
  Go, Java, Rust, and C/C++ from one CLI.
- **CI ratchet**: baseline existing findings and surface only net-new
  violations on pull requests.
- **Code graph**: answer "what breaks if I touch this?" before you make the
  change, including oversized functions, cycles, high-blast-radius code, and
  duplicated bodies.
- **HTML reports**: generate a self-contained report with no server or SaaS
  login required.
- **Simulation**: define load, chaos, and adversarial scenarios as code with
  personas, invariants, and assertions.
- **Extensible tools**: write custom checks, recipes, scenarios, graph rules,
  or full tools that mount as first-class `opensip` subcommands.
- **OpenSIP Cloud sync**: optionally send run signals to OpenSIP Cloud for
  team visibility, history, and customer-facing workflows.

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

### Project And Reports

```bash
opensip init
opensip report
opensip sessions list
opensip sessions show latest --tool fit
opensip configure
```

### Plugins

```bash
opensip plugin list
opensip plugin add <package>
opensip plugin remove <package>
opensip plugin sync
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
    .runtime/        # generated state, gitignored
```

User-authored checks, recipes, scenarios, and tools live under
`opensip-cli/`. Generated runtime data lives under `opensip-cli/.runtime/`.

## Extensibility

OpenSIP CLI is built to be extended.

- Keep custom checks and scenarios private in your own repo.
- Package reusable checks, recipes, scenarios, or graph adapters as npm
  plugins.
- Build a full tool when `fit`, `graph`, or `sim` is not the right shape.
- Share tools and packs with the OpenSIP community when they are useful beyond
  one codebase.

Project-local tools are deny-by-default because they run code from the repo.
Allowlist them explicitly:

```bash
OPENSIP_CLI_ALLOW_PROJECT_TOOLS=my-tool opensip my-tool
```

Global tools under `~/.opensip-cli/tools/` are trusted by default.

## OpenSIP Cloud

OpenSIP CLI can run fully local, and it can also send run signals to OpenSIP
Cloud.

```bash
opensip configure
opensip fit --report-to https://your-opensip-instance/api/ingest
```

API key resolution order:

1. `--api-key`
2. `cli.apiKey` in `opensip-cli.config.yml`
3. `OPENSIP_API_KEY`
4. `~/.opensip-cli/config.yml`

Use `--no-cloud` when you want a fully local run.

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

MIT. See [LICENSE](LICENSE).
