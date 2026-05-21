# Persistence migration — JSON files to SQLite + Drizzle (v2)

Replace JSON-file runtime persistence (`opensip-tools/.runtime/`) with a unified `DataStore` abstraction backed by SQLite via Drizzle ORM. Hard cut at v2.0.0; no data migration.

## Problem

opensip-tools persists internal runtime state as JSON files. This worked at v1 scale but no longer fits the access patterns:

- `packages/graph/engine/src/cache/read.ts:36` rehydrates the entire catalog via `readFileSync + JSON.parse` on every warm run. The catalog is **38MB** in this repo today; on a large monorepo it extrapolates to GB-scale.
- Sessions accrete as one-JSON-file-per-run under `.runtime/sessions/`. `sessions list` is a directory scan; no indexed queries, no time-range filters.
- The dashboard generator (`packages/contracts/src/persistence/dashboard/`) builds rich derivations — SCCs, coupling, hot functions, traces — as in-memory passes over the loaded catalog rather than as SQL queries.
- Every tool reaches directly into `node:fs` for persistence; there's no abstraction seam, no test isolation, no central schema versioning.

The first-order pain is catalog read time. The second-order pain is the architectural debt that blocks any structural fix.

## Target State

A new `@opensip-tools/datastore` package between `core` and `contracts` exposes a `DataStore` interface backed by SQLite. Each tool owns its own Drizzle schema (sessions in contracts; catalog + baseline in graph; file-cache + baseline in fitness). The CLI bootstrap opens one DataStore per invocation, passes it through `ToolCliContext`, and closes it on shutdown.

After the migration:

- `opensip-tools/.runtime/datastore.sqlite` is the single binary store for tool-produced data.
- `cache/read.ts`, `cache/write.ts`, `cache/normalize.ts` are deleted.
- `persistence/store.ts` is a thin facade over `SessionRepo`.
- Both `gate.ts` files (graph + fitness) use repository APIs.
- v1's `.runtime/` JSON layout is **not migrated**. v2 ignores v1 state; users wanting old data stay on v1.x.
- Logs, dashboard HTML reports, SARIF, `--json` output, user-authored content (`opensip-tools.config.yml`, recipes, scenarios, custom checks) all stay as files.

## Design Principles

**No backwards compatibility.** v2 is a hard cut. No JSON-fallback code paths, no feature flags, no compatibility shims.

**No data migration.** Runtime state under `.runtime/` is already classified as ephemeral (gitignored, rebuildable). A JSON → SQLite migrator is one-release dead code with no reusable payoff. Document the break in CHANGELOG; SemVer is the contract.

**One paradigm, one dialect, one query layer.** Relational, SQLite, Drizzle. No Postgres backend (opensip is the separate SaaS product). No JSON-as-backend adapter (paradigm-bridging adapters collapse to lowest common denominator).

**Tool-produced data → SQLite. Everything else stays as files.** The "regenerate or lost?" litmus test: if deleting `datastore.sqlite` should rebuild automatically, it belongs there. If deletion is data loss (user authored, source, contract output), it stays as a file.

**Schemas live with their owners.** Datastore is paradigm-agnostic infrastructure. `@opensip-tools/contracts` owns the sessions schema. `@opensip-tools/graph` owns catalog and baseline schemas. `@opensip-tools/fitness` owns file-cache and baseline schemas. Adding a new tool means adding a new schema module; no datastore changes.

**Architectural compliance, observability, hardening, audit, and pattern decisions.** opensip-tools does not have the OpenSIP backend's downstream plan-improvements pipeline. Compliance concerns that *do* apply (dependency-cruiser layer rules, ESLint enforcement, the existing 0-error lint policy from `CLAUDE.md`) are exercised through normal `pnpm lint` runs at every phase; they are not pre-baked into task descriptions.

**Logger event parity.** Existing persistence call sites emit structured logger events with stable `evt:` names (e.g., `graph.cache.read.hit`, `graph.cache.write.complete`, `graph.cache.read.miss`, `graph.cache.write.error`). Every repository introduced in this plan must emit equivalent events on the equivalent operations (read hit, read miss, write complete, write error) with the same naming pattern (`<tool>.<concern>.<op>.<outcome>`). Observability must not regress with the storage swap. This is a cross-cutting requirement; each repo task in Phases 1–4 carries a one-line reminder, but the policy is set here.

