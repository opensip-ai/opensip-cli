---
status: current
last_verified: 2026-06-15
release: v0.1.5
title: "System context"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "Where opensip-cli sits between you, your codebase, CI, and OpenSIP Cloud — and what it touches on disk."
source-files:
  - packages/core/src/lib/paths.ts
  - packages/cli/src/index.ts
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/configure.ts
  - packages/contracts/src/exit-codes.ts
related-docs:
  - ./01-what-is-opensip-cli.md
  - ./05-vocabulary.md
  - ./07-architecture-overview.md
  - ../80-implementation/03-session-and-persistence.md
  - ../70-reference/03-configuration.md
---
# System context

OpenSIP CLI is a CLI that runs against your project. This doc draws the box around it: who calls it, what it reads and writes, what's local versus cross-project, what's optional.

> **What you'll understand after this:**
> - The four actors that interact with opensip-cli (you, CI, the dashboard browser, the cloud).
> - The on-disk layout — what's tracked in git, what's gitignored, what's per-user.
> - Exit codes and how CI consumes them.
> - The worked example we'll thread through the rest of the doc set.

---

## The actors

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                           your project                            │
   │                                                                   │
   │  source code  ◀─── reads ───┐                                     │
   │                              │                                    │
   │  opensip-cli.config.yml ◀──┤                                    │
   │  opensip-cli/fit/  ◀──────┤                                     │
   │  opensip-cli/sim/  ◀──────┤                                     │
   │  (graph reads source) ◀─────┤                                     │
   │                              │                                    │
   │                       ┌──────┴────────────────┐                   │
   │                       │  opensip-cli (bin)  │                   │
   │                       └──┬─────────┬──────────┘                   │
   │                          │         │                              │
   │                          │ writes  │ writes                       │
   │                          ▼         ▼                              │
   │  opensip-cli/.runtime/datastore.sqlite                          │
   │      (sessions + fit baseline + graph catalog/baseline rows)      │
   │  opensip-cli/.runtime/reports/latest.html  stdout (table|JSON|SARIF)│
   │  opensip-cli/.runtime/logs/<YYYY-MM-DD>.jsonl                    │
   │                                              stderr (logs)        │
   │                                              exit code (0|1|2|3|4)│
   └──────────────────────────────────────────────────────────────────┘
                          │                              │
                          │                              │
                  ┌───────▼───────┐              ┌───────▼─────────┐
                  │ CI / human    │              │ dashboard       │
                  │ (consumes     │              │ browser (opens  │
                  │ exit code     │              │ HTML report)    │
                  │ + JSON/SARIF) │              └─────────────────┘
                  └───────────────┘                       │
                                                          │ optional
                                                          ▼
                                                  ┌─────────────────┐
                                                  │ OpenSIP Cloud   │
                                                  │ (centralized    │
                                                  │ reporting)      │
                                                  └─────────────────┘
```

There are exactly four actors:

1. **You.** The engineer running `opensip fit` from a terminal. You read the rendered table, you see the exit code, you click the dashboard link.
2. **CI.** GitHub Actions, GitLab CI, Buildkite, or whatever — runs `opensip fit` non-interactively and consumes the exit code and (optionally) the SARIF or JSON output.
3. **The dashboard browser.** When `--open` is passed (or auto-open conditions are met), the CLI launches the user's default browser onto the local HTML report at `<project>/opensip-cli/.runtime/reports/latest.html` (a single rolling file overwritten on each generation). No server, just a static file.
4. **OpenSIP Cloud (optional).** If `~/.opensip-cli/config.yml` carries an API key, the CLI POSTs the run summary to [opensip.ai](https://opensip.ai) for centralized reporting. Without the key, this side is dead — the cloud is fully optional.

There is no fifth actor. Specifically: no daemon, no database, no message queue, no scheduled job, no agent. opensip-cli runs to completion and exits.

---

## The on-disk layout

The layout is set by [`packages/core/src/lib/paths.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.5/packages/core/src/lib/paths.ts) and is the single source of truth for every consumer (logger, gate, plugin loader, dashboard, sessions store).

### Project-level (`<project>/`)

Tracked in git:

```
<project>/
├── opensip-cli.config.yml       ← project config (commit this)
└── opensip-cli/
    ├── fit/
    │   ├── checks/**/*.mjs        ← your fitness checks
    │   └── recipes/**/*.mjs       ← your fitness recipes
    └── sim/
        ├── scenarios/**/*.mjs     ← your sim scenarios
        └── recipes/**/*.mjs       ← your sim recipes
```

Gitignored (`opensip init` adds the entry to `.gitignore` for you):

```
<project>/opensip-cli/.runtime/
├── datastore.sqlite                              ← single SQLite store for tool-produced data
│       │                                            (sessions, session_tool_payload,
│       │                                             graph_catalog, graph_shard_fragment,
│       │                                             tool_baseline_entries, tool_baseline_meta)
│       └── datastore.sqlite-wal / .sqlite-shm    ← WAL sidecar files (auto-managed by SQLite)
├── reports/latest.html                           ← single rolling HTML report, overwritten each run
├── logs/<YYYY-MM-DD>.jsonl                       ← one log file per local day, all runs append
└── plugins/
    ├── fit/node_modules/                         ← project-pinned fit plugins (plugin add/sync)
    └── sim/node_modules/                         ← project-pinned sim plugins
```

