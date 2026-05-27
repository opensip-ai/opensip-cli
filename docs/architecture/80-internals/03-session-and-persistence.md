---
status: current
last_verified: 2026-05-21
release: v2.0.x
title: "Session and persistence"
audience: [contributors]
purpose: "What gets written to disk during and after a run. The runtime dir layout, the SQLite store, logs, reports."
source-files:
  - packages/core/src/lib/paths.ts
  - packages/core/src/lib/logger.ts
  - packages/datastore/src/data-store.ts
  - packages/datastore/src/factory.ts
  - packages/contracts/src/persistence/store.ts
  - packages/contracts/src/persistence/session-repo.ts
  - packages/contracts/src/persistence/schema/sessions.ts
  - packages/graph/engine/src/persistence/baseline-repo.ts
  - packages/graph/engine/src/persistence/catalog-repo.ts
  - packages/graph/engine/src/persistence/schema.ts
  - packages/fitness/engine/src/persistence/baseline-repo.ts
  - packages/fitness/engine/src/persistence/schema.ts
related-docs:
  - ../00-start/06-system-context.md
  - ./01-cli-dispatch.md
  - ./02-plugin-loader.md
  - ../80-internals/05-layer-policy.md
---
# Session and persistence

A run produces three kinds of on-disk artifacts: the SQLite database, structured log files, and HTML dashboard reports. All three live under one directory — `<project>/opensip-tools/.runtime/` — which is gitignored and rebuildable.

> **What you'll understand after this:**
> - The on-disk layout and what's stored where.
> - Tool-produced data (sessions, catalog, baselines) → SQLite via `DataStore`.
> - Logs and reports stay as files; rendering channels for external consumers.
> - The schema-migration model and the upgrade / downgrade contract.

---

## The runtime dir layout

```
<project>/opensip-tools/.runtime/
├── datastore.sqlite                            ← single SQLite store for tool-produced data
├── datastore.sqlite-wal                        ← WAL journal (created when writes are in flight)
├── datastore.sqlite-shm                        ← shared-memory page (companion to WAL)
├── reports/latest.html                         ← rewritten by every dashboard generation
├── logs/<YYYY-MM-DD>.jsonl                     ← one log file per local day, shared across runs
└── plugins/                                    ← npm-installed project plugins
    ├── fit/node_modules/
    └── sim/node_modules/
```

Source of truth: [`packages/core/src/lib/paths.ts`](../../../packages/core/src/lib/paths.ts). Every consumer reads paths through `resolveProjectPaths(cwd)`. The directory is created lazily by whichever consumer needs a subpath first; `mkdirSync(..., { recursive: true })` is the standard idiom.

