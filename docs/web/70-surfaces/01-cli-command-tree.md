---
status: current
last_verified: 2026-05-15
title: "CLI command tree"
audience: [users, ci-integrators, contributors]
purpose: "Lookup-shaped reference for every CLI command, its flags, and when to use each."
source-files:
  - packages/cli/src/index.ts
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/configure.ts
  - packages/cli/src/commands/plugin.ts
  - packages/cli/src/commands/uninstall.ts
  - packages/cli/src/commands/completion.ts
  - packages/fitness/engine/src/tool.ts
  - packages/simulation/engine/src/tool.ts
related-docs:
  - ../50-runtime/01-cli-dispatch.md
  - ../80-reference/02-configuration.md
---
# CLI command tree

Every command, alphabetized by command name. Use this when you need to look up a flag, not when you're learning what a command is for. For "why", read the relevant subsystem doc.

The grouping mirrors the source split: tool-owned commands (`fit`, `sim`, `dashboard`, `fit-list`, `fit-recipes`) come from each Tool's `register()` call. CLI-owned commands (everything else) live under [`packages/cli/src/commands/`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/cli/src/commands/).

---

## Top-level

```
opensip-tools                           # show welcome banner + next steps
opensip-tools --version                  # print version, exit
opensip-tools --help                     # print full help, exit
opensip-tools <command> --help           # per-command help
```

Per-command flags that appear on most subcommands (registered individually by each Tool / each top-level command — there are no `program`-level Commander options beyond `--version`):

| Flag | Effect |
|---|---|
| `--debug` | Enable debug-level logging (events of `debug` level appear in stderr and the run log file). |
| `--quiet` | Suppress banner / boxes; print only the pass/fail summary line. (Where supported.) |
| `--cwd <path>` | Override the project root (default: `process.cwd()`). Registered on `init`, `fit`, `sim`, `graph`, `dashboard`, `plugin <subcmd>`. |
| `--json` | Emit structured JSON on stdout instead of the table renderer. (Per-command — `init`, `fit`, `sim`, `graph`.) |

---

## `fit` — run fitness checks

Tool-owned: [`packages/fitness/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/tool.ts).

```
opensip-tools fit
opensip-tools fit --recipe <name>
opensip-tools fit --check <slug>
opensip-tools fit --tags <list>
opensip-tools fit --gate-save
opensip-tools fit --gate-compare
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--recipe <name>` | string | `default` | Use a named recipe. Built-in `default` runs every enabled check. |
| `--check <slug>` | string | — | Run a single check by slug. Mutually informative with `--recipe`. |
| `--tags <list>` | comma-list | — | Filter checks by tag (intersected with the recipe's selector). |
| `--exclude <slug>` | repeatable | `[]` | Exclude check by slug. Can be passed multiple times. |
| `--list` | bool | `false` | List available checks instead of running. |
| `--recipes` | bool | `false` | List available recipes instead of running. |
| `--findings` | bool | `false` | Append a per-check finding listing after the table. |
| `-v, --verbose` | bool | `false` | Inline finding details + findings summary. |
| `--report-to <url>` | URL | — | POST findings to a URL (OpenSIP Cloud or compatible). |
| `--api-key <key>` | string | — | API key for `--report-to`. |
| `--gate-save` | bool | `false` | Save current findings as architecture baseline. |
| `--gate-compare` | bool | `false` | Compare current findings against baseline; exit 1 on regression. |
| `--baseline <path>` | path | `opensip-tools/.runtime/baseline.sarif` | Baseline file location for `--gate-save`/`--gate-compare`. |
| `-q, --quiet` | bool | `false` | Suppress banner. |
| `--open` | bool | `false` | Launch dashboard after run. |
| `--config <path>` | path | discovered | Override the `opensip-tools.config.yml` location (defaults to the project's config or the package.json pointer). |
| `--cwd <path>` | path | `process.cwd()` | Target directory. |

**Mutual exclusion:** `--gate-save` and `--gate-compare` cannot be combined.

**Exit codes:** 0 (passed), 1 (violations or regression), 2 (configuration error), 3 (`--check` slug not found), 4 (`--report-to` upload failure).

**See also:** [`20-the-fit-loop/04-output-gate-sarif.md`](/docs/opensip-tools/20-the-fit-loop/04-output-gate-sarif/), [`60-subsystems/03-architecture-gate.md`](/docs/opensip-tools/60-subsystems/03-architecture-gate/).

---

## `sim` — run simulation scenarios

Tool-owned: [`packages/simulation/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/simulation/engine/src/tool.ts). Marked **experimental** in `--help`.