The split rule is simple: anything you author lives in `opensip-cli/`; anything
the tool generates lives in `opensip-cli/.runtime/`. The runtime dir is
rebuildable from the source side, so wiping `.runtime/` is always safe — caches
rebuild and session history is lost. Gate baselines, graph catalogs, sessions,
and tool state live in the project-local SQLite store under `.runtime/`; run
`--gate-save` to capture a baseline and `--gate-compare` to ratchet against it.
See [`80-implementation/03-session-and-persistence.md`](/docs/opensip-cli/80-implementation/03-session-and-persistence/)
for the schema layout.

### User-level (`~/.opensip-cli/`)

Cross-project, single file:

```
~/.opensip-cli/
└── config.yml                    ← cloud API key + per-user defaults
```

The user-level dir is intentionally small. Anything project-specific (checks, recipes, plugins) lives in the project, not here. The `~/.opensip-cli/` dir exists so every project on your machine can share one cloud API key.

`opensip configure` is the command that creates and edits this file. `opensip uninstall` deletes the whole `~/.opensip-cli/` directory.

---

## Exit codes

opensip-cli follows the conventional Unix exit-code shape, defined in [`packages/contracts/src/exit-codes.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.5/packages/contracts/src/exit-codes.ts):

| Code | Meaning |
|---|---|
| `0` | All checks passed (or nothing ran successfully). |
| `1` | At least one check failed — violations found, or `--gate-compare` detected a regression. |
| `2` | An unrecoverable configuration error (config invalid, plugin failed to load, baseline missing). |
| `3` | Typed not-found error from the shared mapper. Current unknown `fit --check <slug>` selections exit 2 as invalid configuration. |
| `4` | `--report-to` upload failed (network error or non-2xx). |
| `5` | A Tool plugin was rejected by the compatibility/trust gate before import. |

CI integrations should treat `0` as green, `1` as red-but-actionable (display the violations), and `2`/`3`/`4`/`5` as red-and-broken (display the error and check the run logs). Codes above 2 are reserved for the specific failure modes described above; the broad mental model stays "0 green, 1 expected red, anything else unexpected."

The `--gate-compare` flow uses the same exit codes: `0` if no new violations vs. baseline, `1` if any new violation, `2` if the baseline is missing or unreadable.

---

## Output channels

`stdout` carries the human-readable output (tables) or the machine-readable output (JSON / SARIF), gated by `--json` and `--sarif`. **Mixing the two is forbidden:** if `--json` is set, every renderer emits JSON or nothing. This rule exists so CI tooling can `opensip fit --json | jq …` without hitting interleaved table fragments.

`stderr` carries logs — structured JSON lines tagged with `evt`, `module`, and a correlation id (`runId`, format `RUN_<ulid>`). The same lines are mirrored to `<project>/opensip-cli/.runtime/logs/<YYYY-MM-DD>.jsonl` (one log file per local day, shared across runs); filter by `.runId` with `jq` to isolate one run.

The exit code is your gate. The stdout shape is your data. The stderr stream is your debugger.

---

## What the binary needs to run

A working Node.js 24+ runtime, a project root, and read access to the source files. That's it. (`packages/cli/package.json` declares `engines.node >= 24`.)

Specifically, it does **not** need:

- Network access (unless you opt into OpenSIP Cloud or `--open` launches a browser that requires one).
- A daemon, database, or background process.
- Root or admin privileges.
- A specific shell — argv-only invocation; the binary works under bash, zsh, fish, PowerShell, and CI runners equally.

The binary is published as `opensip-cli` and installs globally with the curl installer:

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
```

---

## The worked example

This doc set threads a single hypothetical project — call it `acme-api` — through the architecture.

> **`acme-api`** is a polyglot service: a TypeScript REST API at `services/api/`, a Python data pipeline at `pipelines/etl/`, and a shared infrastructure CDK stack at `infra/`. The team wants to gate on:
> - `no console.log` in TypeScript outside `tests/`.
> - `no print()` in Python outside `pipelines/etl/scripts/`.
> - Cyclomatic complexity capped at 25 across all source files.
> - No circular imports inside `services/api/src/`.
> - `infra/cdk.json` must exist (a sanity check).
>
> Their `opensip-cli.config.yml` declares two languages, one custom check directory, and a `quick-smoke` recipe that runs only the universal checks for fast PR feedback. Their full `fit` recipe runs against everything and is wired to `--gate-compare` in CI.

We'll see how each layer of the system handles this project — from the CLI dispatch in [`../80-implementation/01-cli-dispatch.md`](/docs/opensip-cli/80-implementation/01-cli-dispatch/), to the language-adapter registration, to the recipe selection, to the gate diff. Every runtime doc has a "Where the example lands" section so you can trace the same scenario all the way down.

---

## What's next

Orientation done. Next, open [`07-architecture-overview.md`](/docs/opensip-cli/00-start/07-architecture-overview/) for the visual map of package layers, runtime flow, and tool pipelines. After that, the mental-model section ([`../10-concepts/`](/docs/opensip-cli/10-concepts/)) is where the architecture starts to land in detail.
