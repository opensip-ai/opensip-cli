---
status: current
last_verified: 2026-05-22
release: v2.0.x
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
  - ../80-implementation/01-cli-dispatch.md
  - ../70-reference/03-configuration.md
---
# CLI command tree

Every command, alphabetized by command name. Use this when you need to look up a flag, not when you're learning what a command is for. For "why", read the relevant subsystem doc.

The grouping mirrors the source split: tool-owned commands (`fit`, `sim`, `dashboard`, `fit-list`, `fit-recipes`) come from each Tool's `register()` call. CLI-owned commands (everything else) live under [`packages/cli/src/commands/`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/cli/src/commands/).

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

Tool-owned: [`packages/fitness/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/fitness/engine/src/tool.ts).

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
| `--json` | bool | `false` | Emit `CliOutput` JSON on stdout instead of the table renderer. |
| `--findings` | bool | `false` | Append a per-check finding listing after the table. |
| `-v, --verbose` | bool | `false` | Inline finding details + findings summary. |
| `--report-to <url>` | URL | — | POST findings to a URL (OpenSIP Cloud or compatible). |
| `--api-key <key>` | string | — | API key for `--report-to`. |
| `--gate-save` | bool | `false` | Save current findings as architecture baseline. The baseline is stored as a row in the project's SQLite store (`fit_baseline` table at `opensip-tools/.runtime/datastore.sqlite`). |
| `--gate-compare` | bool | `false` | Compare current findings against baseline; exit 1 on regression. |
| `-q, --quiet` | bool | `false` | Suppress banner. |
| `--open` | bool | `false` | Launch dashboard after run. |
| `--config <path>` | path | discovered | Override the `opensip-tools.config.yml` location (defaults to the project's config or the package.json pointer). |
| `--cwd <path>` | path | `process.cwd()` | Target directory. |
| `--debug` | bool | `false` | Enable debug-level logging. |

**Mutual exclusion:** `--gate-save` and `--gate-compare` cannot be combined.

**Exit codes:** 0 (passed), 1 (violations or regression), 2 (configuration error), 3 (`--check` slug not found via the error-suggestion mapping). Note: a `--report-to` upload failure on `fit` is reported in the run footer but does **not** change the exit code (only the `graph` tool exits 4 for upload failure).

**See also:** [`20-fit/04-output-gate-sarif.md`](/docs/opensip-tools/20-fit/04-output-gate-sarif/), [`10-concepts/05-architecture-gate.md`](/docs/opensip-tools/10-concepts/05-architecture-gate/).

---

## `sim` — run simulation scenarios

Tool-owned: [`packages/simulation/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/simulation/engine/src/tool.ts). Marked **experimental** in `--help`.

```
opensip-tools sim
opensip-tools sim --recipe <name>
opensip-tools sim --kind <kind>
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--recipe <name>` | string | built-in `default` | Run a named sim recipe. |
| `--kind <kind>` | string | — | Filter scenarios by kind. One of `load`, `chaos`, `invariant`, `fix-evaluation`. |
| `--cwd <path>` | path | `process.cwd()` | Target directory. |
| `--json` | bool | `false` | Emit `SimDoneResult` JSON on stdout instead of the table renderer. |
| `-q, --quiet` | bool | `false` | Suppress banner. |
| `--open` | bool | `false` | Launch dashboard after run. |
| `--debug` | bool | `false` | Enable debug-level logging. |

**Exit codes:** 0 (all scenarios passed), 1 (any scenario failed), 2 (config/runtime error).

**See also:** [`30-sim/`](/docs/opensip-tools/30-sim/).

---

## `graph` — static call-graph + dead-end analysis

