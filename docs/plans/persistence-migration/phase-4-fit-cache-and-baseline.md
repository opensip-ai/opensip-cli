# Phase 4: Fit file-cache and baseline on datastore

**Goal:** Migrate fitness's persistent state — the file-cache and the gate baseline — from JSON files to SQLite. Independent of Phases 1–3 (only depends on Phase 0); can run in parallel.
**Depends on:** Phase 0

Structurally mirrors Phase 2 (graph baseline) and follows the same patterns established in Phases 1–3.

---

## Task 4.1: Create the fitness persistence module and schemas

**Files:** [size: M]
- Create: `packages/fitness/engine/src/persistence/index.ts`
- Create: `packages/fitness/engine/src/persistence/schema.ts`
- Modify: `packages/fitness/engine/package.json` (add `@opensip-tools/datastore` and `drizzle-orm` deps)

**Context:** Two domain concerns:

- **`fit_file_cache`** — check-output that an analysis produced for a particular file at a particular content hash. Used as a memoization layer across runs.
- **`fit_baseline`** — the gate-set SARIF baseline used by `--gate-save`/`--gate-compare`. Verified shape: `gate.ts:104` writes the **full SARIF document** as a single JSON file via `writeFileSync(baselinePath, JSON.stringify(sarif, null, 2), 'utf8')`, and `gate.ts:132` reads the whole file back and `JSON.parse`s it. **Storage is a single document, not normalized findings.** The diff logic in `compareToBaseline` then extracts violations from the parsed SARIF.

For parity, `fit_baseline` is therefore a **single-row table holding the SARIF document**, not a row-per-finding table. Decomposing SARIF into rows would be a perf/feature change, not a parity migration.

**Steps:**

1. Add deps to `packages/fitness/engine/package.json`.
2. Read `packages/fitness/engine/src/gate.ts` (especially `GateCompareResult`, `GateViolation`, `saveBaseline`, `compareToBaseline`) to confirm the exact SARIF flow.
3. In `schema.ts`, declare:
   - `fit_file_cache(file_path text, content_hash text, check_slug text, result text json-mode, computed_at integer (unix ms), composite PK (file_path, content_hash, check_slug))` — the cache key is (file, content-of-file, which-check); the value is the check's serialized result.
   - `fit_baseline(id PK integer constant 1, sarif_payload text json-mode, captured_at integer (unix ms))` — a single-row table (PK constrained to `1`). Save overwrites row 1; load reads row 1; exists is "row 1 present?". This matches v1's single-file semantics with no schema design overhead.
4. Add index:
   - `fit_file_cache(file_path)` — supports per-file invalidation
5. Append `'../fitness/engine/src/persistence/schema.ts'` to the `schema` array in `packages/datastore/drizzle.config.ts`.
6. Run `pnpm --filter=@opensip-tools/datastore db:generate`.

**Wiring:** Consumed by `file-cache-repo.ts` (Task 4.3) and `baseline-repo.ts` (Task 4.2). Migrations apply at DataStore open.

**Verification:**

```bash
pnpm --filter=@opensip-tools/fitness build
pnpm --filter=@opensip-tools/datastore db:generate && pnpm --filter=@opensip-tools/datastore db:check
```

**Commit:** `feat(fitness): add file-cache and baseline Drizzle schemas`

---

## Task 4.2: Implement `FitBaselineRepo`

**Files:** [size: S]
- Create: `packages/fitness/engine/src/persistence/baseline-repo.ts`

