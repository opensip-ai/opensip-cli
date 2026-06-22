---
status: current
last_verified: 2026-06-15
release: v0.1.10
title: "CLI command tree"
audience: [users, ci-integrators, contributors]
purpose: "Lookup-shaped reference for user-facing CLI commands, important machine-facing commands, flags, and exit semantics."
source-files:
  - packages/cli/src/index.ts
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/configure.ts
  - packages/cli/src/commands/plugin.ts
  - packages/cli/src/commands/tools/index.ts
  - packages/cli/src/commands/uninstall.ts
  - packages/cli/src/commands/completion.ts
  - packages/fitness/engine/src/tool.ts
  - packages/simulation/engine/src/tool.ts
  - packages/graph/engine/src/tool.ts
related-docs:
  - ../80-implementation/01-cli-dispatch.md
  - ../70-reference/03-configuration.md
---
# CLI command tree

The user-facing command tree, plus the machine-facing graph export and worker commands that matter to integrators. Use this when you need to look up a flag, not when you're learning what a command is for. For "why", read the relevant subsystem doc.

The grouping mirrors the source split: tool-owned commands (`fit`, `sim`, `graph`, and their nested `<tool> <verb>` children — `fit list`, `fit recipes`, `graph lookup`, etc.) come from each Tool's declared `commandSpecs` (mounted by the host). CLI-owned commands (`init`, `report`, `sessions`, the per-tool `<tool> plugin` group, `configure`, `agent-catalog`, `completion`, `uninstall`) live under [`packages/cli/src/commands/`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/cli/src/commands/). For the Tier-1/2/3 grammar, export `--format` convention, and internal visibility rules, see [Command surface taxonomy](/docs/opensip-cli/50-extend/07-command-taxonomy/).

---

## Top-level

```
opensip                          # show welcome banner + next steps
opensip --version                # print version, exit
opensip --help                   # print full help, exit
opensip <command> --help         # per-command help
```

Per-command flags that appear on most subcommands. The flags shared across the
tool run commands (`fit`/`sim`/`graph`) — `--json`, `--cwd`, `-q/--quiet`,
`-v/--verbose`, `--debug`, `--report-to`, and `--api-key` — are declared
**once** in a common-flag registry and applied via `applyCommonFlags`, so their
names, short aliases, descriptions, and defaults are identical where applied and
cannot drift (ADR-0021). `fit` and `sim` also expose `--open` for HTML report
auto-open; `graph` writes report data and uses the separate `report`
command to open the report. `-v/--verbose` is a uniform "show the detailed
report body" flag whose output is identical in a TTY and a pipe.

**Host-guaranteed tool-primary surface.** The host mount layer guarantees a
uniform baseline on **every** tool primary (`fit`/`graph`/`sim`, and any
third-party tool's run verb) — a tool need not opt in. Each primary always
carries `--cwd`, `--json`, `--config`, `--quiet`, `--verbose`, and its own
`--version`:

- `opensip <tool> --version` prints the **tool's** version (`<verb> <semver>`,
  e.g. `fit 0.1.6`, plus a `(tool contract v<n>)` marker when the tool declares
  one). This is distinct from `opensip --version`, which prints the **CLI**
  version.
- `--config <path>` (the explicit `opensip-cli.config.yml` override) is now on
  every tool primary, not just `fit`.

The only `program`-level (root) options are `--version` (the CLI version) and
`--no-cloud`. The root `--version` is host-owned and must precede any
subcommand (`opensip --version`); a `--version` **after** a subcommand is that
tool's own:

| Flag | Effect |
|---|---|
| `--version` | At the root (`opensip --version`): the CLI version. After a tool verb (`opensip fit --version`): that tool's version. |
| `--config <path>` | Path to `opensip-cli.config.yml` (overrides the package.json pointer and default discovery). Guaranteed on every tool primary. |
| `--debug` | Enable debug-level logging (events of `debug` level appear in stderr and the run log file). |
| `--quiet` | Suppress banner / boxes; print only the pass/fail summary line. (Where supported.) |
| `--cwd <path>` | Override the project root (default: `process.cwd()`). Registered on `init`, `fit`, `sim`, `graph`, and the `<tool> plugin <subcmd>` commands. |
| `--json` | Emit structured JSON on stdout instead of the table renderer. (Per-command — `init`, `fit`, `sim`, `graph`.) |
| `--no-cloud` | Disable OpenSIP Cloud signal sync for this run (program-level). See below. |

Global startup/admission failures can occur before any subcommand body runs.
Most configuration failures exit 2; a project-authored Tool sidecar rejected by
the compatibility/trust gate exits 5 (`PLUGIN_INCOMPATIBLE`) before its module
is imported.

### OpenSIP Cloud signal sync

OpenSIP Cloud sync is optional. This repo ships the CLI client and the
`SignalBatch` wire contract; sync runs only when an OpenSIP API key and a
compatible endpoint are configured. Without a key, the CLI remains fully local.

When configured (an OpenSIP API key via `opensip configure` or
`OPENSIP_API_KEY`) **and** entitled to the cloud storage tier, each `fit`
and `graph` run additionally emits its **signals** (the findings it already
produces) to OpenSIP Cloud for storage. This is **additive and best-effort**:
results are always written to the local SQLite store first, and a cloud failure
never blocks, slows, or fails a run. On a successful sync you'll see
`✓ Sent N signals to OpenSIP Cloud`.

For `graph`, every human-facing mode emits — the default render, `--gate-save`/
`--gate-compare`, and `--report-to`. Two modes do not emit: plain `--json`
(a machine-artifact stream, also the carrier each `--workspace` child runs under)
and `--workspace` itself (the parent aggregates per-unit findings for the
dashboard, not signals). The separate `graph export --format catalog` command is a catalog dump
for the parent ingestor, not a signal-emitting run. Run a whole-project `graph`
to sync.

What is sent: each signal's file path, message, suggestion, code-location
hints, and rule metadata. Nothing is sent for users without an API key or
without the entitlement.