**Plugin contract for `ctx.datastore` is narrow in v2.** Third-party tool plugins (npm packages with `opensipTools.kind === 'tool'`) receive `ToolCliContext.datastore` after the migration. The contract is **read/write via the Drizzle handle for transient operations only**. Plugin-declared schemas (i.e., a plugin shipping its own Drizzle tables and contributing migrations) are **not supported in v2** — the workspace's `drizzle.config.ts` is build-time and cannot pick up schemas from arbitrary npm packages at install time. Tool plugins requiring persistent state of their own should manage a separate SQLite file under a path they own. This is an explicit limitation, not an oversight; lifting it is feature work for a future minor.

**What "plugin" means here.** The rule above applies specifically to *tool plugins* — npm packages declaring `opensipTools.kind === 'tool'` that integrate as whole tools alongside `fit`, `sim`, `graph` (future examples per CLAUDE.md: `audit`, `lint`, `bench`). The rule does **not** apply to *within-tool extensions* — fitness checks, sim scenarios, graph rules, language adapters. Within-tool extensions receive their tool's execution context (not `ToolCliContext`) and are stateless from the plugin author's perspective. **Their outputs are persisted automatically by the parent tool's framework** — for fitness checks (project-local `.mjs` files under `opensip-tools/fit/checks/` or npm packages declared in `plugins.fit`), the returned `CheckViolation[]` lands in `session_findings` rows joinable by `check_slug`, identically to built-in checks. The fit file-cache (`fit_file_cache`) covers custom checks too — outputs for unchanged files are reused on subsequent runs via the `(file_path, content_hash, check_slug)` composite key. Same shape applies to sim scenarios (scenario outputs → session) and graph rules (signals → `graph_baseline_signals` when a baseline is saved). Check / scenario / rule authors don't need to know the datastore exists; their findings do, via the framework. The pre-existing constraint that `session_findings` rows carry a fixed shape (`rule_id, message, severity, file_path, line, column`) and have no freeform metadata column is unchanged from v1 — a future minor could add a generic `metadata: text json-mode` column for richer per-finding payloads, but that's feature work, not migration work.

The long-form architectural reasoning (Drizzle vs raw SQL, rejection of paradigm-bridging adapters, why no Postgres, the Drizzle margin honest reassessment) lives in [`decisions.md`](./decisions.md).

## Phases

| Phase | Name | Description | Depends On |
|-------|------|-------------|------------|
| 0 | Datastore foundation | New `@opensip-tools/datastore` package; `DataStore` interface; SQLite + in-memory backends; Drizzle wiring; layer policy update | — |
| 1 | Sessions on datastore | Sessions schema in contracts; rewrite `store.ts` as facade; extend `ToolCliContext`; CLI commands; dashboard hookup | 0 |
| 2 | Graph baseline on datastore | Graph `persistence/` module; `BaselineRepo`; rewrite `graph/gate.ts` | 0 |
| 3 | Graph catalog on datastore (parity) | Catalog schema; `CatalogRepo`; rewrite orchestrator; fingerprint storage; delete `cache/read.ts`+`cache/write.ts`+`cache/normalize.ts` | 0, 2 |
| 4 | Fit file-cache and baseline | Fitness `persistence/` module; `FileCacheRepo`+`BaselineRepo`; rewrite `fitness/gate.ts` and `file-cache.ts` | 0 |
| 5 | Cleanup, CHANGELOG, version bump | CHANGELOG, README upgrade, fixture cleanup, workspace version bump (architecture-docs work moves to Phase 6) | 1, 2, 3, 4 |
| 6 | Architecture docs and web sync | Rewrite affected docs in `docs/architecture/`; sweep stale references; run `pnpm docs:build` to regenerate `docs/web/`; `docs:check` green | 1, 2, 3, 4, 5 |
| 7 | Tests | Scaffold — unit + integration coverage for every phase | 0–6 |
| 8 | Validation | Scaffold — end-to-end against real SQLite-on-disk; dashboard tests as regression net | 0–7 |
| 9 | NPM publish (OIDC bootstrap) | Maintainer issues short-lived token → run `tools/bootstrap-publish.sh` → maintainer configures trusted publishers via npmjs.com web UI → delete token → tag-driven OIDC release | 8 |

