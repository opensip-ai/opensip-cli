# Phase 3: Graph catalog on datastore (parity)

**Goal:** Move the graph catalog from `catalog.json` to SQLite at **parity** with today's behavior. No perf wins yet — those are deferred to the follow-up plan (`docs/plans/graph-catalog-perf/`, anticipated). Dashboard tests are the regression gate.
**Depends on:** Phase 0, Phase 2 (shares the graph `persistence/` module)

This is the structural heart of the migration. Catalog is the largest object (~38MB JSON in this repo) and the dashboard's coupling/SCC/hot/trace derivations all read from it. The goal here is correctness; speed comes later.

## Pre-phase prerequisite: capture v1 baseline timings

Before any task in this phase begins, **the implementing agent must capture v1 catalog timing numbers from `main`** for the Phase 8 parity comparison. These numbers cannot be measured after Phase 3 lands.

```bash
# From main, before Phase 3 work:
git stash                                                     # if you have phase-0..2 work staged
git checkout main && pnpm install && pnpm build

# Take median of 3 for each metric — single readings are too noisy to compare against
# the 1.5× / 1.2× thresholds in Phase 8 Task 8.1. Quiesce the machine between runs.
for i in 1 2 3; do
  rm -rf opensip-tools/.runtime
  time pnpm graph                                             # COLD run #i
done
for i in 1 2 3; do
  time pnpm graph                                             # WARM run #i (cache populated by the last cold run)
done

# Record COLD median, WARM median in a comment block at the top of phase-8-validation.md
# (or in a tracking issue) so Phase 8 Task 8.1 can compare against them.
git checkout - && git stash pop                               # back to your work
```

Phase 8 Task 8.1 will compare v2 medians against these v1 medians. Without this measurement, "parity" cannot be verified objectively.

## Locked design calls (resolved before phase begins)

Two decisions need to be made up front; both are answered here rather than deferred to PR scoping.

### Whole-catalog write at end of pipeline (not per-package incremental)

Today's pipeline produces one `Catalog` value at the end and writes it via `writeCatalog(catalogPath, catalog)`. v1 has no per-package write boundary; the `--packages` runner spawns N child processes that each produce a full catalog in isolation (per `cli/packages-runner.ts:14-19`).

For parity, **the SQLite write mirrors this**: at end of pipeline, the orchestrator calls `catalogRepo.replaceAll(catalog)`, which atomically truncates and re-inserts the entire catalog state for the run's scope. Per-package incremental writes are explicitly deferred to the catalog-perf follow-up plan — that's where the `--packages` runner's parallelism becomes worth exploiting at the storage layer.

### Legacy `Catalog` reconstruction at parity

`pipeline/indexes.ts:buildIndexes(catalog: Catalog): Indexes` consumes `catalog.functions: Record<string, FunctionOccurrence[]>` plus metadata (`cacheKey`, `language`, `builtAt`, etc. per `types.ts` line 120). At parity, `CatalogRepo.loadFullCatalog()` returns this same legacy shape — reconstructed from the normalized tables in **one query plus one assembly pass**:

```ts
// Pseudocode for loadFullCatalog():
const rows = db.select({
  qualifiedName: occurrences.qualifiedName,
  bodyHash: occurrences.bodyHash,
  simpleName: occurrences.simpleName,
  filePath: occurrences.filePath,
  line: occurrences.line,
  column: occurrences.column,
  // ...occurrence fields
  language: functions.language,
  bodySize: functions.bodySize,
}).from(occurrences).innerJoin(functions, eq(occurrences.bodyHash, functions.bodyHash)).all();

const functionsRecord: Record<string, FunctionOccurrence[]> = {};
for (const row of rows) {
  const bucket = functionsRecord[row.qualifiedName] ??= [];
  bucket.push(rowToOccurrence(row));
}

// Edges are a separate query joined into the occurrences they belong to (the
// existing FunctionOccurrence shape carries call edges).
// Metadata (language, builtAt, cacheKey) is derived: language from
// catalog_functions (all rows share one language per scope), builtAt from
// catalog_fingerprints' max(built_at), cacheKey from the fingerprint row.
return { version: '3.0', tool: 'graph', language, cacheKey, builtAt, functions: functionsRecord };
```

