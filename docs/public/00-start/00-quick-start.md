---
status: current
last_verified: 2026-06-14
release: v0.1.0
title: "Quick start"
audience: [getting-started, contributors, plugin-authors, ci-integrators]
purpose: "From zero to a passing fitness run. Hands-on before the conceptual material."
source-files:
  - README.md
  - packages/cli/src/index.ts
  - packages/cli/src/commands/init.ts
related-docs:
  - ./01-what-is-opensip-cli.md
  - ./05-vocabulary.md
  - ../70-reference/01-cli-commands.md
  - ../70-reference/08-supply-chain-security.md
---
# Quick start

From a clean shell to a passing fitness run. The point of this page is to give you something working in your terminal *before* you read the conceptual material — every other doc in this set is sharper once you've seen the output once.

> **What you'll have after this page:**
> - The `opensip-cli` CLI installed.
> - An `opensip-cli.config.yml` and an `opensip-cli/` directory in a project of your choice.
> - One passing `fit` run, plus an optional `sim` smoke test.
> - Enough mechanical context that [`./01-what-is-opensip-cli.md`](./01-what-is-opensip-cli.md) lands as *"oh, that's why"* instead of *"wait, what's a recipe?"*

---

## Works with

opensip-cli auto-detects your project's language(s) from filesystem markers and runs the matching checks. Polyglot projects get every relevant pack.

| Language | Detection marker | Language-specific checks | Universal checks |
|---|---|---|---|
| **TypeScript** / JS / TSX | `tsconfig.json` (or `package.json` alone) | 51 | ✓ |
| **Python** | `pyproject.toml`, `setup.py` | 2 | ✓ |
| **Java** | `pom.xml`, `build.gradle` | 1 | ✓ |
| **Go** | `go.mod` | 1 | ✓ |
| **C / C++** | `CMakeLists.txt` | 1 (clang-tidy backed) | ✓ |
| **Rust** | `Cargo.toml` | 1 | ✓ |

Every detected language gets the **94 universal checks** (Docker, `.env`, Sentry, generic structure, dead-code, package conventions). TypeScript additionally gets the deepest treatment through 51 TypeScript-specific checks for typed-inject, drizzle-orm, React patterns, package.json exports, and tsconfig posture.

For the full per-language breakdown, see [`../70-reference/02-package-catalog.md`](../70-reference/02-package-catalog.md).

---

## Prerequisites

- **Node.js 24+** — `node --version` should print `v24.x` or higher.
- A project directory you don't mind a scaffold landing in.
- *(Optional)* `pnpm` if you're building from source. The curl installer handles global CLI setup.

If you don't have a project handy, `git clone https://github.com/opensip-ai/opensip-cli.git` and run these commands inside the clone — OpenSIP CLI runs checks against its own codebase as the smoke test.

---

## The first run

```bash
# 1. Install the CLI globally
curl -fsSL https://opensip.ai/cli/install.sh | bash

# 2. Enter your project
cd your-project

# 3. Scaffold config + example check/scenario (language auto-detected)
opensip init

# 4. Run the fitness smoke test
opensip fit --recipe example

# 5. Optional: run the scaffolded simulation smoke test
opensip sim --recipe example
```

If `fit --recipe example` exits 0, the platform is wired correctly end-to-end: language detection picked the right adapter, the plugin loader found the example check, the recipe service matched it, the engine executed it, and the renderer drew the result. Every later doc is depth on one of those steps.

opensip-cli publishes through npm trusted publishing/provenance and rejects
OpenSIP package-level install hooks before release. For the remaining
npm-install risk model, see [supply-chain security](../70-reference/08-supply-chain-security.md).

---

## What `init` just wrote

