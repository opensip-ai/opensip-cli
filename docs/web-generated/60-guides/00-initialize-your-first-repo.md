---
status: current
last_verified: 2026-06-12
release: v3.0.0
title: "Initialize your first repo"
audience: [getting-started, ci-integrators]
purpose: "Task-led guide for running opensip-tools init, understanding the scaffold, and getting to the first useful run."
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

Use this guide when you are ready to put opensip-tools into a real project. You will install the CLI, scaffold project files, run the example recipe, and learn what is safe to commit.

## 1. Install

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
opensip-tools --version
```

opensip-tools requires Node.js 24+. The installer installs the unscoped `opensip-tools` package, which owns the `opensip-tools` binary.

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
opensip-tools init --language typescript,python
```

## 3. Scaffold

```bash
opensip-tools init
```

The command writes:

```text
opensip-tools.config.yml
opensip-tools/
  fit/
    checks/
    recipes/
  sim/
    scenarios/
    recipes/
```

It also adds `opensip-tools/.runtime/` to `.gitignore`. Commit the config and the authored content under `opensip-tools/`. Do not commit `.runtime/`; it holds local sessions, reports, logs, caches, baselines, and the SQLite datastore.

`graph` does not scaffold a directory because graph rules and adapters are package-level extensions, not project-local files created by `init`.

## 4. Run the scaffolded recipe

```bash
opensip-tools fit --recipe example
```

That run proves the project wiring end to end: config loading, target detection, plugin discovery, recipe selection, check execution, rendering, and exit-code policy.

If you also want to smoke-test the scaffolded simulation files:

```bash
opensip-tools sim --recipe example
```

Simulation scenarios drive real targets. Keep scaffolded scenarios harmless until you replace them with a target you own.

## 5. Inspect what is available

```bash
opensip-tools fit --list
opensip-tools fit-recipes
opensip-tools graph --list-files
```

`fit --list` shows the loaded check inventory. `fit-recipes` shows named fit recipes. `graph --list-files` is a cheap discovery-only check that prints the files graph would analyze without building the catalog.

## 6. Re-run safely

If `init` finds existing opensip-tools files, it protects user-authored content:

```bash
opensip-tools init --keep     # preserve custom files and refresh missing scaffold files
opensip-tools init --remove   # delete opensip-tools/ and scaffold fresh
```

`--keep` is the safe repair path. `--remove` is destructive for anything under `opensip-tools/`, so use it only when the authored files are committed or disposable.

## 7. First useful next step

Edit the scaffolded check or write a new one:

```bash
opensip-tools fit --check <slug> --verbose
```

Then save a baseline when you are ready to adopt in CI:

```bash
opensip-tools fit --gate-save
opensip-tools fit --gate-compare
```

## Where to go next

| You want to ... | Go to |
|---|---|
| Write a custom check | [Write your first check](/docs/opensip-tools/60-guides/01-write-your-first-check/) |
| Ban a specific API | [Ban an API pattern](/docs/opensip-tools/60-guides/02-ban-an-api-pattern/) |
| Add the gate to CI | [Wire into CI](/docs/opensip-tools/60-guides/03-wire-into-ci/) |
| Try static call-graph analysis | [Use graph](/docs/opensip-tools/60-guides/06-use-graph/) |
| Look up every flag | [CLI commands](/docs/opensip-tools/70-reference/01-cli-commands/) |
