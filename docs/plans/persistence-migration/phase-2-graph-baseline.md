# Phase 2: Graph baseline on datastore

**Goal:** Migrate the graph baseline (used by `graph --gate-save` / `--gate-compare`) from `baseline.json` to a SQLite `BaselineRepo`. Establishes the `packages/graph/engine/src/persistence/` directory that Phase 3 will populate with the catalog schema.
**Depends on:** Phase 0

Smaller and structurally simpler than the catalog migration. Same pattern as Phase 1's session repo work, scoped to one tool.

---

## Task 2.1: Create the graph persistence module and baseline schema

**Files:** [size: S]
- Create: `packages/graph/engine/src/persistence/index.ts`
- Create: `packages/graph/engine/src/persistence/schema.ts`
- Modify: `packages/graph/engine/package.json` (add `@opensip-tools/datastore` and `drizzle-orm` deps)

**Context:** Baseline state today is a single JSON file containing a `BaselineFile` record (interface defined at `packages/graph/engine/src/gate.ts:17`) with the signal list and minimal metadata. The two functions are `saveBaseline(signals: readonly Signal[], baselinePath: string)` at line 34 and `compareToBaseline(...)` at line 59. The file is small (~2.7KB in this repo) and atomic; the migration to SQLite is mostly mechanical. Phase 3 will extend this same `schema.ts` with the catalog tables.

`Signal` is imported from `@opensip-tools/core` (defined at `packages/core/src/types/signal.ts:9`). It has shape `{ severity: SignalSeverity, category: SignalCategory, ... }` plus payload fields — read the type before designing the column mapping.

**Steps:**

1. Add deps to `packages/graph/engine/package.json`.
2. Read the `Signal` interface at `packages/core/src/types/signal.ts:9` and the `BaselineFile` interface at `packages/graph/engine/src/gate.ts:17` to confirm the full shape that needs to round-trip.
3. In `schema.ts`, declare a `sqliteTable` for the baseline:
   - `graph_baseline_signals(id PK autoincrement integer, payload text json-mode, severity text, category text, captured_at integer (unix ms))`
   - One row per signal. The `payload` column stores the full `Signal` as JSON (mode: `'json'`) so the round-trip is lossless without needing per-field columns; `severity` and `category` are duplicated as separate columns purely to enable indexed filtering (the dashboard may want to filter by severity in the future).
4. Replace-on-save is the natural operation; no `baseline_set` parent table.
5. Append `'../graph/engine/src/persistence/schema.ts'` to the `schema` array in `packages/datastore/drizzle.config.ts`.
6. Re-export the schema from `persistence/index.ts`.

**Wiring:** Imported by `baseline-repo.ts` (Task 2.2) and listed in `drizzle.config.ts` schema glob from Phase 0 Task 0.5. Run `pnpm --filter=@opensip-tools/datastore db:generate` after this task to produce the migration SQL.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build
pnpm --filter=@opensip-tools/datastore db:generate
pnpm --filter=@opensip-tools/datastore db:check
```

**Commit:** `feat(graph): add baseline Drizzle schema`

---

## Task 2.2: Implement `BaselineRepo`

**Files:** [size: S]
- Create: `packages/graph/engine/src/persistence/baseline-repo.ts`

**Context:** Two operations: save the current signal set as the baseline (replaces previous), and load the baseline for comparison. The "replace previous" semantic maps cleanly to a single transaction that deletes existing rows then inserts the new ones.

**Steps:**

1. Define `class GraphBaselineRepo` constructed with `(datastore: DataStore)`.
2. Implement methods — **all synchronous** (matches the DataStore surface):
   - `save(signals: readonly Signal[]): void` — wrap in `datastore.transaction(tx => { tx.delete(graphBaselineSignals).run(); tx.insert(graphBaselineSignals).values(signals.map(toRow)).run(); })`.
   - `load(): readonly Signal[]` — `db.select().from(graphBaselineSignals).all()`; map rows back to `Signal` shape via `JSON.parse(row.payload)`.
   - `exists(): boolean` — for the `if no baseline, suggest --gate-save first` error path. Implement as a `SELECT 1 FROM graph_baseline_signals LIMIT 1`. Today's check at `gate.ts:63-67` is `existsSync(baselinePath)`; the row-presence check is the SQLite equivalent.
3. Co-locate the row ↔ Signal mapping helpers inside this file (don't leak Drizzle column names outside the repo).
4. **Emit logger events** per the plan's logger-event-parity convention: `graph.baseline.save.complete` (include signal count), `graph.baseline.load.complete` (include signal count), `graph.baseline.load.miss` for the empty-baseline case, `graph.baseline.*.error` on thrown errors.

**Wiring:** Consumed by `gate.ts` (Task 2.3). Eventually consumed by any `--report-to` upload flow that snapshots the baseline.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/graph typecheck
```

