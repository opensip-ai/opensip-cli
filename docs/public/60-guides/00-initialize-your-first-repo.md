---
status: current
last_verified: 2026-07-15
release: v0.8.2
title: "Initialize your first repo"
audience: [getting-started, ci-integrators]
purpose: "Task-led guide for running opensip init, understanding the scaffold, and getting to the first useful run."
source-files:
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/init/scaffold-writer.ts
  - packages/cli/src/commands/host-command-specs.ts
  - packages/cli/src/bootstrap/no-init-config.ts
  - packages/core/src/lib/ephemeral-runtime.ts
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

If your repo has multiple detected languages, Init reports the set and requires
you to pass the intended list explicitly:

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

For a **zero-config project**, the CLI synthesizes a validated in-memory config from
the same language markers and writes no implicit OpenSIP state into the project.
An explicitly requested export, SARIF, or profile path is the exception. Runtime state goes to a
managed user-cache entry. It is real file-backed storage that survives commands
and reboots, but it is eligible for automatic eviction when the project is
gone, the entry is stale, or the cache exceeds its project limit. Do not treat
it as permanent history.

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

If you ran a zero-config command first, a successful Init scaffold moves that
existing runtime state into `opensip-cli/.runtime/` when the cache runtime
exists and the project runtime does not.

### What initialization changes

`init` is the command that changes project state; it is not the name of a
storage tier.

| Before `opensip init` | After `opensip init` |
|---|---|
| **Zero-config mode** | **Initialized project mode** |
| Evidence is under the user cache | Evidence is under the project-local, gitignored `.runtime/` |
| Config is synthesized in memory | Config and authored guardrails are explicit and can be committed |
| Only commands declared first-run capable are available | The complete project/config/plugin surface is available |
| The whole cache entry is automatically evictable | There is no whole-project cache eviction policy |

Both modes use the same local SQLite and runtime-file formats. Initialization
persists project intent and attaches local evidence to the project; it does not
turn that evidence into permanent or team-shared storage. Normal session and
artifact retention still applies, and teammates receive the committed config
and authored guardrails—not your gitignored `.runtime/` history.

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

See the [init optional-tools reference](../70-reference/01-cli-commands.md#optional-tools-after-pristine-init)
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
| Write a custom check | [Write your first check](./01-write-your-first-check.md) |
| Ban a specific API | [Ban an API pattern](./02-ban-an-api-pattern.md) |
| Add the gate to CI | [Wire into CI](./03-wire-into-ci.md) |
| Try static call-graph analysis | [Use graph](./06-use-graph.md) |
| Look up every flag | [CLI commands](../70-reference/01-cli-commands.md) |