The WAL/SHM sidecar files are SQLite implementation details (Write-Ahead Log mode, enabled at open time so concurrent reads — e.g. from `graph --packages` child processes — don't block writes). They may be empty or absent after a clean shutdown depending on SQLite's WAL checkpoint timing; both states are normal.

---

## The DataStore

[`packages/datastore`](../../../packages/datastore) hosts the persistence kernel: a `DataStore` interface, a SQLite-backed implementation, an in-memory implementation for tests, and the workspace-wide migration store under `migrations/`. The CLI bootstrap opens one `DataStore` per invocation in the `preAction` hook ([`packages/cli/src/index.ts`](../../../packages/cli/src/index.ts)) and closes it on `process.exit`. Every tool's command receives the handle via `ToolCliContext.datastore`.

Schemas are owned by the package that produces the data — datastore is paradigm-agnostic infrastructure. Adding a new tool means adding a new schema module under that tool's `src/persistence/schema.ts` and registering it in [`packages/datastore/drizzle.config.ts`](../../../packages/datastore/drizzle.config.ts). Three packages register schemas today:

| Owner | Schema file | Tables |
|---|---|---|
| `@opensip-tools/contracts` | `src/persistence/schema/sessions.ts` | `sessions`, `session_checks`, `session_findings` |
| `@opensip-tools/graph` | `src/persistence/schema.ts` | `graph_baseline_signals`, `graph_baseline_meta`, `graph_catalog` |
| `@opensip-tools/fitness` | `src/persistence/schema.ts` | `fit_baseline` |

`__drizzle_migrations` is a fourth, internal table — Drizzle uses it to record which migrations have been applied.

SQLite + Drizzle were chosen because the runtime store is local, project-scoped, transactional, and small enough to rebuild if a user needs to delete it. A remote database, JSON-as-backend, or a broader persistence abstraction would add operational weight without improving the CLI's local-first behavior.

---

## Sessions

A session is one record per `fit`, `sim`, or `graph` run. Stored as a row in the `sessions` table, with a `session_checks` row per check and `session_findings` rows for each violation. The wire-shape is unchanged from v1 — the `StoredSession` interface in [`packages/contracts/src/persistence/store.ts`](../../../packages/contracts/src/persistence/store.ts) is what `SessionRepo` round-trips:

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

The session is written via [`SessionRepo.save()`](../../../packages/contracts/src/persistence/session-repo.ts) inside a single transaction (sessions row + per-check rows + per-finding rows), so even a run that crashes mid-render leaves a complete or no record — never a partial one.

### The `sessions` command

```bash
opensip-tools sessions list                       # SELECT * FROM sessions ORDER BY timestamp DESC
opensip-tools sessions purge                      # DELETE FROM sessions (prompts for confirm)
opensip-tools sessions purge --older-than 7       # DELETE FROM sessions WHERE timestamp < cutoff
opensip-tools sessions purge -y                   # skip the confirmation prompt
```

`purge` is **row-level data deletion**, not file removal. The FK cascade from `sessions` → `session_checks` → `session_findings` ensures that purging a session cleans up its dependents in one shot.

The dashboard reads the same store to populate its run-history view.

---

## The graph catalog

`@opensip-tools/graph` builds a call-graph catalog (functions, occurrences, calls) and persists it via [`CatalogRepo`](../../../packages/graph/engine/src/persistence/catalog-repo.ts). v2 stores the whole catalog as a single SQLite row; metadata fields (language, cache key, files fingerprint) are lifted into typed columns so the orchestrator can fingerprint-mismatch without parsing the payload. The reconstructed `Catalog` shape is byte-identical to v1's, so dashboard view derivations and rules are unchanged.

The `--packages` runner spawns one child process per workspace package. Each child opens its own `DataStore` against the shared `datastore.sqlite` file. WAL mode permits concurrent readers + one writer, so the parallelism is safe but serialized at the catalog write boundary — per-package incremental writes are deferred to a follow-up `graph-catalog-perf` plan.

The `--no-cache` flag forces a cache miss; the existing fingerprint-based invalidation path runs even when `datastore.sqlite` is present and current.

---

## The gate baselines

Two baselines live in the SQLite store:

- **Fitness baseline** (`fit_baseline`) — the SARIF document produced by `opensip-tools fit --gate-save`. Single-row table; `--gate-compare` reads it and diffs against the current SARIF by `(filePath, ruleId, message)` hash.
- **Graph baseline** (`graph_baseline_signals` + `graph_baseline_meta`) — the fingerprint set produced by `opensip-tools graph --gate-save`. The `meta` row marks "a baseline exists" so an empty-but-saved baseline (a clean codebase) reports `exists() === true`.

### v1 → v2: the `--baseline <path>` flag is gone

v1 wrote baselines as JSON/SARIF files (`baseline.sarif`, `cache/graph/baseline.json`) and let users override the path with `--baseline`. v2 stores exactly one baseline per project, in the SQLite database. **Drop `--baseline path/to/file.sarif` from CI invocations**; the flag has no equivalent. Teams that committed `baseline.sarif` to git for cross-CI-run gate comparisons should re-run `--gate-save` once the new code lands. See the v2.0.0 entry in [`CHANGELOG.md`](../../../CHANGELOG.md) for the full break.

---

## Logs

Structured JSON Lines, one event per line. Written to two destinations simultaneously:

1. **stderr** — for live observation (`opensip-tools fit 2>&1 | jq`).
2. **`<project>/opensip-tools/.runtime/logs/<YYYY-MM-DD>.jsonl`** — one file per local day; every run on the same day appends to the same file. Filter with `jq` on the `runId` field to isolate a specific run.

The logger is in [`packages/core/src/lib/logger.ts`](../../../packages/core/src/lib/logger.ts). Every log entry carries:

- `evt` — the event name (`cli.fit.run.start`, `session.save.complete`, etc.).
- `module` — the module that emitted it (`cli:fit`, `contracts:session-repo`, …).
- `runId` — the per-run correlation id.
- Plus event-specific fields.

Persistence call sites emit structured events with stable `evt:` names: `session.save.complete` / `.list.complete` / `.purge.complete`, `graph.baseline.save.complete` / `.load.complete` / `.load.miss`, `graph.catalog.read.hit` / `.read.miss` / `.write.complete`, `fit.baseline.save.complete` / `.load.complete` / `.load.miss`. Observability did not regress with the storage swap.

The log file persists until manually deleted. There's no rotation; that's the user's job. `sessions purge` deletes session rows but leaves logs alone, by design.

---

## Reports

The HTML dashboard writes a single self-contained file at `<project>/opensip-tools/.runtime/reports/latest.html` ([`packages/fitness/engine/src/cli/dashboard.ts`](../../../packages/fitness/engine/src/cli/dashboard.ts)). Each generation overwrites the previous file — the dashboard is "always show the most recent state", not a per-run archive.

The generator pulls sessions via `SessionRepo.list({ limit: 20 })` and the graph catalog via `CatalogRepo.loadFullCatalog()`, then assembles the inlined HTML (JS via `<script type="module">`, CSS via `<style>`, session/catalog data via `<script type="application/json">`). The output is one self-contained file you can email — no CDN, no asset bundle, no server.

The dashboard auto-open hook fires after a run if (a) `--open` was requested or auto-open is configured, (b) output isn't `--json`, and (c) stdout is a TTY.

---

## Upgrade behavior

`DataStoreFactory.open()` applies any pending Drizzle migrations on every CLI invocation. Migrations are content-hashed and idempotent. Users see no extra step; first run of a new opensip-tools version brings the schema up to date in milliseconds.

If migration fails (corrupted DB, downgrade across schema changes), the CLI surfaces a `DataStoreMigrationError` with a recovery hint pointing at deleting `<project>/opensip-tools/.runtime/datastore.sqlite`. Cache rebuilds on next run; session history is lost. **Downgrades across schema changes are unsupported** — Drizzle has no down-migration concept.

---

## Lifecycle commands and what they touch

A reference for "I want to free disk / I'm debugging."

| Command | Touches |
|---|---|
| `opensip-tools sessions list` | `SELECT FROM sessions` |
| `opensip-tools sessions purge --older-than N` | `DELETE FROM sessions WHERE timestamp < cutoff` (FK cascades to checks + findings) |
| `opensip-tools fit --no-cache` / `graph --no-cache` | Forces cache miss; rebuilds full catalog/results, ignores any cached row |
| `opensip-tools uninstall --project [path]` | Removes `<path>/opensip-tools/` recursively. **`datastore.sqlite` and its `-wal` / `-shm` sidecars are caught transitively.** On Windows, ensure no opensip-tools CLI process is active when running this — open file handles can block WAL/SHM removal. |
| `opensip-tools uninstall` (no flag) | Removes `~/.opensip-tools/`. No DB there; user-global state is a single config file. |
| Manual `rm <path>/opensip-tools/.runtime/datastore.sqlite*` | Wipes the project DB. Caches rebuild; session history is lost. |

The whole `<project>/opensip-tools/` directory is also safe to delete; `opensip-tools init` will scaffold it fresh. You lose your custom checks and recipes if you didn't commit them.

---

## What's next

- **[`../10-concepts/05-architecture-gate.md`](../10-concepts/05-architecture-gate.md)** — the gate's full behavior and the baseline format.
- **[`../70-reference/06-dashboard.md`](../70-reference/06-dashboard.md)** — the HTML report's structure and the `dashboard` command.
- **[`../70-reference/03-configuration.md`](../70-reference/03-configuration.md)** — `opensip-tools.config.yml` schema (the one bit of project state that's not in `.runtime/`).
- **[`../80-internals/05-layer-policy.md`](../80-internals/05-layer-policy.md)** — where datastore sits in the workspace layering.