```
your-project/
├── opensip-cli.config.yml                ← project config
└── opensip-cli/
    ├── fit/
    │   ├── checks/example-check.mjs        ← demo check (scope matches your language)
    │   └── recipes/example-recipe.mjs      ← runs the demo check
    └── sim/
        ├── scenarios/example-scenario.mjs  ← demo scenario
        └── recipes/example-recipe.mjs      ← runs the demo scenario
```

`opensip-cli.config.yml` is the only file the CLI *requires*. Everything under `opensip-cli/` is plugin source — auto-discovered at runtime, no opt-in needed. `opensip init` also appends `opensip-cli/.runtime/` to your `.gitignore` so the tool's own state files don't pollute commits.

For a polyglot project (e.g. Rust + TypeScript), `init` writes one example check per detected language. To force a specific configuration: `opensip init --language rust,typescript`.

---

## Variations

```bash
# Install from source (for contributors)
git clone https://github.com/opensip-ai/opensip-cli.git
cd opensip-cli && pnpm i && pnpm build
node packages/cli/dist/index.js fit

# Run the default recipe (every enabled check, not just the example)
opensip fit

# See what checks are available
opensip fit --list

# See what graph would analyze without building a catalog
opensip graph --list-files

# Get a per-violation breakdown instead of the summary line
opensip fit --verbose

# Emit structured JSON for CI
opensip fit --json

# Run the static call-graph tool (different question shape: "what is reachable from where?")
opensip graph
```

The full command tree is at [`../70-reference/01-cli-commands.md`](../70-reference/01-cli-commands.md).

---

## If something didn't work

| Symptom | Likely cause | Fix |
|---|---|---|
| Behavior doesn't match what these docs describe | Older CLI version than the docs you're reading | Check installed version: `opensip --version` (or `-V`). Latest is on [npm](https://www.npmjs.com/package/opensip-cli). Update with `curl -fsSL https://opensip.ai/cli/install.sh \| bash`. |
| `command not found: opensip-cli` | The shell has not picked up the global command yet | Open a new shell and try again; if it still fails, rerun `curl -fsSL https://opensip.ai/cli/install.sh \| bash` |
| `init` says it detected no language | No supported language marker found (no `package.json`, `Cargo.toml`, etc.) | Pass `--language <name>` explicitly: `opensip init --language typescript` |
| `fit --recipe example` says "0 checks ran" | Targets in `opensip-cli.config.yml` don't match any files | Open the config; widen `targets.<your-language>-source.include` to cover where your code actually lives |
| Errors from `Node.js engine` | Node version is below 24 | Upgrade Node — opensip-cli uses ES2022 + Node16 module resolution |

---

## What's next

You've seen the loop run. The rest of this section deepens what you just saw:

1. **[`./02-show-me-the-loops.md`](./02-show-me-the-loops.md)** — One code sample per tool: a fit check, a sim scenario, a graph rule. See what authoring looks like, now that you know the platform works.
2. **[`./01-what-is-opensip-cli.md`](./01-what-is-opensip-cli.md)** — The product, the problem, the philosophy. What you just ran, conceptually.
3. **[`../60-guides/00-initialize-your-first-repo.md`](../60-guides/00-initialize-your-first-repo.md)** — The careful repo-adoption version of this page.
4. **[`./05-vocabulary.md`](./05-vocabulary.md)** — The terms used everywhere: *Tool, recipe, check, scenario, signaler, target, language adapter, plugin, session.*
5. **[`./06-system-context.md`](./06-system-context.md)** — Where the binary sits between you, the codebase, CI, and OpenSIP Cloud.

After this section, the mental-model section ([`../10-concepts/`](../10-concepts/)) takes you deep — starting with [`01-fitness-loop.md`](../10-concepts/01-fitness-loop.md), which threads one check end-to-end through the system you just ran.

Once you've internalized the fitness loop, the tool-specific sections — [`../20-fit/`](../20-fit/), [`../30-sim/`](../30-sim/), and [`../40-graph/`](../40-graph/) — go deep on each first-party tool's pipeline, primitives, and gating model.
