---
status: follow-up
captured: 2026-05-26
related: marker-based plugin discovery + new customer layout (in design)
---

# Baseline storage migration: file → SQLite

## Context

Gate baselines today are file-based:

- `opensip-tools/.runtime/baseline.sarif` (fit)
- `opensip-tools/.runtime/cache/graph/baseline.json` (graph)

Meanwhile transactional tool state (sessions, runs) lives in `opensip-tools/.runtime/datastore.sqlite`. The split is historical — the graph baseline predates the datastore landing in core; the fit SARIF baseline followed inertia. There's no load-bearing reason to keep two storage targets for tool state.

## Why migrate

- **Single storage target** — backups, project portability, and migration tooling all converge on `datastore.sqlite`. Today users have to know "and these two files over here too."
- **Schema-versioned** — baseline shape evolves over time (new fingerprint kinds, new metadata fields). The datastore already has a migration system; baselines should ride it instead of inventing one ad-hoc.
- **Transactional** — `fit run + update baseline` becomes one atomic write. Today it's "wrote SARIF, then wrote DB, hope neither crashed in between."
- **Queryable** — baseline evolution over time is natural SQL (`SELECT ... ORDER BY captured_at`). With files, it's reconstruction from git history (only if checked in) or impossible (if gitignored).

## Scope

### Datastore schema

Add a `gate_baselines` table. First-pass shape:

| column | type | notes |
|---|---|---|
| tool | TEXT | `'fit'` or `'graph'` (extensible to future tools) |
| captured_at | INTEGER (epoch ms) | |
| schema_version | INTEGER | for fingerprint-shape migrations within the table |
| payload | TEXT (JSON) | the canonical baseline JSON for that tool |

PK: (tool). One baseline per tool per project. Whether to keep history (PK including `captured_at`) is a separate decision — start with "latest only," add history later if a use case appears.

### Code changes

- `packages/datastore/src/schema` — add `gate_baselines` Drizzle model.
- `packages/datastore/src/data-store.ts` — `readBaseline(tool)` / `writeBaseline(tool, payload)` on the DataStore interface.
- Fit gate save/compare path — flip from `paths.baselinePath` to datastore.
- Graph gate save/compare path — flip from `paths.graphBaselinePath` to datastore.
- `packages/core/src/lib/paths.ts` — remove the two baseline path entries (or keep them for the export command — see below).

### External-consumer concession

Some users may have CI flows that read `baseline.sarif` directly (e.g., `gh code-scanning upload-sarif`). To preserve that:

- `opensip-tools fit baseline export --format sarif --out <path>` writes the SARIF baseline from SQLite to a file on demand.
- `opensip-tools graph baseline export --format json --out <path>` likewise for graph.

These commands also enable the "I want to commit my baseline to git" workflow — `--out opensip-tools/baseline.sarif` then `git add` it.

### One-shot import on upgrade

On first run after this migration ships, if a baseline file exists at the legacy path AND no baseline row exists in SQLite for that tool: slurp the file into SQLite, log the migration, leave the file in place with a `.migrated` sibling marker. (Not deleting the file gives the user time to verify; they remove it when ready.) Idempotent: marker presence skips re-import.

## Risks

- **Customers committing baseline files to git** — the import step preserves the file, so this is non-destructive. The export command supports the workflow going forward.
- **External tools expecting the file on disk** — addressed by the export command.
- **Schema migration on the existing `datastore.sqlite`** — the datastore package already has a migrations story; this is one more entry.

## Not in scope

- Migrating the SARIF *report output* (`*.runtime/reports/*`). Those stay as files — they're external deliverables, not internal state.
- Multi-baseline (per-branch, per-environment). Add later if a use case appears.
- A `--no-export-fallback` flag — premature; nobody's asked for it.

## Sequencing

Independent of the marker-based plugin discovery + new customer layout work. Can run in parallel via a subagent in an isolated worktree once the marker plan is approved and the main work is in flight; otherwise sequenced after.

## When to formalize

Promote to `docs/plans/ready/baseline-storage-migration/` (folder + phase files) when ready to execute. This brief is the seed; phases will spell out (1) schema + datastore API, (2) fit gate cutover + tests, (3) graph gate cutover + tests, (4) export commands, (5) auto-import + path-resolver cleanup, (6) docs + release notes.