Opt out machine-wide in your user config `~/.opensip-cli/config.yml` (flat,
alongside `apiKey`):

```yaml
cloud:
  sync: false               # disables signal sync for every project on this account
  endpoint: https://...     # optional https override of the built-in URL
```

Or per project in `opensip-cli.config.yml` under `cli.cloud:` (same fields).
A `sync: false` in **either** place disables sync — the more restrictive
setting wins. Or opt out per-run with `--no-cloud`.

This is distinct from `--report-to`: that path explicitly POSTs **SARIF** to
**any** receiver (and can fail a CI build via exit 4), whereas cloud sync emits
**native signals** to **OpenSIP Cloud** automatically and best-effort.

---

## `fit` — run fitness checks

Tool-owned: [`packages/fitness/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/fitness/engine/src/tool.ts).

```
opensip fit
opensip fit --recipe <name>
opensip fit --check <slug>
opensip fit --tags <list>
opensip fit --gate-save
opensip fit --gate-compare
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--recipe <name>` | string | `default` | Use a named recipe. Built-in `default` runs every enabled check. |
| `--check <slug>` | string | — | Run a single check by slug. Mutually informative with `--recipe`. |
| `--tags <list>` | repeatable / comma-list | `[]` | Filter checks by tag (intersected with the recipe's selector). Repeatable (`--tags a --tags b`) or comma-separated (`--tags a,b`). |
| `--exclude <slug>` | repeatable | `[]` | Exclude check by slug. Can be passed multiple times. |
| `--list` | bool | `false` | List available checks instead of running. |
| `--recipes` | bool | `false` | List available recipes instead of running. |
| `--show <session>` | string | — | Replay a stored fit session (by id, or `latest`) instead of running — see [`sessions show`](#sessions-list-sessions-show-and-sessions-purge--manage-session-records). |
| `--json` | bool | `false` | Emit the `CommandOutcome` JSON on stdout (envelope under `.envelope`) instead of the table renderer. |
| `-v, --verbose` | bool | `false` | Show the detailed report body (per-check findings) inline. Renders identically in a TTY and a pipe (ADR-0021). |
| `--report-to <url>` | URL | — | POST findings to OpenSIP Cloud or a compatible endpoint. |
| `--api-key <key>` | string | — | API key for `--report-to`. |
| `--gate-save` | bool | `false` | Save current findings as architecture baseline rows in the project's SQLite store (the host-owned `tool_baseline_entries` table, scoped `tool = 'fitness'`, at `opensip-cli/.runtime/datastore.sqlite`; ADR-0036), then exit per the `failOnErrors`/`failOnWarnings` thresholds (ADR-0020 — the save happens before the exit, so the baseline survives a failing gate). |
| `--gate-compare` | bool | `false` | Compare current findings against baseline; exit 1 on regression (toggle with the reserved `failOnDegraded` key, default on). |
| `-q, --quiet` | bool | `false` | Suppress banner. |
| `--open` | bool | `false` | Launch the HTML report after run. |
| `--config <path>` | path | discovered | Override the `opensip-cli.config.yml` location (defaults to the project's config or the package.json pointer). |
| `--cwd <path>` | path | `process.cwd()` | Target directory. |
| `--debug` | bool | `false` | Enable debug-level logging. |

**Mutual exclusion:** `--gate-save` and `--gate-compare` cannot be combined.

**Exit codes:** 0 (passed), 1 (violations or regression), 2 (configuration error, including an unknown explicit `--check` slug), 4 (`--report-to` upload failure), 5 (a project-authored Tool sidecar was rejected before import). Exit code 3 is reserved by the shared typed-error table for `CHECK_NOT_FOUND`, but the current `fit --check <missing>` path treats explicit check selection as invalid configuration and exits 2. A `--report-to` upload failure exits 4 — but only when the run otherwise passed; a check/gate failure (1) or configuration error (2) takes precedence and is never masked by a reporting failure. This matches `graph` and the canonical exit-code contract.

**See also:** [`20-fit/04-output-gate-sarif.md`](/docs/opensip-cli/20-fit/04-output-gate-sarif/), [`10-concepts/05-architecture-gate.md`](/docs/opensip-cli/10-concepts/05-architecture-gate/).

---

## `sim` — run simulation scenarios

Tool-owned: [`packages/simulation/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/simulation/engine/src/tool.ts).