**Context:** The fit baseline is a SARIF document, not a row-per-finding shape (verified in Task 4.1's context). The repo round-trips a single JSON blob. Comparison logic stays in `gate.ts` (functions `extractViolationsFromSarif`, `extractViolationsFromCliOutput`) and consumes the loaded SARIF directly.

**Steps:**

1. Define `class FitBaselineRepo` constructed with `(datastore: DataStore)`.
2. Methods — **all synchronous**:
   - `save(sarif: SarifLog): void` — `INSERT INTO fit_baseline (id, sarif_payload, captured_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET sarif_payload = excluded.sarif_payload, captured_at = excluded.captured_at`. Serialize the SARIF as JSON. The `SarifLog` type (or whatever `buildSarifLog` returns from `packages/fitness/engine/src/sarif.ts`) is the canonical shape.
   - `load(): SarifLog | null` — selects row 1; returns null if not present.
   - `exists(): boolean` — `SELECT 1 FROM fit_baseline WHERE id = 1`.
3. No mapping helpers needed — the payload is a single opaque JSON blob.

**Wiring:** Consumed by `gate.ts` (Task 4.4).

**Verification:**

```bash
pnpm --filter=@opensip-tools/fitness build && pnpm --filter=@opensip-tools/fitness typecheck
```

**Commit:** `feat(fitness): implement FitBaselineRepo`

---

## Task 4.3: Implement `FileCacheRepo`

**Files:** [size: M]
- Create: `packages/fitness/engine/src/persistence/file-cache-repo.ts`

**Context:** Verified during research that `framework/file-cache.ts` is persistent — it reads/writes cached check results across runs. The repo provides the read/write surface; the next task wires it into `file-cache.ts`.

**Steps:**

1. Read `packages/fitness/engine/src/framework/file-cache.ts` end-to-end to identify the existing API surface (what `file-cache.ts` exports today). The repo must support exactly those operations or a structural equivalent.
2. Define `class FitFileCacheRepo` with `(datastore: DataStore)`.
3. Implement at minimum:
   - `lookup(filePath: string, contentHash: string, checkSlug: string): CachedResult | null` — synchronous
   - `store(entry: { filePath, contentHash, checkSlug, result, computedAt }): void` — upsert on composite PK via `INSERT ... ON CONFLICT(file_path, content_hash, check_slug) DO UPDATE SET result = excluded.result, computed_at = excluded.computed_at`. Synchronous.
   - `invalidateFile(filePath: string): number` — delete all entries for a file (when content changes); returns rowcount. Synchronous.
   - `purge(olderThan: Date): number` — cleanup for stale entries. Synchronous.
4. Result serialization: store as JSON in `result` (mode: `'json'`). Define the round-trip shape clearly — the cached result must be small and self-contained (don't store full ASTs).

**Wiring:** Consumed by `framework/file-cache.ts` (Task 4.5).

**Verification:**

```bash
pnpm --filter=@opensip-tools/fitness build && pnpm --filter=@opensip-tools/fitness typecheck
```

**Commit:** `feat(fitness): implement FitFileCacheRepo`

---

## Task 4.4: Rewrite `gate.ts` to use `FitBaselineRepo`

**Files:** [size: M]
- Modify: `packages/fitness/engine/src/gate.ts`

**Context:** Today, `gate.ts:104` writes the SARIF baseline via `writeFileSync(baselinePath, JSON.stringify(sarif, null, 2), 'utf8')`, and `gate.ts:132` reads it via `readFileSync` + `JSON.parse`. The functions are `saveBaseline(output: CliOutput, baselinePath: string)` and `compareToBaseline(output: CliOutput, baselinePath: string): GateCompareResult`. After this task, both route through `FitBaselineRepo`. The diff logic (`extractViolationsFromSarif`, `extractViolationsFromCliOutput`, the matching by `(filePath, ruleId, message)` hash) stays unchanged — only the I/O moves.

**Steps:**

1. Read `gate.ts` end-to-end. Confirmed surface:
   - `saveBaseline(output: CliOutput, baselinePath: string): void` at line ~104
   - `compareToBaseline(output: CliOutput, baselinePath: string): GateCompareResult` at line ~123
   - `GateBaselineMissingError`, `GateBaselineInvalidError` exception classes
2. Remove `node:fs` imports (`existsSync`, `mkdirSync`, `readFileSync`, `writeFileSync`).
3. Change function signatures to take a `FitBaselineRepo`:
   - `saveBaseline(output: CliOutput, repo: FitBaselineRepo): void`
   - `compareToBaseline(output: CliOutput, repo: FitBaselineRepo): GateCompareResult`
4. Inside `saveBaseline`, replace `writeFileSync(...)` with `repo.save(buildSarifLog(output))`.
5. Inside `compareToBaseline`, replace `readFileSync` + `JSON.parse` with `const baselineDoc = repo.load()`. If `baselineDoc === null`, throw `GateBaselineMissingError` (preserving today's error semantics at lines 124-126). The downstream `extractViolationsFromSarif(baselineDoc, baselinePath)` call still works — pass a synthetic identifier for the second arg (e.g. `'<datastore>'`) since there's no file path anymore.
6. `GateBaselineInvalidError` becomes effectively unreachable (we control the encode/decode), but keep the class — it's part of the public exception surface. The `JSON.parse` try/catch at lines 134-138 can be deleted since `repo.load()` returns the already-parsed object.
7. The constant `DEFAULT_BASELINE_PATH` (`gate.ts:97`) becomes meaningless and should be removed. Audit consumers via `grep -rn "DEFAULT_BASELINE_PATH" packages/fitness packages/cli --include="*.ts"` and update them — the `--baseline <path>` CLI flag no longer makes sense in v2 (everything goes to the single datastore.sqlite); document the removal in the CHANGELOG (Phase 5).
8. Update all call sites. Grep: `grep -rn "saveBaseline\|compareToBaseline" packages/fitness packages/cli --include="*.ts" | grep -v __tests__`. Thread the repo from `ToolCliContext.datastore`.

**Wiring:** Gate commands invoked via `ToolCliContext.datastore`. The fitness tool's `register(cli, ctx)` constructs a `FitBaselineRepo` from `ctx.datastore` and passes it down.

**Verification:**

```bash
pnpm --filter=@opensip-tools/fitness build && pnpm --filter=@opensip-tools/fitness typecheck
pnpm fit --gate-save                         # writes to fit_baseline
pnpm fit --gate-compare                      # reads from fit_baseline
sqlite3 opensip-tools/.runtime/datastore.sqlite 'SELECT COUNT(*) FROM fit_baseline;'
```

**Commit:** `refactor(fitness): gate uses FitBaselineRepo instead of baseline.json`

---

## Task 4.5: Wire `framework/file-cache.ts` to `FitFileCacheRepo`

**Files:** [size: M]
- Modify: `packages/fitness/engine/src/framework/file-cache.ts`

**Context:** `file-cache.ts` currently implements the persistent cache directly. After this task, it delegates persistence to `FitFileCacheRepo` while preserving its higher-level semantics (when to invalidate, how content hashes are computed, in-process LRU above the repo if there is one).

**Steps:**

1. Re-read `file-cache.ts` end-to-end. Distinguish:
   - **In-process LRU / memoization logic** — stays here.
   - **Persistence calls** (`fs.writeFile` / `fs.readFile` / disk-format encoding) — moves to the repo.
2. Replace persistence calls with `FitFileCacheRepo` calls. Keep the in-process layer intact for warm-hits-within-a-single-run.
3. The `FileCache` class (or however it's structured) now takes a `FitFileCacheRepo` (or a `DataStore`) as a constructor dependency. Update construction sites.
4. **`framework/parse-cache.ts` is out of scope for this phase.** Verified during plan refinement: it is a re-export shim that forwards to `packages/core/src/languages/parse-cache.ts`. The actual parse cache is a core/language-adapter concern, not a fitness concern. No table, no repo, no changes in this phase.

**Wiring:** Called by check execution paths (search for consumers of `file-cache.ts`'s exports). Construction-site change propagates.

**Verification:**

```bash
pnpm --filter=@opensip-tools/fitness build && pnpm --filter=@opensip-tools/fitness typecheck
pnpm fit                                     # cold run; populates fit_file_cache
pnpm fit                                     # warm run; should be measurably faster (cache hits)
sqlite3 opensip-tools/.runtime/datastore.sqlite 'SELECT COUNT(*) FROM fit_file_cache;'
```

**Commit:** `refactor(fitness): file-cache persists via FitFileCacheRepo`

---

## Phase 4 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
rm -rf opensip-tools/.runtime
pnpm fit                                     # cold rebuild; populates fit_file_cache, no baseline yet
pnpm fit --gate-save                         # writes to fit_baseline
pnpm fit                                     # warm hit
pnpm fit --gate-compare                      # consumes fit_baseline
sqlite3 opensip-tools/.runtime/datastore.sqlite '.tables'   # observe fit_file_cache, fit_baseline alongside graph_* and sessions
```

Expected state: fitness baseline and file-cache live in SQLite. `framework/file-cache.ts` retains its in-process semantics; persistence delegates to `FitFileCacheRepo`. `gate.ts` is JSON-free.