Tool-owned: [`packages/graph/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/graph/engine/src/tool.ts). The pipeline architecture and cache invalidation are documented in [`40-graph/01-stages-and-catalog.md`](/docs/opensip-tools/40-graph/01-stages-and-catalog/); perf-plan history is recoverable from `git -P log -- packages/graph`.

```
# Whole project (language auto-detected)
opensip-tools graph

# Scope to a single subtree
opensip-tools graph packages/core

# Scope to multiple subtrees (one session aggregates results)
opensip-tools graph packages/core packages/cli

# Shell glob expansion (the shell expands; opensip-tools doesn't)
opensip-tools graph 'packages/*/src'

# Fan out across detected workspace units (memory-isolated)
opensip-tools graph --workspace
opensip-tools graph --workspace --concurrency 4

# Force a specific language adapter (suppresses auto-detection)
opensip-tools graph --language typescript
opensip-tools graph --language python packages/services/api

# Other modes
opensip-tools graph --json
opensip-tools graph --no-cache
opensip-tools graph --gate-save
opensip-tools graph --gate-compare
opensip-tools graph --report-to <url>
```

`graph` is the single entry point for static call-graph analysis. The default (non-JSON) output is a one-line summary; pass `-v`/`--verbose` to expand the structured terminal report into its detailed sections: catalog summary, findings grouped by rule (top 10 per rule, with overflow indicator), and top 10 inferred entry points. The full data is always available via `--json`.

| Flag / Argument | Type | Default | Effect |
|---|---|---|---|
| `[paths...]` | path(s) | — | Positional. Scope the run to one or more existing directories (absolute or relative to `--cwd`). Multiple paths aggregate into a single dashboard session per D12. The shell handles globs (`graph 'packages/*/src'`); no glob expansion happens inside the CLI. Mutually exclusive with `--workspace`. |
| `--cwd <path>` | string | `process.cwd()` | Target directory. Adapter is auto-detected by marker files (TypeScript: `tsconfig.json`/`package.json`; Python: `pyproject.toml`/`setup.py`/`setup.cfg`; Rust: `Cargo.toml`; Go: `go.mod`; Java: `pom.xml`/`build.gradle*`). Polyglot repos apply every matched adapter simultaneously (D6). |
| `--workspace` | bool | `false` | Fan the run across every workspace unit returned by each detected adapter's `discoverWorkspaceUnits` hook. Polyglot per D8b: a repo with both a TS pnpm workspace and a Cargo workspace fans out across both adapters' units in one combined run. Memory-isolated (one child process per unit). Mutually exclusive with positional paths. |
| `--concurrency <n>` | int | `cpus()-1` | Concurrency cap for `--workspace` child processes. |
| `--language <name>` | string | — | Force a specific language adapter, suppressing marker-based auto-detection. If the discovered file count is zero, exits with code 2 and the message `--language <name> matched 0 files under <paths>; check the flag or paths.` (D14). |
| `--json` | bool | `false` | Output a `CliOutput`-shaped JSON document instead of the unified terminal report. |
| `--no-cache` | bool | `false` | Skip the catalog cache and force a full rebuild. |
| `--resolution <mode>` | string | `exact` | Edge resolution tier: `exact` (semantic, uses the type checker) or `fast` (syntactic, no type checker — ~2× faster cold builds at lower edge fidelity). Invalid values fail loudly at the boundary. |
| `--gate-save` | bool | `false` | Save the current Signal fingerprint set to the project's SQLite store (`graph_baseline_signals` table). Mutually exclusive with `--gate-compare`. |
| `--gate-compare` | bool | `false` | Compare current Signals to the saved baseline; exit non-zero on regression. |
| `--baseline <path>` | path | — | Override the default baseline location (used with `--gate-save` / `--gate-compare`) — e.g. pin to a CI artifact location instead of the project's SQLite store. |
| `--report-to <url>` | string | — | POST findings to OpenSIP Cloud or a compatible SARIF endpoint. |
| `-v, --verbose` | bool | `false` | Expand the done view to show the detailed catalog, findings-by-rule, and entry-point sections (default: one-line summary only). |
| `--debug` | bool | `false` | Enable debug-mode structured log output. |

**Polyglot example.** In a repo with both a TypeScript pnpm workspace and a Cargo workspace, the polyglot detection applies both adapters in a single run:

```
# Polyglot repo: TS frontend + Cargo backend
# `--workspace` aggregates units from BOTH adapters and fans out in parallel.
opensip-tools graph --workspace
# → one session in the dashboard combining TS package results + Cargo member results
```

**Session contract.** A single CLI invocation produces a single dashboard session, regardless of how many positional paths or workspace units the run analyzed. Modes that produce machine-readable artifacts instead of dashboard sessions (`--json`, `--gate-save`, `--gate-compare`, `--report-to`, `--catalog-output`) opt out.

**Adapter selection.** v2.0.0 ships first-party graph adapters for TypeScript, Python, Rust, Go, and Java — each is its own publishable npm package under the `@opensip-tools/graph-*` namespace. Discovery is by name pattern: `node_modules` is walked for any package whose name matches `@opensip-tools/graph-*`, or you can pin an explicit list under `plugins.graphAdapters:` in `opensip-tools.config.yml`. Marker-file detection (`tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`/`build.gradle*`) then chooses which discovered adapter(s) apply to the run; positional paths inherit that decision unless `--language` overrides it.

**Exit codes:** 0 (success / gate clean), 1 (runtime error / gate regression / any `--workspace` child failed), 2 (configuration error / D14 zero-file mismatch), 4 (`--report-to` upload failed).

**Heap sizing:** for projects with > 1000 source files, `graph` emits a one-line stderr hint at startup recommending `NODE_OPTIONS=--max-old-space-size=8192` (or higher). On a 5476-file repo the default 4 GB heap is not enough for a global run. The preflight skips automatically when an explicit scope is present (positional paths, `--workspace`, or `--language`). (Heap sizing is most acute for the TypeScript adapter, which holds a project-wide `ts.Program`; tree-sitter adapters parse lazily per file and use far less memory.)

**`OPENSIP_HEAP_NO_MONITOR`** (env var): during a build, `graph` runs a V8 heap-pressure monitor that aborts with a readable `MemoryPressureError` when old-gen usage crosses ~90% of the heap limit — catching an impending OOM before V8 SIGABRTs the process. In unusual GC scenarios (REPL embedding, custom allocators) this guard can fire as a false positive before a real OOM is imminent. Set `OPENSIP_HEAP_NO_MONITOR=1` to disable it entirely. This is an escape hatch only: with the monitor off, an actual out-of-memory condition becomes a bare V8 abort instead of a structured error. Prefer raising the heap ceiling (above) or scoping the run (positional paths / `--workspace`) first.

**Catalog storage:** v2 stores the catalog in the project's SQLite database (`<project>/opensip-tools/.runtime/datastore.sqlite`, `graph_catalog` row). v3 wire-format remains: `language` (adapter id), `cacheKey` (an opaque per-adapter invalidation string — TypeScript: `ts-${ts.version}-${tsconfigContentHash}`; Python and Rust use language-id-prefixed keys), and a per-file mtime+size fingerprint. The reconstructed in-memory `Catalog` shape is unchanged from v1's `cache/read.ts` output.

**Cache behavior:** three verdicts — `valid` (full cache hit), `incremental` (re-walk only the changed files plus their transitive edge-dependents), `invalid` (full rebuild). The incremental path makes single-file edits ~6× faster than a `--no-cache` rebuild while producing byte-identical output. See the cache section in the stages-and-catalog doc.

**Entry-point reasons** (rendered in the entry-points section): `module-init` (every file's top-level statements), `name-match` (`main` / `run` / `start` / `register` / `init` / `bootstrap` / `initialize`), `no-callers-exported` (exported with no in-project caller). Bin-entry and tool-registration heuristics are deferred to v0.3.

> **History.** v0.2 originally registered three subcommands — `graph`, `graph-orphans`, and `graph-entry-points`. The two filtered views were folded into the unified `graph` output; all three data slices (rules, entry points, catalog summary) are now reachable from the single `graph` invocation.

---

## `graph-lookup` — look up function occurrences by name

Tool-owned (graph Tool). Queries the persisted catalog in the project's datastore for every function occurrence whose simple name matches the argument. Useful for "where is `saveBaseline` defined?" probes without re-running the full graph build.

```
opensip-tools graph-lookup <name>
opensip-tools graph-lookup <name> --json
```

| Flag / Argument | Type | Default | Effect |
|---|---|---|---|
| `<name>` | string | — | Positional. Function simple name to look up (e.g. `saveBaseline`). Required. |
| `--json` | bool | `false` | Output structured JSON instead of the human-readable list. |

The command reads from the catalog stored in `<project>/opensip-tools/.runtime/datastore.sqlite`. Run `opensip-tools graph` at least once first to populate the catalog.

---

## `graph-symbol-index` — emit symbol index artifact

Tool-owned (graph Tool). Writes a `symbolindex.json` file built from the persisted catalog: two maps — `name → [{ file, line }, …]` and `file → [name, …]`. Intended for editor tooling and offline cross-reference.

```
opensip-tools graph-symbol-index
opensip-tools graph-symbol-index --out path/to/symbolindex.json
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--cwd <path>` | path | `process.cwd()` | Target directory; `--out` resolves against this. |
| `--out <path>` | path | `symbolindex.json` | Output file path. |

Reads from the persisted catalog; run `opensip-tools graph` first to populate it.

---

## `graph-baseline-export` — export graph gate baseline

Tool-owned (graph Tool). Exports the stored graph gate baseline (the Signal fingerprint set saved by `graph --gate-save`) from the SQLite datastore to a portable JSON file. Mirrors `fit-baseline-export` for the graph tool.

```
opensip-tools graph-baseline-export --out graph-baseline.json
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--out <path>` | path | — | **Required.** Output file path for the JSON baseline. |
| `--cwd <path>` | path | `process.cwd()` | Target directory. |
| `--json` | bool | `false` | Emit a JSON result envelope on stdout instead of the human-readable summary. |

Exit codes: 0 on success, non-zero with a `result.exitCode` if the baseline is missing or the write fails. Useful for promoting a local baseline into CI or sharing one across machines without copying the SQLite file.

---

## `dashboard` — open the HTML report

CLI-owned. The cross-tool `dashboard` command lives at the CLI layer (not inside any one tool) because composition walks every tool's `collectDashboardData` contribution via the tool registry. Renders the most recent run as HTML and opens it in the user's default browser.

```
opensip-tools dashboard
opensip-tools dashboard --no-open
opensip-tools dashboard --json
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--no-open` | bool | `false` | Write the report but do not launch a browser. |
| `--json` | bool | `false` | Emit a `{ type: 'dashboard', path, opened }` JSON envelope on stdout instead of the table renderer. In `--json` mode the browser is never launched (machine-output contract). |

The dashboard is a single self-contained HTML file at `<project>/opensip-tools/.runtime/reports/latest.html`. Each generation overwrites the previous file. The command launches the browser and exits; the file works without opensip-tools installed, so you can email it directly to a teammate.

**See also:** [`70-reference/06-dashboard.md`](/docs/opensip-tools/70-reference/06-dashboard/), [`80-implementation/03-session-and-persistence.md`](/docs/opensip-tools/80-implementation/03-session-and-persistence/).

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
  "totalCount": 115
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

## `fit-baseline-export` — export fit gate baseline as SARIF

Tool-owned (fitness Tool). Exports the stored fit gate baseline (the violation set saved by `fit --gate-save`) from the SQLite datastore to a SARIF file. Used to promote a local baseline into CI or to feed GitHub Code Scanning.

```
opensip-tools fit-baseline-export --out fit.sarif
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--out <path>` | path | — | **Required.** Output file path for the SARIF baseline. |
| `--cwd <path>` | path | `process.cwd()` | Project root. |
| `--json` | bool | `false` | Emit a JSON result envelope on stdout instead of the human-readable summary. |

The dogfood CI uses this command to write `fit.sarif` after a `fit --gate-save` step, then uploads it to GitHub Code Scanning. Exits non-zero with a `result.exitCode` if no baseline is stored or the write fails.

---

## `init` — scaffold the project layout

CLI-owned: [`packages/cli/src/commands/init.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/cli/src/commands/init.ts).