Notes:
- **Catalog perf work** (sharded reads, view derivations to SQL, content-addressed dedup, incremental rebuild) is explicitly **out of scope** for this plan. It lands as a follow-up: anticipated `docs/plans/graph-catalog-perf/`. This plan delivers SQLite-at-parity for the catalog; the follow-up delivers the perf wins.
- Phases 2 and 4 are independent of each other and of Phase 1; they may run in parallel after Phase 0.
- **Phase 9 (NPM publish) lands after Validation** — a deliberate deviation from the backend-plan skill's "nothing after Validation" convention. opensip-tools' OIDC bootstrap for new packages (per `RELEASING.md:114-152`) is a planned, multi-step deployment handshake unique to this project; capturing it in the plan keeps the release contract auditable. The bootstrap is required this release because `@opensip-tools/datastore` is new.

## Dependency Graph

```
Phase 0 (Datastore foundation)
├── Phase 1 (Sessions on datastore)
├── Phase 2 (Graph baseline on datastore)
│     └── Phase 3 (Graph catalog on datastore — parity)
└── Phase 4 (Fit file-cache and baseline)
                                              ↓
                          Phase 5 (Cleanup, CHANGELOG, version bump)
                                              ↓
                          Phase 6 (Architecture docs and web sync)
                                              ↓
                                    Phase 7 (Tests)
                                              ↓
                                  Phase 8 (Validation)
                                              ↓
                              Phase 9 (NPM publish via OIDC bootstrap)
```

Phases 1, 2, and 4 are independent after Phase 0. Phase 3 depends on Phase 2 (shares the graph `persistence/` module). Phases 1, 3, and 4 can be merged in any order before Phase 5. Phase 6 (architecture docs) depends on Phase 5 because the manifest's `version` field is derived from the workspace version bumped in Phase 5 Task 5.4. Phase 9 depends on Phase 8 — never publish unvalidated bits.

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | `packages/datastore/` (entire new package: package.json, tsconfig, vitest.config, drizzle.config, src/index.ts, src/data-store.ts, src/factory.ts, src/backends/sqlite.ts, src/backends/memory.ts, migrations/, tests) | `.dependency-cruiser.cjs`, root `tsconfig.json`, `turbo.json` (verify), `RELEASING.md` |
| 1 | `packages/contracts/src/persistence/schema/sessions.ts`, `schema/index.ts`, `session-repo.ts` | `packages/contracts/src/persistence/store.ts`, `dashboard/sessions.ts`, `dashboard/generator.ts`, `index.ts`, `package.json`; `packages/cli/src/index.ts`, `commands/uninstall.ts`, `commands/sessions.ts` (or wherever list/purge live), `package.json`; `packages/core/src/tools/types.ts` |
| 2 | `packages/graph/engine/src/persistence/index.ts`, `schema.ts`, `baseline-repo.ts` | `packages/graph/engine/src/gate.ts`, `package.json` |
| 3 | `packages/graph/engine/src/persistence/catalog-repo.ts`; additions to existing `schema.ts` | `packages/graph/engine/src/cli/orchestrate.ts`, `cache/invalidate.ts`, `pipeline/indexes.ts` |
| 3 (deletes) | — | Delete: `packages/graph/engine/src/cache/read.ts`, `cache/write.ts`, `cache/normalize.ts` |
| 4 | `packages/fitness/engine/src/persistence/index.ts`, `schema.ts`, `baseline-repo.ts`, `file-cache-repo.ts` | `packages/fitness/engine/src/gate.ts`, `framework/file-cache.ts`, `package.json` |
| 5 | `CHANGELOG.md` v2.0.0 entry | `README.md`, `RELEASING.md` (confirm), root `package.json` (version bump), every workspace `package.json` (version bump), test fixtures under `packages/cli/src/__tests__/fixtures/*/opensip-tools/.runtime/` |
| 6 | — | `docs/architecture/50-runtime/03-session-and-persistence.md`, `docs/architecture/90-conventions/02-layer-policy.md`, possibly other architecture docs (grep-driven sweep); regenerated `docs/web/**/*` and `docs/web/manifest.json` (via `pnpm docs:build`) |
| 7 | Test files alongside new source files (`__tests__/*.test.ts`) | Test updates in dashboard tests, gate tests, session tests |
| 8 | — | — (validation scaffolding only) |
| 9 | — | — (publish actions only; no repo files modified) |

