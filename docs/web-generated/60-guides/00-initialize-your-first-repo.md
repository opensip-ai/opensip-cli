---
status: current
last_verified: 2026-07-14
release: v0.7.0
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
| Python | `pyproject.toml`, `setup.py`, `requirements.txt` |
| Rust | `Cargo.toml` |
| Go | `go.mod` |
| Java | `pom.xml`, `build.gradle` |
| C / C++ | `CMakeLists.txt`, `Makefile` |

If your repo has multiple markers, either let `init` scaffold for all detected languages or pass the list explicitly:

```bash
opensip init --language typescript,python
```

Before you scaffold, the built-in analysis commands can still run:

```bash
opensip audit
```

In a git repo, the built-in audit suite runs changed-scope by default and prints
the resolved scope, for example `Scope: changed (working tree, 14 files)`. Use
`opensip audit --full` when you want the whole repo. Outside git, the
same command falls back to full scope with one suite-level notice.

Use `opensip audit --open` for a human Change Impact report or `opensip audit
--json` for machine output. Browser launch is suppressed for JSON, CI, non-TTY,
and remote-shell execution. Configured multi-tool workflows continue to use
`opensip suite run <name>`; the suite name `audit` is reserved for the built-in
review (config validation rejects `suites.audit`), so name custom suites
something else.

For lower-level inspection:

```bash
opensip fit
opensip graph --list-files
```

In that no-init mode, the CLI synthesizes a validated in-memory config from the
same language markers and writes no project files. Runtime state goes to your
user cache until you adopt the project with `opensip init`.

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

If you ran a no-init command first, `init` moves that rebuildable runtime state
into `opensip-cli/.runtime/` when the project runtime does not already exist.

`graph` does not scaffold a directory because graph rules and adapters are package-level extensions, not project-local files created by `init`.

## 4. Run the scaffolded recipe

```bash
opensip fit --recipe example
```

That run proves the project wiring end to end: config loading, target detection, plugin discovery, recipe selection, check execution, rendering, and exit-code policy.

### Optional tools after a pristine init

A successful **pristine** `opensip init` (first scaffold for a project with at
least one selected language) may also print an **Optional tools for this project
(not installed)** footer after the **Try it** block. Rows are language-relevant
first-party adapter recommendations from the same catalog as
`opensip tools list --available`: multi-language union plus polyglot adapters,
already-installed adapters omitted, exact install commands only.

- Advice only — `init` never prompts, installs, or executes adapter code.
- Repeat init, `--keep`, `--remove`, recovery, and error paths do **not** emit
  recommendations.
- With `--json`, the same rows appear under `data.optionalTools` (field absent
  when ineligible or nothing remains to recommend).

See the [init optional-tools reference](/docs/opensip-cli/70-reference/01-cli-commands/#optional-tools-after-pristine-init)
for the full field list and eligibility rules.

If you also want to smoke-test the scaffolded simulation files:

```bash
opensip sim --recipe example
```

Simulation scenarios drive real targets. Keep scaffolded scenarios harmless until you replace them with a target you own.

## 5. Inspect what is available

```bash
opensip fit list
opensip fit recipes
opensip graph --list-files
```

`fit list` shows the loaded check inventory. `fit recipes` shows named fit recipes. `graph --list-files` is a cheap discovery-only check that prints the files graph would analyze without building the catalog.

## 6. Re-run safely

If `init` finds existing opensip-cli files, it protects user-authored content:

```bash
opensip init --keep     # preserve root config/custom files; refresh missing scaffold files
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
| Write a custom check | [Write your first check](/docs/opensip-cli/60-guides/01-write-your-first-check/) |
| Ban a specific API | [Ban an API pattern](/docs/opensip-cli/60-guides/02-ban-an-api-pattern/) |
| Add the gate to CI | [Wire into CI](/docs/opensip-cli/60-guides/03-wire-into-ci/) |
| Try static call-graph analysis | [Use graph](/docs/opensip-cli/60-guides/06-use-graph/) |
| Look up every flag | [CLI commands](/docs/opensip-cli/70-reference/01-cli-commands/) |