```
opensip-tools sim
opensip-tools sim --recipe <name>
opensip-tools sim --kind <kind>
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--recipe <name>` | string | built-in `default` | Run a named sim recipe. |
| `--kind <kind>` | string | — | Filter scenarios by kind. One of `load`, `chaos`, `invariant`, `fix-evaluation`. |
| `-q, --quiet` | bool | `false` | Suppress banner. |
| `--open` | bool | `false` | Launch dashboard after run. |

**Exit codes:** 0 (all scenarios passed), 1 (any scenario failed), 2 (config/runtime error).

**See also:** [`30-the-sim-loop/`](/docs/opensip-tools/30-the-sim-loop/).

---

## `graph` — static call-graph + dead-end analysis

Tool-owned: [`packages/graph/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/graph/engine/src/tool.ts). The pipeline architecture and cache invalidation are documented in [`40-the-graph-loop/01-stages-and-catalog.md`](/docs/opensip-tools/40-the-graph-loop/01-stages-and-catalog/); the perf-plan history is in [`docs/plans/graph-performance-improvements.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/docs/plans/graph-performance-improvements.md).

```
opensip-tools graph
opensip-tools graph --json
opensip-tools graph --no-cache
opensip-tools graph --gate-save
opensip-tools graph --gate-compare
opensip-tools graph --report-to <url>
opensip-tools graph --package <name|path>
opensip-tools graph --packages
```