```
opensip-tools init
opensip-tools init --language <list>
opensip-tools init --keep
opensip-tools init --remove
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

The scaffold output is loose `.mjs` files — the lightest-weight starting point. When a pack outgrows loose files (substantial helpers, tests, more than a dozen checks/scenarios), the customer graduates `opensip-tools/<domain>/` to a workspace npm package by adding a `package.json` with `opensipTools.kind: "fit-pack"` (or `"sim-pack"`) and an `index.ts`. Marker-based discovery picks up the workspace package automatically. See [`50-extend/01-plugin-authoring.md`](/docs/opensip-tools/50-extend/01-plugin-authoring/) for the graduation path.

| Flag | Effect |
|---|---|
| `--language <list>` | Comma-separated language list (`typescript,rust`). Overrides detection. |
| `--keep` | Re-scaffold examples; preserve any custom files in `opensip-tools/`. |
| `--remove` | Delete `opensip-tools/` entirely, then scaffold fresh. |
| `--cwd <path>` | Target directory (default: `process.cwd()`). |
| `--json` | Emit a structured JSON result instead of the human-readable summary. |
| `--debug` | Enable debug-level logging. |

### Partial-state handling

After parsing flags init classifies the working directory into one of four states:

| State | `opensip-tools.config.yml` | `opensip-tools/` (excluding `.runtime/`) | Default | `--keep` | `--remove` |
|---|---|---|---|---|---|
| `pristine` | absent | absent | scaffold | scaffold | scaffold |
| `fully-initialized` | present | present | exit 2, partial-state error | re-scaffold; preserve custom | `rm -rf opensip-tools/`; scaffold |
| `partial-config-only` | present | absent | exit 2, partial-state error | scaffold the dir | scaffold the dir |
| `partial-dir-only` | absent | present | exit 2, partial-state error | preserve custom; write YAML | `rm -rf opensip-tools/`; write YAML; scaffold |

`--keep` and `--remove` are mutually exclusive. The legacy `--force`
flag is removed; users who scripted it should migrate to `--remove`
(closest semantic match — both blow away existing scaffolds).

Each pre-existing file under `opensip-tools/` is classified as:

- `scaffolded` — content matches a current-template byte-for-byte.
- `stale-scaffolded` — was scaffolded for a language not in the current
  detection set (e.g. `example-check-rust.mjs` after re-running with
  `--language typescript`). Preserved by `--keep`.
- `custom` — anything else (user-authored).

The `InitResult` JSON shape carries `state`, `preExistingFiles[]`, and
(on refusal) `partialStateError` so machine consumers can branch.

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

CLI-owned: [`packages/cli/src/commands/configure.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/cli/src/commands/configure.ts). Interactive — sets up the OpenSIP Cloud API key in `~/.opensip-tools/config.yml`.

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