```
opensip sim
opensip sim --recipe <name>
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--recipe <name>` | string | built-in `default` | Run a named sim recipe. |
| `--show <session>` | string | — | Replay a stored sim session (by id, or `latest`) instead of running — see [`sessions show`](#sessions-list-sessions-show-and-sessions-purge--manage-session-records). |
| `--cwd <path>` | path | `process.cwd()` | Target directory. |
| `--json` | bool | `false` | Emit the `CommandOutcome` JSON on stdout (envelope under `.envelope`) instead of the table renderer. |
| `-v, --verbose` | bool | `false` | Show the detailed report body (per-scenario findings) inline. Renders identically in a TTY and a pipe (ADR-0021). |
| `-q, --quiet` | bool | `false` | Suppress banner. |
| `--open` | bool | `false` | Launch the HTML report after run. |
| `--report-to <url>` | URL | — | POST findings to OpenSIP Cloud or a compatible endpoint. |
| `--api-key <key>` | string | — | API key for `--report-to`. |
| `--debug` | bool | `false` | Enable debug-level logging. |

**Exit codes:** 0 (all scenarios passed), 1 (any scenario failed), 2 (config/runtime error, **including a run that selected zero scenarios** — an empty run fails closed rather than reporting a false pass: no scenario packages installed, or the recipe selector matched none). Exit 0 therefore always means at least one scenario ran and passed.

**See also:** [`30-sim/`](/docs/opensip-cli/30-sim/).

---

## `graph` — static call-graph + dead-end analysis

Tool-owned: [`packages/graph/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/graph/engine/src/tool.ts). The pipeline architecture and cache invalidation are documented in [`40-graph/01-stages-and-catalog.md`](/docs/opensip-cli/40-graph/01-stages-and-catalog/); perf-plan history is recoverable from `git -P log -- packages/graph`.

```
# Whole project (language auto-detected)
opensip graph

# Scope to a single subtree
opensip graph packages/core

# Scope to multiple subtrees (one session aggregates results)
opensip graph packages/core packages/cli

# Shell glob expansion (the shell expands; opensip-cli doesn't)
opensip graph 'packages/*/src'

# Fan out across detected workspace units (memory-isolated)
opensip graph --workspace
opensip graph --workspace --concurrency 4

# Force a specific language adapter (suppresses auto-detection)
opensip graph --language typescript
opensip graph --language python packages/services/api

# Other modes
opensip graph --json
opensip graph --no-cache
opensip graph --exact          # force the single-program exact engine (default is the sharded engine)
opensip graph --gate-save
opensip graph --gate-compare
opensip graph --gate-save --sarif graph.sarif   # gate + SARIF 2.1.0 for Code Scanning
opensip graph --report-to <url>

# Scope to a named recipe (a subset of graph rules; default = all rules)
opensip graph --recipe <name>

# List the source files graph would discover for this scope — no build
opensip graph --list-files
opensip graph --list-files --json       # machine-readable: { count, files }
opensip graph --list-files --workspace  # the per-unit fan-out set
```

`graph` is the single entry point for static call-graph analysis. The default (non-JSON) output is a one-line summary; pass `-v`/`--verbose` to expand the structured terminal report into its detailed sections: catalog summary, findings grouped by rule (top 10 per rule, with overflow indicator), and top 10 inferred entry points. The full data is always available via `--json`.

| Flag / Argument | Type | Default | Effect |
|---|---|---|---|
| `[paths...]` | path(s) | — | Positional. Scope the run to one or more existing directories (absolute or relative to `--cwd`). Multiple paths aggregate into a single report session per D12. The shell handles globs (`graph 'packages/*/src'`); no glob expansion happens inside the CLI. Mutually exclusive with `--workspace`. |
| `--cwd <path>` | string | `process.cwd()` | Target directory. Adapter is auto-detected by marker files (TypeScript: `tsconfig.json`/`package.json`; Python: `pyproject.toml`/`setup.py`/`setup.cfg`; Rust: `Cargo.toml`; Go: `go.mod`; Java: `pom.xml`/`build.gradle*`). Polyglot repos apply every matched adapter simultaneously (D6). |
| `--workspace` | bool | `false` | Fan the run across every workspace unit returned by each detected adapter's `discoverWorkspaceUnits` hook. Polyglot per D8b: a repo with both a TS pnpm workspace and a Cargo workspace fans out across both adapters' units in one combined run. Memory-isolated (one child process per unit). Mutually exclusive with positional paths. |
| `--concurrency <n>` | int | `cpus()-1` | Concurrency cap for `--workspace` child processes. |
| `--language <name>` | string | — | Force a specific language adapter, suppressing marker-based auto-detection. If the discovered file count is zero, exits with code 2 and the message `--language <name> matched 0 files under <paths>; check the flag or paths.` (D14). |
| `--json` | bool | `false` | Output the `CommandOutcome` JSON document (envelope under `.envelope`) instead of the unified terminal report. |
| `--no-cache` | bool | `false` | Skip the catalog cache and force a full rebuild. |
| `--exact` | bool | `false` | Use the single-program **exact** build engine instead of the default parallel **sharded** engine. Sharded is the default on shardable (multi-package) repos; both engines resolve cross-package edges through **one shared model** (exact = the 1-shard case), held equivalent by a **directional** equivalence guardrail + a pinned-corpus completeness floor (ADR-0033). `--exact` forces the single-program engine and suits small / single-package repos. A repo that can't shard already uses exact, no flag needed. Engine choice is deterministic and never depends on `isTTY` (a terminal and CI build the same catalog). |
| `--resolution <mode>` | string | `exact` | Edge resolution tier: `exact` (semantic, uses the type checker) or `fast` (syntactic, no type checker — ~2× faster cold builds at lower edge fidelity). Invalid values fail loudly at the boundary. Note: `--resolution` (edge tier) is orthogonal to `--exact` (build engine). |
| `--profile <path>` | path | — | Write a graph performance profile JSON artifact with stage timings, run mode, cache verdict, file/function counts, and resolution stats. Relative paths resolve against `--cwd`. |
| `--recipe <name>` | string | — | Run a named graph recipe — a subset of the graph rule set. Default (no flag): all rules. An unknown name fails with a configuration error. List recipes with `graph recipes`. |
| `--show <session>` | string | — | Replay a stored graph session (by id, or `latest`) instead of building — see [`sessions show`](#sessions-list-sessions-show-and-sessions-purge--manage-session-records). |
| `--gate-save` | bool | `false` | Save the current Signal fingerprint set as baseline rows in the project's SQLite store (the host-owned `tool_baseline_entries` table, scoped `tool = 'graph'`; ADR-0036), then exit per graph's fail thresholds — the save happens before the exit. Mutually exclusive with `--gate-compare`. |
| `--gate-compare` | bool | `false` | Compare current Signals to the saved baseline; exit non-zero on regression (toggle with the reserved `failOnDegraded` key, default on). |
| `--sarif <path>` | path | — | Also write this run's findings as a SARIF 2.1.0 file (for GitHub Code Scanning) via the shared `cli.writeSarif` envelope→SARIF seam — the same producer `fit --report-to`/`fit export --format baseline` use. Composes with `--gate-save`: the SARIF is written in the action body after the gate sets its exit code, so the file lands even when the gate fails. Relative paths resolve against `--cwd`. |
| `--report-to <url>` | string | — | POST findings to OpenSIP Cloud or a compatible endpoint. |
| `--api-key <key>` | string | — | API key for `--report-to`. |
| `-v, --verbose` | bool | `false` | Expand the done view to show the detailed catalog, findings-by-rule, and entry-point sections (default: one-line summary only). Renders identically in a TTY and a pipe (ADR-0021). |
| `-q, --quiet` | bool | `false` | Suppress banner / boxes; print only the pass-fail summary line. |
| `--list-files` | bool | `false` | Discovery-only: resolve and print the source-file set this scope would analyze (whole project, positional subtrees, or `--workspace` fan-out) and exit — no catalog build. Reuses the adapter's stage-0 discovery, so the list is faithful to a real run (`.d.ts` excluded, TypeScript extension-priority collisions collapsed, per-tsconfig `include`/`exclude` honored). Composes with `[paths...]`, `--workspace`, and `--language`; `--json` emits `{ count, files }`. |
| `--debug` | bool | `false` | Enable debug-mode structured log output. |

**Inspecting discovery (`--list-files`).** `graph` does not enumerate files the way a filesystem walk would — it asks the language adapter, which for TypeScript means the set the `tsconfig` resolves (so `.d.ts` is excluded, an extension-priority collision like a `foo.tsx` shadowed by a sibling `foo.ts` is collapsed to the `.ts`, and each package's `include`/`exclude` is honored). `--list-files` prints exactly that set for the chosen scope and exits before any catalog build, which makes it the cheap, authoritative answer to "what does graph actually see?" The whole-project list and the `--workspace` list can legitimately differ — the latter is the union of per-package `tsconfig`s, which may exclude paths (e.g. `__fixtures__`, root scripts, out-of-`src` files) the root tree includes. To diff graph's view against the VCS:

```
opensip graph --list-files --json | jq -r '.files[]' | sort > /tmp/graph.txt
git ls-files '*.ts' '*.tsx' | sort > /tmp/git.txt
comm -23 /tmp/git.txt /tmp/graph.txt   # tracked but NOT discovered
comm -13 /tmp/git.txt /tmp/graph.txt   # discovered but NOT tracked
```

**Polyglot example.** In a repo with both a TypeScript pnpm workspace and a Cargo workspace, the polyglot detection applies both adapters in a single run:

```
# Polyglot repo: TS frontend + Cargo backend
# `--workspace` aggregates units from BOTH adapters and fans out in parallel.
opensip graph --workspace
# → one report session combining TS package results + Cargo member results
```

**Session contract.** A single CLI invocation produces a single report session, regardless of how many positional paths or workspace units the run analyzed. Modes that produce machine-readable artifacts instead of report sessions (`--json`, `--gate-save`, `--gate-compare`, `--report-to`) opt out. Machine-artifact catalog/SARIF exports live on the dedicated `graph export --format catalog` / `graph export --format sarif` commands.

**Adapter selection.** opensip-cli ships first-party graph adapters for TypeScript, Python, Rust, Go, and Java — each is its own publishable npm package under the `@opensip-cli/graph-*` namespace. Default auto-discovery is marker-based and descriptor-driven: `node_modules` is walked for packages whose `package.json` declares `opensipTools.kind: "graph-adapter"` (built-ins resolve from the CLI install tree). You can pin an exact adapter set under `plugins.graphAdapters:` in `opensip-cli.config.yml`; when set, that list replaces auto-discovery. `plugins.autoDiscoverGraphAdapters: false` disables the scan. Marker-file detection (`tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`/`build.gradle*`) then chooses which discovered adapter(s) apply to the run; positional paths inherit that decision unless `--language` overrides it.

**Exit codes:** 0 (success / gate clean), 1 (runtime error / gate regression / any `--workspace` child failed), 2 (configuration error / D14 zero-file mismatch), 4 (`--report-to` upload failed), 5 (a project-authored Tool sidecar was rejected before import).

**Heap sizing:** for projects with > 1000 source files, `graph` emits a one-line stderr hint at startup recommending `NODE_OPTIONS=--max-old-space-size=8192` (or higher). On a 5476-file repo the default 4 GB heap is not enough for a global run. The preflight skips automatically when an explicit scope is present (positional paths, `--workspace`, or `--language`). (Heap sizing is most acute for the TypeScript adapter, which holds a project-wide `ts.Program`; tree-sitter adapters parse lazily per file and use far less memory.)

**`OPENSIP_HEAP_NO_MONITOR`** (env var): during a build, `graph` runs a V8 heap-pressure monitor that aborts with a readable `MemoryPressureError` when old-gen usage crosses ~90% of the heap limit — catching an impending OOM before V8 SIGABRTs the process. In unusual GC scenarios (REPL embedding, custom allocators) this guard can fire as a false positive before a real OOM is imminent. Set `OPENSIP_HEAP_NO_MONITOR=1` to disable it entirely. This is an escape hatch only: with the monitor off, an actual out-of-memory condition becomes a bare V8 abort instead of a structured error. Prefer raising the heap ceiling (above) or scoping the run (positional paths / `--workspace`) first.

**Catalog storage:** graph stores the catalog in the project's SQLite database
(`<project>/opensip-cli/.runtime/datastore.sqlite`, `graph_catalog` row). The
wire format carries `language` (adapter id), `cacheKey` (an opaque per-adapter
invalidation string — TypeScript: `ts-${ts.version}-${tsconfigContentHash}`;
Python and Rust use language-id-prefixed keys), and a per-file mtime+size
fingerprint. The reconstructed in-memory `Catalog` shape is what graph rules,
indexes, and report views consume.

**Cache behavior:** three verdicts — `valid` (full cache hit), `incremental` (re-walk only the changed files plus their transitive edge-dependents), `invalid` (full rebuild). The incremental path makes single-file edits ~6× faster than a `--no-cache` rebuild while producing byte-identical output. See the cache section in the stages-and-catalog doc.

**Entry-point reasons** (rendered in the entry-points section): `module-init` (every file's top-level statements), `name-match` (`main` / `run` / `start` / `register` / `init` / `bootstrap` / `initialize`), `no-callers-exported` (exported with no in-project caller). Bin-entry and tool-registration heuristics are deferred to v0.3.

> **History.** v0.2 originally registered three subcommands — `graph`, `graph-orphans`, and `graph-entry-points`. The two filtered views were folded into the unified `graph` output; all three data slices (rules, entry points, catalog summary) are now reachable from the single `graph` invocation.

---

## `graph lookup` — look up function occurrences by name

Tool-owned (graph Tool). Queries the persisted catalog in the project's datastore for every function occurrence whose simple name matches the argument. Useful for "where is `saveBaseline` defined?" probes without re-running the full graph build.

```
opensip graph lookup <name>
opensip graph lookup <name> --json
```

| Flag / Argument | Type | Default | Effect |
|---|---|---|---|
| `<name>` | string | — | Positional. Function simple name to look up (e.g. `saveBaseline`). Required. |
| `--json` | bool | `false` | Output structured JSON instead of the human-readable list. |

The command reads from the catalog stored in `<project>/opensip-cli/.runtime/datastore.sqlite`. Run `opensip graph` at least once first to populate the catalog.

---

## `graph index` — emit symbol index artifact

Tool-owned (graph Tool). Writes a `symbolindex.json` file: two maps — `name → [{ file, line }, …]` and `file → [name, …]`. Intended for editor tooling and offline cross-reference.

By default the command **queries** the persisted catalog only (like `graph lookup`, it does not run analysis). Pass `--build` to run the graph pipeline first and refresh the catalog before emitting.

```
opensip graph index
opensip graph index --out path/to/symbolindex.json
opensip graph index --build
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--build` | bool | `false` | Run the graph pipeline to refresh the catalog before emitting the index. |
| `--cwd <path>` | path | `process.cwd()` | Target directory; `--out` resolves against this. |
| `--out <path>` | path | `symbolindex.json` | Output file path. |

Without `--build`, reads from the persisted catalog; run `opensip graph` or `opensip graph index --build` first if no catalog exists.

---

## `graph export --format baseline` — export graph gate baseline

Tool-owned (graph Tool). Exports the stored graph gate baseline (the Signal fingerprint set saved by `graph --gate-save`) from the SQLite datastore to a portable JSON file. Mirrors `fit export --format baseline` for the graph tool. (The `catalog` and `sarif` formats of `graph export` are the full-pipeline machine exports documented under [Internal and machine-facing commands](#internal-and-machine-facing-commands).)

```
opensip graph export --format baseline --out graph-baseline.json
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--format <fmt>` | enum | — | **Required.** `baseline` (the gate fingerprint JSON), `catalog`, or `sarif`. |
| `--out <path>` | path | — | **Required for `--format baseline`.** Output file path for the JSON baseline. |
| `--cwd <path>` | path | `process.cwd()` | Target directory. |
| `--json` | bool | `false` | Emit a JSON result envelope on stdout instead of the human-readable summary. |

Exit codes: 0 on success, non-zero with a `result.exitCode` if the baseline is missing or the write fails. Useful for promoting a local baseline into CI or sharing one across machines without copying the SQLite file.

---

## `graph recipes` — catalog graph recipes

Tool-owned (graph Tool). Mirrors `fit recipes` for the graph tool: prints the loaded graph-recipe inventory (a graph recipe is a named subset of the graph rule set). Reuses the shared `ListRecipesResult` contract and renderer.

```
opensip graph recipes
opensip graph recipes --json
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--json` | bool | `false` | Output structured JSON instead of the human-readable list. |

JSON shape (same `list-recipes` result envelope as `fit recipes`):

```json
{
  "type": "list-recipes",
  "recipes": [
    { "name": "default", "description": "...", "checkCount": "all rules" }
  ]
}
```

`checkCount` is a free-form label reused as a rule count — `"all rules"` for an `all` selector, `"<n> rules"` for an explicit selector, `"pattern-based"` otherwise.

---

## `graph list` — catalog graph rules

Tool-owned (graph Tool). Prints the loaded graph-rule inventory (the analog of `fit list`, which lists checks). Reuses the shared `list-checks` result envelope and renderer.

```
opensip graph list
opensip graph list --json
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--json` | bool | `false` | Output structured JSON instead of the human-readable list. |

---

## `report` — open the HTML report

CLI-owned. The cross-tool `report` command lives at the CLI layer (not inside any one tool) because composition walks every tool's `collectReportData` contribution via the tool registry. Renders the most recent run as HTML and opens it in the user's default browser.

```
opensip report
opensip report --no-open
opensip report --json
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--no-open` | bool | `false` | Write the report but do not launch a browser. |
| `--json` | bool | `false` | Emit a `{ type: 'report', path, opened }` JSON envelope on stdout instead of the table renderer. In `--json` mode the browser is never launched (machine-output contract). |

The report is a single self-contained HTML file at `<project>/opensip-cli/.runtime/reports/latest.html`. Each generation overwrites the previous file. The command launches the browser and exits; the file works without opensip-cli installed, so you can email it directly to a teammate.

**See also:** [`70-reference/06-dashboard.md`](/docs/opensip-cli/70-reference/06-dashboard/), [`80-implementation/03-session-and-persistence.md`](/docs/opensip-cli/80-implementation/03-session-and-persistence/).

---

## `fit list` — catalog checks

Tool-owned. Prints the loaded check inventory: slug, description, tags.

```
opensip fit list
opensip fit list --json
```

JSON shape:

```json
{
  "type": "list-checks",
  "checks": [{ "slug": "...", "description": "...", "tags": ["..."] }],
  "totalCount": 151
}
```

Useful for scripting (`opensip fit list --json | jq '.checks[].slug'`) and for verifying that an `opensip fit plugin add` actually registered the new pack's checks. `totalCount` is the loaded inventory for the current project, so it increases when project-local checks or installed packs are present.

---

## `fit recipes` — catalog recipes

Tool-owned. Prints the loaded recipe inventory.

```
opensip fit recipes
opensip fit recipes --json
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

## `fit export --format baseline` — export fit gate baseline as SARIF

Tool-owned (fitness Tool). Exports the stored fit gate baseline (the violation set saved by `fit --gate-save`) from the SQLite datastore to a SARIF file. Used to promote a local baseline into CI or to feed GitHub Code Scanning.

```
opensip fit export --format baseline --out fit.sarif
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--format <fmt>` | enum | — | **Required.** `baseline` — the SARIF-shaped gate baseline. |
| `--out <path>` | path | — | **Required.** Output file path for the SARIF baseline. |
| `--cwd <path>` | path | `process.cwd()` | Project root. |
| `--json` | bool | `false` | Emit a JSON result envelope on stdout instead of the human-readable summary. |

The dogfood CI uses this command to write `fit.sarif` after a `fit --gate-save` step, then uploads it to GitHub Code Scanning. Exits non-zero with a `result.exitCode` if no baseline is stored or the write fails.

---

## `init` — scaffold the project layout

CLI-owned: [`packages/cli/src/commands/init.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/cli/src/commands/init.ts).

```
opensip init
opensip init --language <list>
opensip init --keep
opensip init --remove
```

Detects the project's primary language(s) from filesystem markers and writes one
directory tree per **registered tool** — each tool owns its own example files and
config block; `init` itself hardcodes no tool. With the bundled fitness +
simulation tools, a project gets:

```
<cwd>/opensip-cli.config.yml                              # TRACKED
<cwd>/opensip-cli/fit/checks/example-check.mjs            # TRACKED
<cwd>/opensip-cli/fit/recipes/example-recipe.mjs          # TRACKED
<cwd>/opensip-cli/sim/scenarios/example-scenario.mjs      # TRACKED
<cwd>/opensip-cli/sim/recipes/example-recipe.mjs          # TRACKED
```

Plus appends `opensip-cli/.runtime/` to `<cwd>/.gitignore`.

The scaffolded set equals the **registered** set: a tool that declares no project
layout (e.g. `graph`) writes no directory, and a tool installed *after* `init`
scaffolds its examples on the next `opensip init --keep`. If a bundled tool
fails to load, `init` scaffolds fewer directories and emits a loud
`cli.tool.expected_bundled_absent` diagnostic so the gap is visible.

The scaffold output is loose `.mjs` files — the lightest-weight starting point. When a pack outgrows loose files (substantial helpers, tests, more than a dozen checks/scenarios), the customer graduates `opensip-cli/<domain>/` to a workspace npm package. Fit packs add `opensipTools.kind: "fit-pack"` and load through marker discovery; sim scenario packs use the `<scope>/scenarios-*` package-name pattern or an explicit `plugins.scenarioPackages:` pin. See [`50-extend/01-plugin-authoring.md`](/docs/opensip-cli/50-extend/01-plugin-authoring/) for the graduation path.

| Flag | Effect |
|---|---|
| `--language <list>` | Language list (`typescript`, `rust`, …). Repeatable (`--language ts --language rust`) or comma-separated (`--language ts,rust`). Overrides detection. |
| `--keep` | Re-scaffold examples; preserve any custom files in `opensip-cli/`. |
| `--remove` | Delete `opensip-cli/` entirely, then scaffold fresh. |
| `--cwd <path>` | Target directory (default: `process.cwd()`). |
| `--json` | Emit a structured JSON result instead of the human-readable summary. |
| `--debug` | Enable debug-level logging. |

### Partial-state handling

After parsing flags init classifies the working directory into one of four states:

| State | `opensip-cli.config.yml` | `opensip-cli/` (excluding `.runtime/`) | Default | `--keep` | `--remove` |
|---|---|---|---|---|---|
| `pristine` | absent | absent | scaffold | scaffold | scaffold |
| `fully-initialized` | present | present | exit 2, partial-state error | re-scaffold; preserve custom | `rm -rf opensip-cli/`; scaffold |
| `partial-config-only` | present | absent | exit 2, partial-state error | scaffold the dir | scaffold the dir |
| `partial-dir-only` | absent | present | exit 2, partial-state error | preserve custom; write YAML | `rm -rf opensip-cli/`; write YAML; scaffold |

`--keep` and `--remove` are mutually exclusive. Use `--remove` when you want to
replace existing scaffolds.

Each pre-existing file under `opensip-cli/` is classified as:

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

CLI-owned: [`packages/cli/src/commands/configure.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/cli/src/commands/configure.ts). Interactive — writes the OpenSIP Cloud API key to `~/.opensip-cli/config.yml` and verifies it best-effort against the cloud entitlement endpoint.

```
opensip configure
```

Prompts:
1. If a key is already configured, show its masked value.
2. Ask for a new OpenSIP Cloud API key.
3. If the prompt is blank, cancel without changing the file.
4. Save the key to `~/.opensip-cli/config.yml`.
5. Test the key against the cloud entitlement endpoint. Verification is best-effort; the key stays saved if the endpoint is unreachable so offline setup still works.

The user-level config is shared across every project on the machine. `opensip fit --report-to <url>` uses the configured key by default unless `--api-key` overrides it.

---

## `agent-catalog` — structured discovery surface for agents

CLI-owned. A machine-first command that emits a self-describing catalog of the most useful commands, flags, and patterns for AI agents, with emphasis on the sessions/history surface and the agent ergonomics added for historical result inspection.

```
opensip agent-catalog
opensip agent-catalog --json
```

The `--json` output is designed to be consumed directly by agents. It contains:

- Primary entry points with ready-to-use examples (including `sessions show latest --tool <fit|graph|sim> --json --filter errors-only --filter top:20` and `sessions list --json --summary-only`).
- Common composable agent workflows.
- Notes on the core output shapes (`SignalEnvelope`, `SessionReplayResult` with `fidelity: "projection"`, etc.).
- Explicit call-out that human-readable renderers (tables, banners) are unchanged.

This is the recommended starting point for any agent that needs to discover how to drive OpenSIP programmatically or inspect prior runs.

---

## `sessions list`, `sessions show`, and `sessions purge` — manage session records

CLI-owned. Reads, replays, and deletes session rows in the project-local SQLite datastore (`<project>/opensip-cli/.runtime/datastore.sqlite`) via `SessionRepo`. `list` and `show` are `SELECT`s; `purge` is a row-level `DELETE` (the FK cascade drops each session's tool-payload row), not file removal.

Primary surface for inspecting prior runs (especially from agents). See `agent-catalog` above for the recommended discovery entry point.

```
opensip sessions list
opensip sessions list --json --summary-only
opensip sessions show <session-id>
opensip sessions show latest --tool fit
opensip sessions show latest --tool fit --json --filter errors-only --filter top:20
opensip sessions show latest --tool graph --json --raw
opensip sessions purge
opensip sessions purge --older-than 7
opensip sessions purge -y
```

| Subcommand | Flag | Effect |
|---|---|---|
| `list` | (none) | List every stored session, newest first. |
| `list` | `--summary-only` | Omit heavy per-session tool payloads (agent-friendly "menu" mode). The lightweight summary and `showCommand` hints remain. |
| `show` | `<ref>` (positional) | Replay a stored session by id, or `latest` (requires `--tool`). Supports relative refs such as `previous` / `latest-N`. |
| `show` | `--tool <fit\|graph\|sim>` | Required for `latest`; an optional sanity check for an explicit id. |
| `show` | `--json` | Emit the replayed session (projected `SignalEnvelope` under the result). |
| `show` | `--filter <type>` | Filter the replayed signals (repeatable). Supported values: `errors-only` (high severity), `warnings-only` (medium), `top:<n>`. Composable, e.g. `--filter errors-only --filter top:20`. Adds `filtersApplied`, `originalSignalCount`, and `returnedSignalCount` to the machine output. |
| `show` | `--raw` | With `--json`: emit only the inner payload (`session` + `envelope` + metadata) without the outer `CommandOutcome` wrapper. Ideal for token-sensitive agents. |
| `purge` | `--older-than <days>` | Only delete sessions older than N days. Default: delete all. |
| `purge` | `-y, --yes` | Skip the confirmation prompt. |

**Session replay.** `sessions show` reconstructs a past run's output from the
stored payload: each tool contributes a `sessionReplay` projection
(`fit`/`graph`/`sim`) that decodes the opaque payload back into a
`SignalEnvelope`. The replay `fidelity` is always `projection` — it is rebuilt from
persisted findings, not a re-execution. Each run command also accepts an inline
`--show <session>` flag (`fit --show latest`, `graph --show <id>`,
`sim --show latest`) as a shorthand for the same replay scoped to that tool. A
missing session, wrong tool, or undecodable payload returns a structured error
(`reason`/`code`: `not-found`, `wrong-tool`, `ambiguous-latest`, `decode-error`)
and exit 2.

The `--filter` and `--raw` options (plus `--summary-only` on `list`) were added specifically to make historical result inspection efficient for AI agents while leaving all human-readable tables and banners unchanged.

**See also:** [`80-implementation/03-session-and-persistence.md`](/docs/opensip-cli/80-implementation/03-session-and-persistence/).

---

## `<tool> plugin add/remove/list/sync` — manage a tool's extension packs

CLI-owned: [`packages/cli/src/commands/plugin.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/cli/src/commands/plugin.ts).

The pack-management `plugin` group is mounted **under each pack-supporting tool primary** — the domain is bound from the tool, so there is **no top-level `opensip plugin`** and **no `--domain` flag**. `fit` and `sim` support packs; `graph` does not (its extensibility is language adapters), so it has no `plugin` group.

```
opensip fit plugin list
opensip fit plugin add <pkg>
opensip fit plugin remove <pkg>
opensip fit plugin sync

opensip sim plugin list
opensip sim plugin add <pkg>
opensip sim plugin remove <pkg>
opensip sim plugin sync
```

| Flag | Subcommands | Effect |
|---|---|---|
| `--cwd <path>` | all | Project root. Default: `process.cwd()`. |
| `--json` | all | Structured output. |

Extension packs are **project-committed and always project-local**: `add` writes to `.runtime/plugins/<domain>/node_modules/<pkg>/` (where `<domain>` is the tool the subcommand hangs off of — `fit` or `sim`) **and** appends to `plugins.<domain>:` in `opensip-cli.config.yml` so teammates reproduce them via `sync`. Fit packs declare `kind: "fit-pack"`; sim packs are listed under `plugins.sim:` / `plugins.scenarioPackages:` or discovered by the `scenarios-*` package-name pattern. `remove` is the inverse. There is no user-global pack path, so there is no `--project` flag.

**`<tool> plugin list`** shows that tool's packs (installed ∩ config-listed) for its own domain only — it does **not** list whole Tool plugins. **`<tool> plugin sync`** installs everything declared under that tool's `plugins.<domain>:` — the post-clone bootstrap.

**Whole Tool plugins** (a `kind: "tool"` package contributing a whole subcommand) are installed/uninstalled with the [`tools` command group](/docs/opensip-cli/70-reference/12-tools-command/) — `opensip tools install <spec>` — NOT here.

**See also:** [`80-implementation/02-plugin-loader.md`](/docs/opensip-cli/80-implementation/02-plugin-loader/).

---

## `tools list/validate/install/uninstall/data-purge` — manage whole Tool plugins

The documented surface for whole Tool plugins (`kind: "tool"` packages that contribute entire subcommands). See the full reference: [`12-tools-command.md`](/docs/opensip-cli/70-reference/12-tools-command/).

```
opensip tools list
opensip tools validate <spec>
opensip tools install <spec> [--global|--project]
opensip tools uninstall <name-or-id> [--global|--project] [--purge-data]
opensip tools data-purge <tool-id>
```

`validate` runs the same admission pipeline the CLI's own bootstrap admits tools through — one validator, shared. `install` is atomic: stage → validate → activate; a failed install leaves nothing behind. `uninstall` never deletes project SQLite data; `data-purge` deletes rows (sessions, baselines, tool state), never tables. **`validate` and `install` execute the package's module** — see the trust notes in the full reference.

---

## Internal and machine-facing commands

These commands are mounted through the same `CommandSpec` system but are primarily for workers, export jobs, or project automation rather than daily interactive use:

| Command | Owner | Purpose |
|---|---|---|
| `opensip graph export --format catalog` | graph | Emit a graph catalog artifact for parent ingestion. Uses `--catalog-output`, tenant/repo/run identity flags, `--cwd`, `--language`, and `--resolution`. |
| `opensip graph export --format sarif` | graph | Emit graph findings as SARIF for a stored run. Uses `--output-sarif`, tenant/repo/run identity flags, `--cwd`, `--language`, and `--resolution`. |
| `opensip graph-equivalence-check` | graph | Contributor guardrail for exact vs. sharded graph-engine equivalence. Uses `--cwd`, `--budget`, and `--update-budget`. |
| `opensip graph-run-worker` | graph | Internal worker for memory-isolated graph runs. |
| `opensip graph-shard-worker <specPath>` | graph | Internal worker for sharded catalog builds. |
| `opensip fit-run-worker` | fitness | Internal worker for memory-isolated fitness runs. |
| `opensip sim-run-worker` | simulation | Internal worker for memory-isolated simulation runs. |

The worker commands are not the public authoring surface; they exist so parent commands can fan out safely while preserving the same tool-owned execution contracts.

---

## `completion` — print shell completion script

CLI-owned: [`packages/cli/src/commands/completion.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/cli/src/commands/completion.ts).

```
opensip completion bash
opensip completion zsh
opensip completion fish
```

`<shell>` is required — there's no default.

Pipe to your shell's completion config:

```bash
opensip completion zsh > ~/.opensip-cli-completion.zsh
echo "source ~/.opensip-cli-completion.zsh" >> ~/.zshrc
```

The emitted script is static (your shell sources it once), but its contents are **derived from the live `CommandSpec`s at generation time** — the same specs the runtime mounts (`assembleCompletionInventory` in `packages/cli/src/commands/completion.ts`). Subcommands and per-command flags come from the populated tool registry plus the host commands, so the script can't drift from the real command surface; a flag-parity test enforces it. Because the inventory is sourced from the runtime registry, **discovered third-party tool subcommands and flags are included too**, not just the built-in `fit`/`sim`/`graph` families.

---

## `uninstall` — remove opensip-cli state

CLI-owned: [`packages/cli/src/commands/uninstall.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/cli/src/commands/uninstall.ts).

```
opensip uninstall                       # remove ~/.opensip-cli/
opensip uninstall --user                # explicitly remove ~/.opensip-cli/
opensip uninstall --project             # remove project runtime state at cwd
opensip uninstall --project /path/repo  # remove project runtime state at <path>
opensip uninstall --project --purge     # also remove authored content + config
opensip uninstall --dry-run             # print targets, take no action
opensip uninstall --yes                 # skip confirmation prompt
```

Two modes:

| Mode | Targets removed | When to use |
|---|---|---|
| Default / `--user` | `~/.opensip-cli/` (user-level config dir) | Removing the cloud API key and per-user defaults. |
| `--project [path]` | `<path>/opensip-cli/.runtime/` by default | Remove rebuildable session/cache/log/baseline state for one repo while preserving authored checks, recipes, scenarios, and config. |
| `--project [path] --purge` | `<path>/opensip-cli/` (authored content included) and `<path>/opensip-cli.config.yml` | Fully disengage from opensip-cli in one repo. Destructive if custom checks/recipes are not committed. |

| Flag | Effect |
|---|---|
| `--user` | Explicitly choose default user mode. Mutually exclusive with `--project`. |
| `--project [path]` | Switch to project mode. Path defaults to cwd. |
| `--purge` | In project mode, also remove user-authored content under `opensip-cli/` and `opensip-cli.config.yml`. |
| `--yes`, `-y` | Skip the `[y/N]` confirmation prompt. |
| `--dry-run` | Enumerate targets and total size; make no changes. |

Both modes:

- Print every target path and its size before acting.
- Refuse to run when no targets exist (`--project` against a directory that contains no OpenSIP CLI state is a no-op, not a destructive accident). In project mode without `--purge`, a repo that has only authored content and no `.runtime/` also becomes a no-op and tells you what it kept.
- Do **not** remove the npm-global binary — the running binary can't safely self-delete. The user-mode success message prints the next step (`npm uninstall -g opensip-cli`); the project-mode success message points back at the user-mode command for the matching cleanup.

State contract enforced by code: `~/.opensip-cli/` holds `config.yml` only.
Persistence and logging modules throw when asked to write there (see
[`paths.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/core/src/lib/paths.ts),
[`logger.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.10/packages/core/src/lib/logger.ts)). Anything else in that
directory is considered extra user-level state and is swept up by the default
`uninstall`.

---

## Upgrading

opensip-cli updates through the same installer used for first-time setup:

```
curl -fsSL https://opensip.ai/cli/install.sh | bash
```

The CLI checks npm for a newer version once a day (non-blocking, TTY-only). The *check* is rate-limited to once a day, but once a newer version is found the *notice* persists on **every** run until you upgrade — so it's never lost if you miss it once — and disappears on its own the run after you update. When an update is available it surfaces without nagging:

- On the default `mini` banner, the version line shows `(<new-version> available)` and a dim `↑ Update: curl -fsSL https://opensip.ai/cli/install.sh | bash` line prints just below the banner.
- On the `lg`/`md`/`sm` banners (and the `--json` path, which renders no banner), the same upgrade command is printed as a one-line note on stderr.

Silence the check entirely with `OPENSIP_NO_UPDATE=1` (or the conventional `NO_UPDATE_NOTIFIER=1`). It's also skipped automatically when `CI` is set or stdout isn't a TTY. Check your installed version any time with `opensip --version`.

If you installed via a version manager (volta, asdf) or Homebrew, use that tool's upgrade path instead of the curl installer above.

---

## What's next

- **[`../50-extend/01-plugin-authoring.md`](/docs/opensip-cli/50-extend/01-plugin-authoring/)** — write a check, recipe, scenario, or full Tool plugin.
- **[`06-dashboard.md`](/docs/opensip-cli/70-reference/06-dashboard/)** — the HTML report's structure and lifecycle.
- **[`../70-reference/03-configuration.md`](/docs/opensip-cli/70-reference/03-configuration/)** — every field of `opensip-cli.config.yml`.
