---
status: current
last_verified: 2026-05-15
title: "Quick start"
audience: [contributors, plugin-authors, ci-integrators, evaluators]
purpose: "Four commands from zero to a passing fitness run. Hands-on before the conceptual material."
source-files:
  - README.md
  - packages/cli/src/index.ts
  - packages/cli/src/commands/init.ts
related-docs:
  - ./01-what-is-opensip-tools.md
  - ./02-vocabulary.md
  - ../60-surfaces/01-cli-command-tree.md
---
# Quick start

Four commands from a clean shell to a passing fitness run. The point of this page is to give you something working in your terminal *before* you read the conceptual material — every other doc in this set is sharper once you've seen the output once.

> **What you'll have after this page:**
> - The `opensip-tools` CLI installed.
> - An `opensip-tools.config.yml` and an `opensip-tools/` directory in a project of your choice.
> - One passing `fit` run and one passing `sim` run.
> - Enough mechanical context that [`./01-what-is-opensip-tools.md`](/docs/opensip-tools/00-orientation/01-what-is-opensip-tools/) lands as *"oh, that's why"* instead of *"wait, what's a recipe?"*

---

## Works with

opensip-tools auto-detects your project's language(s) from filesystem markers and runs the matching checks. Polyglot projects get every relevant pack.

| Language | Detection marker | Language-specific checks | Universal checks |
|---|---|---|---|
| **TypeScript** / JS / TSX | `package.json`, `tsconfig.json` | 66 (TS-AST-driven) | ✓ |
| **Python** | `pyproject.toml` | yes | ✓ |
| **Java** | `pom.xml`, `build.gradle` | yes | ✓ |
| **Go** | `go.mod` | yes | ✓ |
| **C / C++** | `CMakeLists.txt` | yes (via clang-tidy) | ✓ |
| **Rust** | `Cargo.toml` | — | ✓ |

All six get the **92 universal checks** (Docker, `.env`, Sentry, generic structure, dead-code, package conventions). TypeScript additionally gets the deepest treatment — 66 AST-driven checks for typed-inject, drizzle-orm, React patterns, package.json exports, tsconfig posture.

For the full per-language breakdown, see [`../70-reference/01-package-catalog.md`](/docs/opensip-tools/70-reference/01-package-catalog/).

---

## Prerequisites

- **Node.js 22+** — `node --version` should print `v22.x` or higher.
- A project directory you don't mind a scaffold landing in.
- *(Optional)* `pnpm` if you're installing from source. `npm` is fine for global install.

If you don't have a project handy, `git clone https://github.com/opensip-ai/opensip-tools.git` and run these commands inside the clone — opensip-tools fits checks against its own codebase as the smoke test.

---

## The four commands

```bash
# 1. Install the CLI globally
npm install -g @opensip-tools/cli

# 2. Enter your project
cd your-project

# 3. Scaffold config + example check/scenario (language auto-detected)
opensip-tools init

# 4. Run the smoke test — both should exit 0
opensip-tools fit --recipe example
opensip-tools sim --recipe example
```

If `fit --recipe example` exits 0, the platform is wired correctly end-to-end: language detection picked the right adapter, the plugin loader found the example check, the recipe service matched it, the engine executed it, and the renderer drew the result. Every later doc is depth on one of those steps.

---

## What `init` just wrote

```
your-project/
├── opensip-tools.config.yml                ← project config
└── opensip-tools/
    ├── fit/
    │   ├── checks/example-check.mjs        ← demo check (scope matches your language)
    │   └── recipes/example-recipe.mjs      ← runs the demo check
    └── sim/
        ├── scenarios/example-scenario.mjs  ← demo scenario
        └── recipes/example-recipe.mjs      ← runs the demo scenario
```

`opensip-tools.config.yml` is the only file the CLI *requires*. Everything under `opensip-tools/` is plugin source — auto-discovered at runtime, no opt-in needed. `opensip-tools init` also appends `opensip-tools/.runtime/` to your `.gitignore` so the tool's own state files don't pollute commits.

For a polyglot project (e.g. Rust + TypeScript), `init` writes one example check per detected language. To force a specific configuration: `opensip-tools init --language rust,typescript`.

---

## Variations

```bash
# No global install — one-off via npx
npx @opensip-tools/cli fit

# Install from source (for contributors)
git clone https://github.com/opensip-ai/opensip-tools.git
cd opensip-tools && pnpm install && pnpm build
node packages/cli/dist/index.js fit

# Run the default recipe (every enabled check, not just the example)
opensip-tools fit

# See what checks are available
opensip-tools fit --list

# Get a per-violation breakdown instead of the summary line
opensip-tools fit --findings

# Emit structured JSON for CI
opensip-tools fit --json

# Run the static call-graph tool (different question shape: "what is reachable from where?")
opensip-tools graph
```

The full command tree is at [`../60-surfaces/01-cli-command-tree.md`](/docs/opensip-tools/60-surfaces/01-cli-command-tree/).

---

## If something didn't work

| Symptom | Likely cause | Fix |
|---|---|---|
| Behavior doesn't match what these docs describe | Older CLI version than the docs you're reading | Check installed version: `opensip-tools --version` (or `-V`). Latest is on [npm](https://www.npmjs.com/package/@opensip-tools/cli). Update with `npm install -g @opensip-tools/cli@latest`. |
| `command not found: opensip-tools` | Global install isn't on `$PATH` | `npm config get prefix` — make sure that path's `bin/` is on `$PATH`, or use `npx @opensip-tools/cli` instead |
| `init` says it detected no language | No supported language marker found (no `package.json`, `Cargo.toml`, etc.) | Pass `--language <name>` explicitly: `opensip-tools init --language typescript` |
| `fit --recipe example` says "0 checks ran" | Targets in `opensip-tools.config.yml` don't match any files | Open the config; widen `targets.<your-language>-source.include` to cover where your code actually lives |
| Errors from `Node.js engine` | Node version is below 22 | Upgrade Node — opensip-tools uses ES2022 + Node16 module resolution |

---

## What's next

You've seen the loop run. The orientation track is three more docs:

1. **[`./01-what-is-opensip-tools.md`](/docs/opensip-tools/00-orientation/01-what-is-opensip-tools/)** — The product, the problem, the philosophy. What you just ran, conceptually.
2. **[`./02-vocabulary.md`](/docs/opensip-tools/00-orientation/02-vocabulary/)** — The terms used everywhere: *Tool, recipe, check, scenario, signaler, target, language adapter, plugin, session.*
3. **[`./03-system-context.md`](/docs/opensip-tools/00-orientation/03-system-context/)** — Where the binary sits between you, the codebase, CI, and OpenSIP Cloud.

After orientation, the mental-model section ([`../10-mental-model/`](/docs/opensip-tools/10-mental-model/)) takes you deep — starting with [`01-fitness-loop.md`](/docs/opensip-tools/10-mental-model/01-fitness-loop/), which threads one check end-to-end through the system you just ran.

Once you've internalized the fitness loop, the tool-specific sections — [`../20-the-fit-loop/`](/docs/opensip-tools/20-the-fit-loop/), [`../30-the-sim-loop/`](/docs/opensip-tools/30-the-sim-loop/), and [`../35-the-graph-loop/`](/docs/opensip-tools/35-the-graph-loop/) — go deep on each first-party tool's pipeline, primitives, and gating model.