## Critical Files Reference

| File | Role | Key Structures |
|------|------|----------------|
| `packages/graph/engine/src/cache/read.ts` | Catalog JSON reader (to be deleted, Phase 3) | `readCatalog(catalogPath: string): Catalog \| null` at line 25 |
| `packages/graph/engine/src/cache/write.ts` | Streamed catalog JSON writer (to be deleted, Phase 3) | `writeCatalog(catalogPath, catalog)` at line 36; streaming logic at lines 71–148 |
| `packages/graph/engine/src/cache/normalize.ts` | Helper for the streamed writer (to be deleted, Phase 3) | Consumed only by `write.ts`; tests reference directly |
| `packages/graph/engine/src/cache/invalidate.ts` | Fingerprint algorithm + classifier (to be modified, Phase 3) | `computeFilesFingerprint`, `classifyCatalog` |
| `packages/graph/engine/src/gate.ts` | Graph baseline I/O (to be rewritten, Phase 2) | `BaselineFile` at line 17; `saveBaseline(signals, baselinePath)` at line 34; `compareToBaseline(...)` at line 59; `GateCompareResult` at line 24 |
| `packages/graph/engine/src/cli/orchestrate.ts` | Pipeline orchestrator (modified Phase 3) | `runGraph(input: RunGraphInput): Promise<RunGraphResult>`; calls `readCatalog`/`writeCatalog` today |
| `packages/graph/engine/src/pipeline/indexes.ts` | In-memory catalog indexes (modified Phase 3 at parity) | `buildIndexes(catalog): Indexes` — at parity, still in-memory; perf follow-up rewrites |
| `packages/contracts/src/persistence/store.ts` | Sessions JSON store + global path config (to be rewritten, Phase 1) | `StoredSession` interface; `configurePersistencePaths(paths)` at line 92; mutable singleton state |
| `packages/contracts/src/persistence/dashboard/generator.ts` | Dashboard HTML generator (modified Phase 1) | Reads sessions + catalog data to produce HTML |
| `packages/contracts/src/persistence/dashboard/sessions.ts` | Session-list rendering for dashboard (modified Phase 1) | Reads from store today; reads from `SessionRepo` after migration |
| `packages/fitness/engine/src/gate.ts` | Fit baseline I/O (to be rewritten, Phase 4) | `saveBaseline(output: CliOutput, baselinePath)` at line ~104; `compareToBaseline(output: CliOutput, baselinePath): GateCompareResult` at line ~123; stores **full SARIF document** as a single JSON file, not normalized findings |
| `packages/fitness/engine/src/framework/file-cache.ts` | Fit file-cache (persistent — modified Phase 4) | Reads/writes cache entries; confirmed persistent during research |
| `packages/cli/src/index.ts` | CLI bootstrap (modified Phase 1) | `resolveProjectPaths(cwd)` at line 236; `configurePersistencePaths(projectPaths)` at line 238 (removed in Phase 1); `buildToolCliContext()` at line 247; `sessions list` at line 386, `sessions purge` at line 395 (both inline, modified in Phase 1 Task 1.6) |
| `packages/cli/src/commands/uninstall.ts` | Uninstall flow (inspect-only, Phase 1 Task 1.7) | Already does `rm -rf <project>/opensip-tools/` in `--project` mode (per header comment lines 12–22), which transitively covers `.runtime/datastore.sqlite` and its WAL sidecars |
| `packages/core/src/tools/types.ts` | `ToolCliContext` type (modified Phase 1) | `interface ToolCliContext` at line 60 — gains `datastore: DataStore` field |
| `packages/core/src/lib/paths.ts` | Project path resolver (unchanged) | `ProjectPaths` interface; `runtimeDir` already exposed — no change needed |
| `packages/datastore/src/data-store.ts` (new — Phase 0) | DataStore interface (**synchronous** — better-sqlite3 is sync) | `interface DataStore` with Drizzle handle, sync `close()`, sync `transaction()` |
| `packages/datastore/src/factory.ts` (new — Phase 0) | DataStore construction | `DataStoreFactory.open(opts): DataStore` — synchronous; applies migrations at open |
| `.dependency-cruiser.cjs` | Layer-policy enforcement (modified Phase 0) | Add `@opensip-tools/datastore` between `core` and `contracts`; datastore depends only on core |
| `docs/architecture/50-runtime/03-session-and-persistence.md` | Source-of-truth doc for session+persistence runtime (rewritten Phase 6) | `docs/web/` mirror regenerated via `pnpm docs:build` |
| `docs/architecture/90-conventions/02-layer-policy.md` | Source-of-truth doc for layer policy (modified Phase 6) | Adds datastore layer to the diagram + policy |
| `docs/web/manifest.json` | Generated manifest for opensip.ai integration (regenerated Phase 6) | `version` + `rawBase` updated to v2.0.0 |
| `tools/build-web-docs.mjs` | Web-sync script (unchanged; invoked Phase 6) | `pnpm docs:build` runs this; `pnpm docs:check` is the CI sync check |
| `tools/bootstrap-publish.sh` | OIDC bootstrap publish script (unchanged; invoked Phase 9) | Idempotent. Iterates 18 packages in dependency order; publishes any missing versions with the supplied `NPM_TOKEN`; prints links to trusted-publisher settings pages for newly-created packages |
| `RELEASING.md` | Release procedure reference | Bootstrap workflow at lines 132–152; OIDC handoff at 151–152 |

