---
status: current
last_verified: 2026-05-15
title: "Session and persistence"
audience: [contributors]
purpose: "What gets written to disk during and after a run. The runtime dir layout, session records, logs, reports, the cache."
source-files:
  - packages/core/src/lib/paths.ts
  - packages/core/src/lib/logger.ts
  - packages/contracts/src/persistence/store.ts
  - packages/contracts/src/persistence/dashboard/
  - packages/fitness/engine/src/framework/parse-cache.ts
  - packages/fitness/engine/src/framework/file-cache.ts
related-docs:
  - ../00-orientation/03-system-context.md
  - ./01-cli-dispatch.md
  - ./02-plugin-loader.md
---
# Session and persistence

A run produces five kinds of on-disk artifacts: the session record, the structured log, the dashboard report, the cache, and (optionally) the gate baseline. All five live under one directory — `<project>/opensip-tools/.runtime/` — which is gitignored and rebuildable.

> **What you'll understand after this:**
> - The five artifact kinds and where each one lives.
> - Which artifacts persist across runs and which are run-scoped.
> - The session record schema and how `sessions list` consumes it.
> - The cache invalidation policy.

---

## The runtime dir layout

```
<project>/opensip-tools/.runtime/
├── sessions/<timestamp>-<tool>-<recipe>.json   ← per-run records (most-recent 100, older entries pruned)
├── reports/latest.html                         ← rewritten by every dashboard generation
├── logs/<YYYY-MM-DD>.jsonl                     ← one log file per local day, shared across runs
├── cache/                                      ← AST + glob caches (durable, content-keyed)
│   ├── ast/<file-hash>.json
│   ├── glob/<pattern-hash>.json
│   ├── prewarm/…
│   └── graph/                                  ← graph tool catalog + baseline
│       ├── catalog.json
│       └── baseline.json
├── plugins/                                    ← npm-installed project plugins
│   ├── fit/node_modules/
│   └── sim/node_modules/
└── baseline.sarif                              ← fit gate baseline (default location)
```

Source of truth: [`packages/core/src/lib/paths.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/core/src/lib/paths.ts). Every consumer reads paths through `resolveProjectPaths(cwd)`.

The dir is created lazily by whichever consumer needs a subpath first. `mkdirSync(..., { recursive: true })` is the standard idiom — there's no startup pass that pre-creates the layout.

---

## Sessions

A session is one record per `fit` or `sim` run. Stored at `<project>/opensip-tools/.runtime/sessions/<run-id>.json` (the persistence store uses a `{timestamp}-{tool}-{recipe}.json` filename internally; the run-id is embedded in the body).

### Schema

The shape lives in [`packages/contracts/src/persistence/store.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/store.ts):

```ts
interface StoredSession {
  readonly id: string;
  readonly tool: 'fit' | 'sim' | 'graph';
  readonly timestamp: string;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly summary: { total, passed, failed, errors, warnings };
  readonly checks: readonly {
    checkSlug, passed, violationCount?, findings[], durationMs
  }[];
  readonly durationMs: number;
}
```

It's `CliOutput` plus `id` and `cwd` and (per-finding) an optional `category`. The session is written *before* the renderer fires, so even a run that crashes during rendering leaves a session record on disk.

### The `sessions` command

```bash
opensip-tools sessions list                       # list every stored session, newest first
opensip-tools sessions purge                      # delete all (prompts for confirm)
opensip-tools sessions purge --older-than 7       # only sessions older than N days
opensip-tools sessions purge -y                   # skip the confirmation prompt
```

`list` takes no flags. `purge` takes `--older-than <days>` and `-y/--yes`. The list output sorts by timestamp descending and shows id, tool, recipe, pass/fail, and finding count. The dashboard reads the same store to populate its run history.

### Why JSON, not SQLite

A flat directory of JSON files instead of a SQLite database, because:

- **Inspectable.** `cat sessions/run-xyz.json | jq .summary` works without tooling.
- **Backup-friendly.** A user can copy the directory; there's no schema migration story.
- **No native dependency.** SQLite would pull `better-sqlite3` or a similar binary into the install. The marketplace shape is "pure Node, install everywhere."
- **Read patterns are list + lookup.** Both are fast against a sorted directory listing of ~hundreds of files. We're not running aggregate queries.

