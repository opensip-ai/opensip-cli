---
status: current
last_verified: 2026-06-12
release: v0.1.15
title: "Initialize your first repo"
audience: [getting-started, ci-integrators]
purpose: "Task-led guide for running opensip init, understanding the scaffold, and getting to the first useful run."
source-files:
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/host-command-specs.ts
  - packages/fitness/engine/src/tool.ts
  - packages/simulation/engine/src/tool.ts
related-docs:
  - ../00-start/00-quick-start.md
  - ../70-reference/01-cli-commands.md
  - ./01-write-your-first-check.md
  - ./06-use-graph.md
---
# Initialize your first repo

Use this guide when you are ready to put opensip-cli into a real project. You will install the CLI, scaffold project files, run the example recipe, and learn what is safe to commit.

## 1. Install

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
opensip --version
```

opensip-cli requires Node.js 24+. The installer installs the unscoped `opensip-cli` package, which owns the `opensip` binary.

## 2. Enter a project

```bash
cd your-project
```

Language detection is marker-based:

| Language | Marker |
|---|---|
| TypeScript / JavaScript | `tsconfig.json`, or `package.json` alone |
| Python | `pyproject.toml`, `setup.py` |
| Rust | `Cargo.toml` |
| Go | `go.mod` |
| Java | `pom.xml`, `build.gradle` |
| C / C++ | `CMakeLists.txt` |

If your repo has multiple markers, either let `init` scaffold for all detected languages or pass the list explicitly:

```bash
opensip init --language typescript,python
```

## 3. Scaffold

```bash
opensip init
```

The command writes:

```text
opensip-cli.config.yml
opensip-cli/
  fit/
    checks/
    recipes/
  sim/
    scenarios/
    recipes/
```

It also adds `opensip-cli/.runtime/` to `.gitignore`. Commit the config and the authored content under `opensip-cli/`. Do not commit `.runtime/`; it holds local sessions, reports, logs, caches, baselines, and the SQLite datastore.

`graph` does not scaffold a directory because graph rules and adapters are package-level extensions, not project-local files created by `init`.

## 4. Run the scaffolded recipe

```bash
opensip fit --recipe example
```

That run proves the project wiring end to end: config loading, target detection, plugin discovery, recipe selection, check execution, rendering, and exit-code policy.

If you also want to smoke-test the scaffolded simulation files:

```bash
opensip sim --recipe example
```

Simulation scenarios drive real targets. Keep scaffolded scenarios harmless until you replace them with a target you own.

## 5. Inspect what is available

```bash
opensip fit --list
opensip fit recipes
opensip graph --list-files
```

`fit --list` shows the loaded check inventory. `fit recipes` shows named fit recipes. `graph --list-files` is a cheap discovery-only check that prints the files graph would analyze without building the catalog.

## 6. Re-run safely

If `init` finds existing opensip-cli files, it protects user-authored content:

```bash
opensip init --keep     # preserve custom files and refresh missing scaffold files
opensip init --remove   # delete opensip-cli/ and scaffold fresh
```

`--keep` is the safe repair path. `--remove` is destructive for anything under `opensip-cli/`, so use it only when the authored files are committed or disposable.

## 7. First useful next step

Edit the scaffolded check or write a new one:

```bash
opensip fit --check <slug> --verbose
```

Then save a baseline when you are ready to adopt in CI:

```bash
opensip fit --gate-save
opensip fit --gate-compare
```

## Where to go next

| You want to ... | Go to |
|---|---|
| Write a custom check | [Write your first check](./01-write-your-first-check.md) |
| Ban a specific API | [Ban an API pattern](./02-ban-an-api-pattern.md) |
| Add the gate to CI | [Wire into CI](./03-wire-into-ci.md) |
| Try static call-graph analysis | [Use graph](./06-use-graph.md) |
| Look up every flag | [CLI commands](../70-reference/01-cli-commands.md) |