**Commit:** `feat(graph): implement BaselineRepo`

---

## Task 2.3: Rewrite `gate.ts` to use `BaselineRepo`

**Files:** [size: M]
- Modify: `packages/graph/engine/src/gate.ts`

**Context:** Today `gate.ts` does atomic JSON writes (tmp-file + rename) and JSON reads with `JSON.parse`. After this task, all I/O routes through `BaselineRepo`; the file's orchestration logic (signature, severity comparison, gate verdict) is unchanged.

**Steps:**

1. Read `gate.ts` end-to-end. Verified entry points:
   - `saveBaseline(signals, baselinePath)` at line 34
   - `compareToBaseline(...)` at line 59
2. Remove `node:fs` imports (`existsSync`, `mkdirSync`, `readFileSync`, `renameSync`, `writeFileSync`).
3. Change signatures to take a `GraphBaselineRepo` instead of `baselinePath: string`:
   - `saveBaseline(signals: readonly Signal[], repo: GraphBaselineRepo): void`
   - `compareToBaseline(currentSignals: readonly Signal[], repo: GraphBaselineRepo): GateCompareResult` — return type is `GateCompareResult`, defined at `packages/graph/engine/src/gate.ts:24`; keep using it
4. Replace JSON read with `repo.load()`. Replace JSON write with `repo.save(signals)`. The "baseline not found" check at `gate.ts:63-67` becomes `repo.exists()`.
5. Update all call sites. Verify with `grep -rn "saveBaseline\|compareToBaseline" packages/graph/engine/src --include="*.ts" | grep -v __tests__` and adjust each. Callers thread the repo down from `ToolCliContext.datastore` — typically via the tool's `register(cli, ctx)` in `packages/graph/engine/src/tool.ts`.
6. The `BaselineFile` interface (lines 17–22 of current `gate.ts`) becomes unused — delete it.

**Wiring:** `gate.ts` is invoked from the graph tool's CLI commands. Threading the repo (or DataStore) from `ToolCliContext` to the gate functions follows the dataflow set up in Phase 1.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/graph typecheck
pnpm graph --gate-save                       # smoke
pnpm graph --gate-compare                    # smoke; should produce same verdict as JSON-era runs
sqlite3 opensip-tools/.runtime/datastore.sqlite 'SELECT COUNT(*) FROM graph_baseline_signals;'
```

**Commit:** `refactor(graph): gate uses BaselineRepo instead of baseline.json`

---

## Phase 2 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm graph --gate-save && pnpm graph --gate-compare
sqlite3 opensip-tools/.runtime/datastore.sqlite '.tables'    # observe graph_baseline_signals
# Verify no baseline.json is being written:
ls opensip-tools/.runtime/cache/graph/    # baseline.json should NOT appear
```

Expected state: `--gate-save` writes to the `graph_baseline_signals` table; `--gate-compare` reads from it; no `baseline.json` file is created. The `BaselineFile` interface and JSON read/write are gone from `gate.ts`. `packages/graph/engine/src/persistence/` exists and is ready to receive catalog schemas in Phase 3.