The session store auto-prunes: `MAX_SESSIONS = 100` is enforced inside the persistence module ([`packages/contracts/src/persistence/store.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/store.ts)). Once 100 entries are on disk, the oldest are silently dropped on each subsequent write — so the directory size is bounded without user intervention. `sessions purge` is the manual cleanup for an immediate wipe; `sessions purge --older-than <days>` trims by age. The dir is gitignored, so it doesn't grow the repo either way.

---

## Logs

Structured JSON Lines, one event per line. Written to two destinations simultaneously:

1. **stderr** — for live observation (`opensip-tools fit 2>&1 | jq`).
2. **`<project>/opensip-tools/.runtime/logs/<YYYY-MM-DD>.jsonl`** — one file per local day; every run on the same day appends to the same file. Filter with `jq` on the `runId` field to isolate a specific run.

The logger is in [`packages/core/src/lib/logger.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/core/src/lib/logger.ts). Every log entry carries:

- `evt` — the event name (`cli.fit.run.start`, `plugin.loader.discover`, etc.).
- `module` — the module that emitted it (`cli:fit`, `core:plugins`, …).
- `runId` — the per-run correlation id.
- Plus event-specific fields.

Log levels are `error`, `warn`, `info`, `debug`. The default is `info`. `--debug` raises it to `debug`. `--quiet` does *not* affect log level — it suppresses the renderer's banner, not the structured logs.

The log file persists until manually deleted. There's no rotation; that's the user's job. `sessions purge` deletes session records but leaves logs alone, by design — logs are useful for debugging *after* a session is no longer needed.

### Why JSON Lines

Same reasons as the session store: greppable, parseable, no schema migration. `jq -s` aggregates a JSONL file when needed; `jq -c` filters streaming output.

The `evt` field is the primary axis for filtering. Every event has a stable `evt` name (load-bearing — they appear in CI logs and dashboards). Adding a new event is a non-breaking change; renaming one is a breaking change for any external consumer who's grepping for it.

---

## Reports

The HTML dashboard writes a single self-contained file at `<project>/opensip-tools/.runtime/reports/latest.html` ([`packages/fitness/engine/src/cli/dashboard.ts:153`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/fitness/engine/src/cli/dashboard.ts)). Each generation overwrites the previous file — the dashboard is "always show the most recent state", not a per-run archive.

Dashboard JS, CSS, and panel modules live in [`packages/contracts/src/persistence/dashboard/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/). The generator inlines all of them — JS via `<script type="module">`, CSS via `<style>`, session data via `<script type="application/json">` — so `latest.html` is one file you can email to a teammate. No CDN, no asset bundle, no server.

Per-run history lives in `sessions/`, not `reports/`. The dashboard reads every session record to render its run-history view, but the HTML on disk is always the latest snapshot.

The dashboard auto-open hook is wired into the Tool action handler. After a run, if (a) `--open` was requested or auto-open is configured, (b) output isn't `--json`, and (c) stdout is a TTY, the CLI launches the user's default browser onto the report URL. Logic in [`packages/cli/src/open-dashboard.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/cli/src/open-dashboard.ts).

---

## The cache

Two caches live under `<project>/opensip-tools/.runtime/cache/`:

### AST cache

Per-file parsed AST representation, keyed by content hash. When a check parses a file (typescript adapter compiling, or any analyzer using `parseCache`), the result is cached. Subsequent reads of the same file (within the same run, or across runs as long as the file hasn't changed) skip the parse.

Source: [`packages/fitness/engine/src/framework/parse-cache.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/fitness/engine/src/framework/parse-cache.ts).

The cache is **content-addressed**, not path-addressed. Two files with identical content share a cache entry. Renaming a file doesn't invalidate.

### Glob cache

Pre-resolved glob results. The scope resolver pre-globs every target's include patterns once per run, but those results are also persisted across runs as long as the project tree hasn't changed. The cache key is a hash of the patterns + a digest of the directory listing.

Source: [`packages/fitness/engine/src/framework/file-cache.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/fitness/engine/src/framework/file-cache.ts).

### Invalidation

The cache is **safe to delete at any time.** A wiped cache rebuilds on the next run; correctness doesn't depend on it. If you suspect cache corruption, `rm -rf opensip-tools/.runtime/cache/` is the answer — there's no `--clean` flag because the directory wipe is just as effective and more direct.

The cache entries are not LRU-bounded today. Large polyglot repos with frequent code churn produce ~tens of MB of cache over weeks. If that becomes a problem, periodic wipes are the workaround; a built-in size cap is on the roadmap.

---

## The gate baseline

`<project>/opensip-tools/.runtime/baseline.sarif` is the default baseline path for `--gate-save` / `--gate-compare`. The file is the only artifact in the runtime dir that some teams *do* commit to git — checking it in lets PR builds gate against a fixed reference.

Some teams keep it in `.runtime/` (gitignored) and trust the gate to track regression deltas across sequential CI runs. Others move it to `<project>/opensip-tools/baseline.sarif` (outside `.runtime/`, committed) and use `--baseline opensip-tools/baseline.sarif` to point at it.

Both are valid. The default path is in `.runtime/` because the most common workflow is "save once locally, compare against it on the next CI run on the same branch." Teams with a stable main-branch reference move it out.

The `clear` command ([`packages/cli/src/commands/clear.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/cli/src/commands/clear.ts)) only deletes session JSON files under `.runtime/sessions/`. It does not touch reports, logs, cache, plugins, or the baseline — those have to be removed manually if you want them gone.

---

## What can be safely deleted

A reference for "I want to free disk / I'm debugging."

| Path | Safe to delete? | Effect |
|---|---|---|
| `sessions/<timestamp>-<tool>-<recipe>.json` | yes | History entry disappears. |
| `logs/<YYYY-MM-DD>.jsonl` | yes | That day's log archive disappears. |
| `reports/latest.html` | yes | Removed file is regenerated next time the dashboard runs. |
| `cache/` (whole dir) | yes | Next run rebuilds. Slightly slower first run after. |
| `plugins/<domain>/node_modules/` | yes | `plugin sync` reinstalls. |
| `baseline.sarif` | careful | Next `--gate-compare` errors with `GateBaselineMissingError`. Re-save with `--gate-save`. |
| The whole `.runtime/` dir | yes | Everything above. Authored content under `<project>/opensip-tools/{fit,sim}/` is untouched. |

The whole `<project>/opensip-tools/` dir is also safe to delete; `opensip-tools init` will scaffold it fresh. You'll lose your custom checks and recipes if you didn't commit them.

---

## What's next

- **[`../60-subsystems/03-architecture-gate.md`](/docs/opensip-tools/60-subsystems/03-architecture-gate/)** — the gate's full behavior and the baseline format.
- **[`../70-surfaces/03-dashboard.md`](/docs/opensip-tools/70-surfaces/03-dashboard/)** — the HTML report's structure and the `dashboard` command.
- **[`../80-reference/02-configuration.md`](/docs/opensip-tools/80-reference/02-configuration/)** — `opensip-tools.config.yml` schema (the one bit of project state that's not in `.runtime/`).