## Release Atomicity and Partial-State Policy

**Phases 1, 2, 3, and 4 ship together as v2.0.0. There is no intermediate published release.** The dependency graph permits parallel work after Phase 0 — Phases 1, 2/3, and 4 are independent — but the **published artifact** is the unified set.

Why this matters: each of Phases 1–4 swaps one persistence concern from JSON to SQLite. If Phase 3 (graph catalog) merged but Phase 4 (fit file-cache + baseline) stalled, the workspace would still produce v1-shape `fit_baseline` JSON alongside the v2-shape `datastore.sqlite` — a hybrid that is harder to document, harder to debug, and not what the CHANGELOG describes.

Operational consequences:

- **Branch model.** Implementer should land Phases 0–4 on a long-lived `v2` branch. Each phase commits to that branch; the branch is rebased onto `main` only when all four phases are green. Phases 5–9 then run on the `v2` branch in order.
- **Half-state during development is acceptable on the `v2` branch.** Phase 1 can land before Phase 4 on the branch; the workspace will produce both SQLite sessions and JSON fit baselines mid-migration. Tests during this window cover only the migrated concerns; the unmigrated ones keep their v1 tests until their phase lands.
- **Rollback within v2 development.** If Phase 3 hits a blocker (e.g. the catalog parity benchmark in Phase 8 Task 8.1 regresses past the 1.5× threshold and can't be recovered), the recovery is to revert the Phase 3 commits on the `v2` branch and pause the release. Phases 1, 2, and 4 stay on the branch — they are independent and shouldn't be reverted to "match." A v2 release without graph catalog migration would still be a coherent step (sessions + graph baseline + fit cache + fit baseline all on SQLite; graph catalog still JSON), but **only if the CHANGELOG and architecture docs are updated to match** before publish. Default assumption: don't ship partial; pause and resolve.
- **Post-publish rollback.** Once v2.0.0 is on npm (Phase 9), there is no rollback — npm unpublish is restricted and SemVer doesn't allow re-using the version. Issues found post-publish are fixed by v2.0.1+, never by reverting the schema migration. This is why Phase 8 (Validation) is non-negotiable before Phase 9.

## Per-Task Verification Standard

At the end of every task, run:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

`pnpm lint` runs both ESLint and dependency-cruiser; both must be 0-error per `CLAUDE.md`. Phase-specific verification commands appear in each phase file.