`pipeline/indexes.ts` is unchanged — it consumes the same `Catalog` shape. This isolates the migration's blast radius to the repo's mapping code. The catalog-perf follow-up replaces this reconstruction with view-targeted queries.

---

## Task 3.1: Add catalog tables to the graph schema

**Files:** [size: M]
- Modify: `packages/graph/engine/src/persistence/schema.ts`

**Context:** The catalog has natural normalization: function identities (keyed by `bodyHash`, already content-addressed in the v3 catalog at `packages/graph/engine/src/cache/read.ts:23`), occurrences (per-file appearances of a function), edges (call relationships), and per-(language, package) fingerprints (for cache invalidation, mirroring `cache/invalidate.ts`'s `computeFilesFingerprint`).

**Steps:**

1. Read the existing `Catalog`, `FunctionOccurrence`, and edge types in `packages/graph/engine/src/types.ts` (Catalog interface at line 120) to confirm every field that needs to round-trip.
2. Add to the existing `schema.ts` (alongside `graph_baseline_signals` from Phase 2):
   - `catalog_functions(body_hash PK text, language text, body_size integer)` — content-addressed; one row per unique function body across the repo. Additional invariant-for-a-body fields go here as identified during the type-shape read.
   - `catalog_occurrences(id PK autoincrement integer, qualified_name text, simple_name text, body_hash text FK→catalog_functions.body_hash, file_path text, line integer, column integer)` — per-call-site fields.
   - `catalog_edges(id PK autoincrement integer, from_occurrence integer FK→catalog_occurrences.id on delete cascade, to_qualified_name text, resolution_kind text)` — `resolution_kind` is `'static' | 'dynamic' | 'unresolved'`.
   - `catalog_fingerprints(language text, package_dir text, files_fingerprint text, built_at integer (unix ms), composite PK (language, package_dir))` — replaces today's catalog `cacheKey` field as the cache-validity gate.
3. Add indexes:
   - `catalog_occurrences(file_path)` — supports per-file lookup (dashboard, fingerprint check)
   - `catalog_occurrences(qualified_name)` — supports dashboard's function-by-name queries; also the load-time GROUP BY in `loadFullCatalog`
   - `catalog_edges(from_occurrence)` — supports outgoing-call enumeration
   - `catalog_edges(to_qualified_name)` — supports incoming-call enumeration (the dashboard's coupling view)
4. The schema path is already appended to `drizzle.config.ts` (Phase 2 Task 2.1). Run `pnpm --filter=@opensip-tools/datastore db:generate` to produce the migration SQL. Read the generated SQL before committing to confirm column types, FK clauses, and index DDL.

**Wiring:** Consumed by `catalog-repo.ts` (Task 3.2). Migrations apply at DataStore open.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build
pnpm --filter=@opensip-tools/datastore db:generate
pnpm --filter=@opensip-tools/datastore db:check
```

**Commit:** `feat(graph): add catalog tables to Drizzle schema`

---

## Task 3.2: Implement `CatalogRepo`

**Files:** [size: L]
- Create: `packages/graph/engine/src/persistence/catalog-repo.ts`

**Context:** This is the biggest single repo class in the migration. It must support every operation that today's `readCatalog`/`writeCatalog`/`buildIndexes` combo does — at parity. Per-PR scoping for the catalog perf follow-up will push computation into SQL; here we just make the existing computations correct over a SQLite-backed catalog.

Be deliberate about what's in this PR vs the perf follow-up:

- **In this PR:** whole-catalog write at end of pipeline (per the locked design call above), whole-catalog read for `buildIndexes` at parity, fingerprint storage.
- **In the perf follow-up:** per-package incremental writes, view-specific queries (per-function-coupling, hot-functions-by-call-count, SCC enumeration via recursive CTE), incremental file invalidation.

**Steps:**

1. Define `class CatalogRepo` constructed with `(datastore: DataStore)`.
2. Write-side — **one method, synchronous, transactional**:
   - `replaceAll(catalog: Catalog): void` — wraps the following in `datastore.transaction(tx => { ... })`:
     1. `tx.delete(catalogEdges).run(); tx.delete(catalogOccurrences).run(); tx.delete(catalogFunctions).run();` — order matters for FK constraints; reverse-dependency order.
     2. `tx.insert(catalogFunctions).values(uniqueByBodyHash(catalog.functions)).run();` — dedupe occurrences by `bodyHash` and insert the function-shape fields (language, bodySize) once per hash.
     3. `tx.insert(catalogOccurrences).values(allOccurrences(catalog.functions)).returning({ id, qualifiedName, bodyHash }).all();` — capture generated occurrence IDs for the edge insert.
     4. Map each occurrence's outgoing edges (the existing `FunctionOccurrence` shape carries them) to `(from_occurrence: <generated id>, to_qualified_name, resolution_kind)` rows. `tx.insert(catalogEdges).values(edgeRows).run();`
3. Read-side — **synchronous**:
   - `loadFullCatalog(): Catalog | null` — implements the reconstruction sketched in "Locked design calls" above. Returns null when `catalog_functions` is empty (cache miss).
   - `setFingerprint(language: string, packageDir: string, fingerprint: string): void` — upsert via `INSERT ... ON CONFLICT(language, package_dir) DO UPDATE SET files_fingerprint = excluded.files_fingerprint, built_at = excluded.built_at`.
   - `getFingerprint(language: string, packageDir: string): string | null` — single-row select.
   - `hasAnyCatalog(): boolean` — `SELECT 1 FROM catalog_functions LIMIT 1`.
4. Co-locate row ↔ domain mapping helpers (`rowToOccurrence`, `occurrenceToRow`, etc.) inside this file. Do not leak Drizzle column names outside the repo.
5. **Do not** add per-view query methods (`getCouplingFor(...)`, `enumerateSCCs()`, etc.) in this phase. Those belong to the catalog-perf follow-up.
6. The "whole-catalog write" pattern is intentionally non-incremental. The `--packages` runner's children each call `replaceAll` for their own scope — under WAL mode this is safe but serialized. The perf follow-up replaces this with per-package incremental writes.
7. **Emit logger events** per the plan's logger-event-parity convention, mirroring the v1 events that lived in `cache/read.ts` and `cache/write.ts`: `graph.catalog.read.hit` (include `functions` count, matching v1's `cache/read.ts:67`), `graph.catalog.read.miss` (include `reason` field: `'empty-catalog'`, `'fingerprint-mismatch'`), `graph.catalog.write.complete` (include row counts), `graph.catalog.*.error` on thrown errors.

**Wiring:** Consumed by `orchestrate.ts` (Task 3.3) and `cache/invalidate.ts` (Task 3.4). The dashboard's view-derivation modules under `packages/contracts/src/persistence/dashboard/code-paths/` keep calling `loadFullCatalog()` at parity in this PR; they migrate to targeted queries in the follow-up.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/graph typecheck
```

**Commit:** `feat(graph): implement CatalogRepo over DataStore (parity)`

---

## Task 3.3: Rewrite the orchestrator's catalog I/O (and the dashboard's catalog read)

**Files:** [size: M]
- Modify: `packages/graph/engine/src/cli/orchestrate.ts`
- Modify: `packages/fitness/engine/src/cli/dashboard.ts` — swap the catalog read path that Phase 1 deliberately deferred (see Phase 1 Task 1.6 step 6). Note: contracts is pure — it receives the parsed catalog as a `generateDashboardHtml` argument; the actual catalog read lives in the fitness dashboard CLI command (`loadGraphCatalog` at `dashboard.ts:98`, which today reads `paths.graphCatalogPath` via `readFileSync`+`JSON.parse`). No layer-policy change needed; fitness already depends on graph.

**Context:** `runGraph(input)` in `orchestrate.ts` is the pipeline entry point. Today it calls `readCatalog(catalogPath)` and `writeCatalog(catalogPath, catalog)` (imported from `cache/read.ts`+`cache/write.ts`, both deleted in Task 3.5). After this task, it works directly against the `CatalogRepo`.

**Steps:**

1. Read `orchestrate.ts` end-to-end to map every call to `readCatalog`/`writeCatalog`. Locate all import sites.
2. Replace `readCatalog(catalogPath)` calls with `catalogRepo.loadFullCatalog()`. Return-value semantics: `null` means cache miss (existing code today checks against `null` from `readCatalog`).
3. Replace `writeCatalog(catalogPath, catalog)` calls with **`catalogRepo.replaceAll(catalog)`** — whole-catalog write at end of pipeline, mirroring v1's single-file semantics. (Per the "Locked design calls" section above; per-package incremental writes are deferred to the catalog-perf follow-up.)
4. Accept a `CatalogRepo` instance via `RunGraphInput` (or construct from `ctx.datastore`); thread it through the pipeline stages that need it. The repo is constructed once per run by the caller, not per-stage.
5. Drop the `catalogPath` argument from `RunGraphInput`. Update internal pipeline types that mentioned it.
6. Fingerprint storage: `setFingerprint(language, packageDir, computeFilesFingerprint(...))` at end of run; this previously lived as the catalog's embedded `cacheKey` field.
7. **Swap the dashboard's catalog read path.** In `packages/fitness/engine/src/cli/dashboard.ts`, replace `loadGraphCatalog(projectDir)` (the helper at line 98 that does `existsSync` + `readFileSync` + `JSON.parse` on `paths.graphCatalogPath`) with a call that constructs a `CatalogRepo` from `ctx.datastore` and returns `repo.loadFullCatalog()`. Preserve the existing logger events (`graph.dashboard.catalog.load`, `graph.dashboard.catalog.parse-error`) — the `parse-error` variant becomes effectively unreachable but keep the call shape so observability schemas are stable. The downstream `generateDashboardHtml(sessions, catalog, recipes, graphCatalog, editorProtocol)` call at line 152 is unchanged — it still receives a parsed `GraphCatalog` object. **This step is what allows Task 3.5 to delete `cache/read.ts` without breaking the dashboard.**

**Wiring:** Callers of `runGraph` (the `graph` CLI command, the `--packages` runner) pass through the `ToolCliContext.datastore`. The packages runner already spawns child processes — each child opens its own DataStore on the shared `.runtime/datastore.sqlite` file in WAL mode, which is concurrent-safe (verify by smoke-testing the packages runner).

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/graph typecheck
pnpm graph                                   # warm run; should write/read from SQLite
pnpm graph --packages                        # smoke: multi-process catalog access via WAL
```

**Commit:** `refactor(graph): orchestrator uses CatalogRepo instead of cache/read+write`

---

## Task 3.4: Move fingerprint storage to the table

**Files:** [size: M]
- Modify: `packages/graph/engine/src/cache/invalidate.ts`

**Context:** Today, the cache key (which encodes the language, the compiler version, and the files fingerprint) is embedded in the catalog JSON as `cacheKey` (see `cache/read.ts:23`). After migration, the fingerprint lives in the `catalog_fingerprints` table; the **algorithm** (`computeFilesFingerprint`) is unchanged, only its **storage** moves.

**Steps:**

1. Read `cache/invalidate.ts` to identify the two surfaces:
   - `computeFilesFingerprint(...)` — the algorithm. Keep as-is.
   - `classifyCatalog(...)` (or equivalent) — the classifier that decides cache-hit vs cache-miss. This needs to query `catalog_fingerprints` instead of reading `cachedCatalog.cacheKey`.
2. Change the classifier signature to accept `CatalogRepo` and use `repo.getFingerprint(language, packageDir)` for the comparison.
3. The `cacheKey` field on the legacy `Catalog` type is now derivable from `catalog_fingerprints`. Grep consumers: `grep -rn "\\.cacheKey\\b" packages/graph/engine/src --include="*.ts" | grep -v __tests__`. If consumers exist, either populate the field synthetically in `loadFullCatalog()` (e.g. the concat of (language, package_dir, files_fingerprint) for the run's scope) or drop the field. For parity-minimum-diff, populate it.

**Wiring:** Called by the orchestrator (Task 3.3) before deciding whether to rebuild.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/graph test
# Edit any source file in the repo, then:
pnpm graph                                   # should observe fingerprint mismatch, rebuild
pnpm graph                                   # warm hit on second run
```

**Commit:** `refactor(graph): fingerprint storage moves to catalog_fingerprints table`

---

## Task 3.5: Delete the JSON catalog code

**Files:** [size: S]
- Delete: `packages/graph/engine/src/cache/read.ts`
- Delete: `packages/graph/engine/src/cache/write.ts`
- Delete: `packages/graph/engine/src/cache/normalize.ts`
- Delete: `packages/graph/engine/src/__tests__/cache/read-write.test.ts` (consumed `normalize.ts`/`write.ts`)
- Delete: `packages/graph/engine/src/__tests__/cache/normalize.test.ts`

**Context:** `read.ts` and `write.ts` are the JSON-streaming readers/writers that the migration replaces. `normalize.ts` is consumed only by `write.ts` in production code; the only other consumers are the two test files listed below (verified during plan refinement via `grep -rn "from '.*cache/normalize\|cache/normalize.js" packages/graph/engine/src`). Their tests go too; equivalent coverage lands as `CatalogRepo` tests in Phase 7.

**Steps:**

1. Confirm by grep that no production code imports `cache/read`, `cache/write`, or `cache/normalize` anymore (everything migrated in Tasks 3.3 + 3.4):
   ```bash
   grep -rn "from '.*cache/(read|write|normalize)" packages/graph/engine/src --include="*.ts" | grep -v __tests__
   ```
   Expect no results.
2. Delete the three source files and the two test files.
3. Update `packages/graph/engine/src/index.ts` if it re-exports any deleted symbols.

**Wiring:** Strictly subtraction. The orchestrator and invalidate already migrated in prior tasks.

**Verification:**

```bash
pnpm build && pnpm typecheck && pnpm test
```

If any file still imports the deleted modules, the build fails — that's the signal to chase the missed call site.

**Commit:** `chore(graph): delete JSON catalog read/write/normalize`

---

## Task 3.6: Keep `pipeline/indexes.ts` at parity

**Files:** [size: S]
- Modify: `packages/graph/engine/src/pipeline/indexes.ts`

**Context:** `buildIndexes(catalog): Indexes` constructs in-memory maps (qualified-name → occurrence, file → occurrences, etc.) from the catalog. At parity, this function still builds in-memory maps — but its input is now the `Catalog` value returned by `CatalogRepo.loadFullCatalog()`, which has identical shape.

**Steps:**

1. By design (see "Locked design calls" at the top of this phase), `loadFullCatalog()` returns the **same `Catalog` shape** as today's `readCatalog`. `pipeline/indexes.ts` consumes that shape unchanged.
2. The only edit `indexes.ts` should need is a null-check on `loadFullCatalog()`'s return value — `null` is cache miss, which the existing call sites already handle (today `readCatalog` returns `null` on cache miss too).
3. No algorithmic changes here. The perf follow-up rewrites this module to query SQLite directly.

**Wiring:** Called by `orchestrate.ts` after `loadFullCatalog()`.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/graph typecheck && pnpm --filter=@opensip-tools/graph test
pnpm graph                                   # warm run
pnpm exec opensip-tools dashboard            # dashboard HTML generates without error
```

**Commit:** `refactor(graph): pipeline/indexes consumes CatalogRepo output (parity)`

---

## Phase 3 End-to-End Verification

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint
pnpm test
# Dashboard tests are the regression gate:
pnpm --filter=@opensip-tools/contracts test
# Smoke against this repo:
rm -rf opensip-tools/.runtime
pnpm graph                                   # cold rebuild into SQLite
pnpm graph                                   # warm cache hit
pnpm exec opensip-tools dashboard            # HTML matches structure of v1 dashboard
sqlite3 opensip-tools/.runtime/datastore.sqlite "SELECT COUNT(*) FROM catalog_functions;"
sqlite3 opensip-tools/.runtime/datastore.sqlite "SELECT COUNT(*) FROM catalog_occurrences;"
sqlite3 opensip-tools/.runtime/datastore.sqlite "SELECT COUNT(*) FROM catalog_edges;"
```

Expected state: catalog JSON files are not produced; all catalog state lives in SQLite tables. Dashboard derivations (SCC, coupling, hot, trace) produce equivalent HTML to v1.

**Parity benchmark:** measure cold-rebuild and warm-load times for this repo against v1 numbers. SQLite-at-parity should be **roughly equivalent**; meaningful regressions are a bug. Significant wins are unexpected at parity — they arrive in the perf follow-up. If a benchmark regresses materially, investigate (likely a missing index or unbatched insert) before considering Phase 3 complete.