**See also:** [`80-implementation/03-session-and-persistence.md`](/docs/opensip-tools/80-implementation/03-session-and-persistence/).

---

## `plugin add/remove/list/sync` — manage project-pinned plugins

CLI-owned: [`packages/cli/src/commands/plugin.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/cli/src/commands/plugin.ts).

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

**See also:** [`80-implementation/02-plugin-loader.md`](/docs/opensip-tools/80-implementation/02-plugin-loader/).

---

## `completion` — print shell completion script

CLI-owned: [`packages/cli/src/commands/completion.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/cli/src/commands/completion.ts).

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

The completion catalog is sourced from the per-invocation `ToolRegistry.list()`, so installed third-party tools' commands complete automatically once the script is regenerated.

---

## `uninstall` — remove opensip-tools state

CLI-owned: [`packages/cli/src/commands/uninstall.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/cli/src/commands/uninstall.ts).

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

State contract enforced by code: `~/.opensip-tools/` holds `config.yml` only. Persistence and logging modules throw when asked to write there (see [`paths.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/core/src/lib/paths.ts), [`logger.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.2.1/packages/core/src/lib/logger.ts)). Anything else in that directory is legacy cruft from pre-1.0 versions and is swept up by the default `uninstall`.

---

## What's next

- **[`../50-extend/01-plugin-authoring.md`](/docs/opensip-tools/50-extend/01-plugin-authoring/)** — write a check, recipe, scenario, or full Tool plugin.
- **[`06-dashboard.md`](/docs/opensip-tools/70-reference/06-dashboard/)** — the HTML report's structure and lifecycle.
- **[`../70-reference/03-configuration.md`](/docs/opensip-tools/70-reference/03-configuration/)** — every field of `opensip-tools.config.yml`.