`graph` is the single entry point for static call-graph analysis. The default (non-JSON) output is a structured terminal report with four sections: catalog summary, findings grouped by rule (top 10 per rule, with overflow indicator), top 10 inferred entry points, and a one-line summary. The full data is always available via `--json`.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--cwd <path>` | string | `process.cwd()` | Target directory (must contain a `tsconfig.json`). |
| `--json` | bool | `false` | Output a `CliOutput`-shaped JSON document instead of the unified terminal report. |
| `--no-cache` | bool | `false` | Skip the catalog cache and force a full rebuild. |
| `--gate-save` | bool | `false` | Save the current Signal set to `<project>/opensip-tools/.runtime/cache/graph/baseline.json`. Mutually exclusive with `--gate-compare`. |
| `--gate-compare` | bool | `false` | Compare current Signals to the baseline; exit non-zero on regression. |
| `--baseline <path>` | string | `<project>/opensip-tools/.runtime/cache/graph/baseline.json` | Override the baseline path for `--gate-save` / `--gate-compare`. |
| `--report-to <url>` | string | — | POST findings to OpenSIP Cloud or a compatible SARIF endpoint. |
| `--package <name\|path>` | string | — | Scope the run to one workspace package (faster on monorepos; cross-package edges become unresolved). Searches `packages/**` for a basename match, or accepts an explicit directory path. Mutually exclusive with `--packages`. |
| `--packages` | bool | `false` | Fan the run across every workspace package under `packages/**` with a `tsconfig.json`. One child process per package; concurrency capped at `cpus()-1`. Aggregates per-package findings. |
| `--packages-concurrency <n>` | int | `cpus()-1` | Override `--packages` concurrency cap. |

**Exit codes:** 0 (success / gate clean), 1 (runtime error / gate regression / any `--packages` child failed), 2 (configuration error), 4 (`--report-to` upload failed).

**Heap sizing:** for projects with > 1000 source files, `graph` emits a one-line stderr hint at startup recommending `NODE_OPTIONS=--max-old-space-size=8192` (or higher). On a 5476-file repo the default 4 GB heap is not enough for a global run.

**Catalog file:** `<project>/opensip-tools/.runtime/cache/graph/catalog.json` — content-keyed by `tsCompilerVersion`, `tsConfigPath`, and a per-file mtime+size fingerprint. The streamed write emits the catalog entry-by-entry (Phase 2, see perf plan) but produces byte-identical output to a `JSON.stringify` round-trip.

**Cache behavior:** three verdicts — `valid` (full cache hit), `incremental` (re-walk only the changed files plus their transitive edge-dependents), `invalid` (full rebuild). The incremental path makes single-file edits ~6× faster than a `--no-cache` rebuild while producing byte-identical output. See the cache section in the stages-and-catalog doc.

**Entry-point reasons** (rendered in the entry-points section): `module-init` (every file's top-level statements), `name-match` (`main` / `run` / `start` / `register` / `init` / `bootstrap` / `initialize`), `no-callers-exported` (exported with no in-project caller). Bin-entry and tool-registration heuristics are deferred to v0.3.

> **History.** v0.2 originally registered three subcommands — `graph`, `graph-orphans`, and `graph-entry-points`. The two filtered views were folded into the unified `graph` output; all three data slices (rules, entry points, catalog summary) are now reachable from the single `graph` invocation.

---

## `dashboard` — open the HTML report

Tool-owned (fitness Tool registers it). Renders the most recent run as HTML and opens it in the user's default browser.

```
opensip-tools dashboard
opensip-tools dashboard --cwd <path>
```

The dashboard is a single self-contained HTML file at `<project>/opensip-tools/.runtime/reports/latest.html`. Each generation overwrites the previous file. The command launches the browser and exits; the file works without opensip-tools installed, so you can email it directly to a teammate.

**See also:** [`70-surfaces/03-dashboard.md`](/docs/opensip-tools/70-surfaces/03-dashboard/), [`50-runtime/03-session-and-persistence.md`](/docs/opensip-tools/50-runtime/03-session-and-persistence/).

---

## `fit-list` (alias: `list-checks`) — catalog checks

Tool-owned. Prints the loaded check inventory: slug, description, tags.

```
opensip-tools fit-list
opensip-tools fit-list --json
opensip-tools list-checks                # alias
```

JSON shape:

```json
{
  "type": "list-checks",
  "checks": [{ "slug": "...", "description": "...", "tags": ["..."] }],
  "totalCount": 162
}
```

Useful for scripting (`opensip-tools fit-list --json | jq '.checks[].slug'`) and for verifying that a `plugin add` actually registered the new pack's checks.

---

## `fit-recipes` (alias: `list-recipes`) — catalog recipes

Tool-owned. Prints the loaded recipe inventory.

```
opensip-tools fit-recipes
opensip-tools fit-recipes --json
opensip-tools list-recipes               # alias
```

JSON shape:

```json
{
  "type": "list-recipes",
  "recipes": [
    { "name": "default", "description": "...", "checkCount": "all checks" },
    { "name": "quick-smoke", "description": "...", "checkCount": "12 checks" },
    { "name": "by-tag", "description": "...", "checkCount": "pattern-based" }
  ]
}
```

`checkCount` is a human-readable string set by the recipe's selector — `"all checks"` for `selector.type === 'all'`, `"<n> checks"` for explicit selectors, `"pattern-based"` for tag/pattern selectors. It is never a bare numeric string.

---

## `init` — scaffold the project layout

CLI-owned: [`packages/cli/src/commands/init.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/cli/src/commands/init.ts).

```
opensip-tools init
opensip-tools init --language <list>
opensip-tools init --force
```

Detects the project's primary language(s) from filesystem markers and writes:

```
<cwd>/opensip-tools.config.yml                              # TRACKED
<cwd>/opensip-tools/fit/checks/example-check.mjs            # TRACKED
<cwd>/opensip-tools/fit/recipes/example-recipe.mjs          # TRACKED
<cwd>/opensip-tools/sim/scenarios/example-scenario.mjs      # TRACKED
<cwd>/opensip-tools/sim/recipes/example-recipe.mjs          # TRACKED
```

Plus appends `opensip-tools/.runtime/` to `<cwd>/.gitignore`.

| Flag | Effect |
|---|---|
| `--language <list>` | Comma-separated language list (`typescript,rust`). Overrides detection. |
| `--force` | Overwrite existing `opensip-tools.config.yml` and example files. |
| `--cwd <path>` | Target directory (default: `process.cwd()`). |
| `--json` | Emit a structured JSON result instead of the human-readable summary. |
| `--debug` | Enable debug-level logging. |

Detection markers:

| Marker | Language |
|---|---|
| `Cargo.toml` | `rust` |
| `pyproject.toml`, `setup.py` | `python` |
| `go.mod` | `go` |
| `pom.xml`, `build.gradle` | `java` |
| `CMakeLists.txt` | `cpp` |
| `tsconfig.json` (or `package.json` alone with no other marker) | `typescript` |

Ambiguous detection (multiple markers, no `--language`) exits 2 with a prompt to specify `--language`.

**Exit codes:** 0 (created), 0 (already exists, with notice), 2 (ambiguous detection / parse error).

---

## `configure` — manage user-level settings

CLI-owned: [`packages/cli/src/commands/configure.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/cli/src/commands/configure.ts). Interactive — sets up the OpenSIP Cloud API key in `~/.opensip-tools/config.yml`.

```
opensip-tools configure
```

Prompts:
1. Have an API key already?
2. If yes, paste it.
3. If no, walk through `https://opensip.ai` signup.
4. Test the key against the cloud's auth endpoint.
5. Write `~/.opensip-tools/config.yml` with the key.

The user-level config is shared across every project on the machine. `opensip-tools fit --report-to <url>` uses the configured key by default unless `--api-key` overrides it.

---

## `sessions list` and `sessions purge` — manage session records

CLI-owned. Walks `<project>/opensip-tools/.runtime/sessions/`.

```
opensip-tools sessions list
opensip-tools sessions purge
opensip-tools sessions purge --older-than 7
opensip-tools sessions purge -y
```

| Subcommand | Flag | Effect |
|---|---|---|
| `list` | (none) | List every stored session, newest first. |
| `purge` | `--older-than <days>` | Only delete sessions older than N days. Default: delete all. |
| `purge` | `-y, --yes` | Skip the confirmation prompt. |

**See also:** [`50-runtime/03-session-and-persistence.md`](/docs/opensip-tools/50-runtime/03-session-and-persistence/).

---

## `plugin add/remove/list/sync` — manage project-pinned plugins

CLI-owned: [`packages/cli/src/commands/plugin.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/cli/src/commands/plugin.ts).

```
opensip-tools plugin list
opensip-tools plugin add <pkg>
opensip-tools plugin add <pkg> --domain <fit|sim>
opensip-tools plugin remove <pkg>
opensip-tools plugin sync
```

| Flag | Subcommands | Effect |
|---|---|---|
| `--domain <fit\|sim>` | `add`, `remove`, `sync` | Override the inferred domain (`add`/`remove`) or scope a sync to one domain (`sync`). |
| `--cwd <path>` | all | Project root. Default: `process.cwd()`. |

**`add`** writes to `.runtime/plugins/<domain>/node_modules/<pkg>/` and appends to `plugins.<domain>:` in `opensip-tools.config.yml`. **`remove`** is the inverse. **`list`** intersects installed and config-listed packages. **`sync`** installs everything declared in the config — the post-clone bootstrap.

**See also:** [`50-runtime/02-plugin-loader.md`](/docs/opensip-tools/50-runtime/02-plugin-loader/).

---

## `completion` — print shell completion script

CLI-owned: [`packages/cli/src/commands/completion.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/cli/src/commands/completion.ts).

```
opensip-tools completion bash
opensip-tools completion zsh
opensip-tools completion fish
```

`<shell>` is required — there's no default.

Pipe to your shell's completion config:

```bash
opensip-tools completion zsh > ~/.opensip-tools-completion.zsh
echo "source ~/.opensip-tools-completion.zsh" >> ~/.zshrc
```

The completion catalog is sourced from `defaultToolRegistry.list()`, so installed third-party tools' commands complete automatically once the script is regenerated.

---

## `uninstall` — remove opensip-tools state

CLI-owned: [`packages/cli/src/commands/uninstall.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/cli/src/commands/uninstall.ts).

```
opensip-tools uninstall                       # remove ~/.opensip-tools/
opensip-tools uninstall --project             # remove project state at cwd
opensip-tools uninstall --project /path/repo  # remove project state at <path>
opensip-tools uninstall --dry-run             # print targets, take no action
opensip-tools uninstall --yes                 # skip confirmation prompt
```

Two modes:

| Mode | Targets removed | When to use |
|---|---|---|
| Default | `~/.opensip-tools/` (user-level config dir) | Removing the cloud API key + per-user defaults; cleaning legacy cruft from earlier versions. |
| `--project [path]` | `<path>/opensip-tools/` and `<path>/opensip-tools.config.yml` | Disengaging from opensip-tools in one repo. Removes user-authored checks/recipes alongside generated `.runtime/` state. |

| Flag | Effect |
|---|---|
| `--project [path]` | Switch to project mode. Path defaults to cwd. |
| `--yes`, `-y` | Skip the `[y/N]` confirmation prompt. |
| `--dry-run` | Enumerate targets and total size; make no changes. |

Both modes:

- Print every target path and its size before acting.
- Refuse to run when no targets exist (`--project` against a directory that contains no opensip-tools state is a no-op, not a destructive accident).
- Do **not** remove the npm-global binary — the running binary can't safely self-delete. The user-mode success message prints the next step (`npm uninstall -g @opensip-tools/cli`); the project-mode success message points back at the user-mode command for the matching cleanup.

State contract enforced by code: `~/.opensip-tools/` holds `config.yml` only. Persistence and logging modules throw when asked to write there (see [`store.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/contracts/src/persistence/store.ts), [`logger.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/core/src/lib/logger.ts)). Anything else in that directory is legacy cruft from pre-1.0 versions and is swept up by the default `uninstall`.

---

## What's next

- **[`02-plugin-authoring.md`](/docs/opensip-tools/70-surfaces/02-plugin-authoring/)** — write a check, recipe, scenario, or full Tool plugin.
- **[`03-dashboard.md`](/docs/opensip-tools/70-surfaces/03-dashboard/)** — the HTML report's structure and lifecycle.
- **[`../80-reference/02-configuration.md`](/docs/opensip-tools/80-reference/02-configuration/)** — every field of `opensip-tools.config.yml`.
