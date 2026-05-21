# Phase 1: Sessions on datastore

**Goal:** Migrate sessions persistence from one-JSON-file-per-run to a SQLite-backed `SessionRepo`. Extend `ToolCliContext` to carry the DataStore so tools acquire it via DI rather than module-level singletons.
**Depends on:** Phase 0

This phase establishes the patterns that Phases 2–4 reuse: schema location, repo facade, DataStore acquisition via `ToolCliContext`, and the elimination of `configurePersistencePaths` module-state.

---

## Task 1.1: Define the sessions schema

**Files:** [size: S]
- Create: `packages/contracts/src/persistence/schema/sessions.ts`
- Create: `packages/contracts/src/persistence/schema/index.ts`
- Modify: `packages/contracts/package.json` (add `@opensip-tools/datastore` and `drizzle-orm` deps)

**Context:** `StoredSession` is currently defined in `packages/contracts/src/persistence/store.ts` as a TypeScript interface. The shape includes a `summary` aggregate object and a `checks` array with findings — denormalize accordingly: a `sessions` table for the top-level record and a `session_findings` table for the findings.

**Steps:**

1. Read the existing `StoredSession` interface in `store.ts` for the canonical shape.
2. Add `@opensip-tools/datastore` (workspace:*) and `drizzle-orm` to `packages/contracts/package.json` deps.
3. In `schema/sessions.ts`, declare two `sqliteTable`s using `drizzle-orm/sqlite-core`:
   - `sessions(id PK text, tool text, timestamp integer (unix ms), cwd text, recipe text nullable, score integer, passed integer boolean-mode, summary text json-mode)`
   - `session_findings(id PK autoincrement integer, session_id text FK→sessions.id on delete cascade, check_slug text, rule_id text, severity text, message text, file_path text nullable, line integer nullable, column integer nullable)`
4. Add indexes:
   - `sessions(tool, timestamp DESC)` — supports `sessions list` ordering
   - `session_findings(session_id)` — supports findings hydration on session read
5. Export both tables and any index declarations from `schema/index.ts`.

**Wiring:** Imported by `session-repo.ts` (Task 1.2) and listed in `drizzle.config.ts` (added in Phase 0 Task 0.5). After this task, run `pnpm --filter=@opensip-tools/datastore db:generate` to produce the migration SQL.

**Verification:**

```bash
pnpm --filter=@opensip-tools/contracts build
pnpm --filter=@opensip-tools/datastore db:generate   # produces 0001_*.sql
pnpm --filter=@opensip-tools/datastore db:check
```

**Commit:** `feat(contracts): add sessions Drizzle schema`

---

## Task 1.2: Implement `SessionRepo`

**Files:** [size: M]
- Create: `packages/contracts/src/persistence/session-repo.ts`

**Context:** The repo is a thin facade over Drizzle queries — not a heavy ORM repository. It exists to keep query shapes named and centralized. Methods mirror the operations the CLI and dashboard need.

**Steps:**

1. Define `class SessionRepo` constructed with `(datastore: DataStore)`.
2. Implement methods — **all synchronous** (better-sqlite3 is sync; matches the rest of the DataStore surface):
   - `save(session: StoredSession): void` — inserts into `sessions`, batch-inserts findings into `session_findings`. Wrap in `datastore.transaction(...)`.
   - `list(opts?: { tool?: 'fit'|'sim'|'graph'; limit?: number }): readonly StoredSession[]` — selects sessions ordered by timestamp DESC, joins findings; assemble `StoredSession` shape in the result mapping.
   - `get(id: string): StoredSession | null` — by primary key.
   - `purge(before: Date): number` — deletes sessions with timestamp earlier than the given date; FK cascade removes findings. Returns affected rowcount.
3. `StoredSession` type stays in `store.ts` for now (Task 1.3 collapses store.ts to a facade); SessionRepo imports it.

**Wiring:** Constructed by `cli/src/index.ts` when building `ToolCliContext` (Task 1.4) and exposed via the context's `datastore`-derived API. The dashboard generator (Task 1.6) takes a `SessionRepo` instance.

**Verification:**

```bash
pnpm --filter=@opensip-tools/contracts build && pnpm --filter=@opensip-tools/contracts typecheck
```

**Commit:** `feat(contracts): implement SessionRepo over DataStore`

---

## Task 1.3: Rewrite `persistence/store.ts` as a thin facade

**Files:** [size: M]
- Modify: `packages/contracts/src/persistence/store.ts`
- Modify: `packages/contracts/src/index.ts` (drop `configurePersistencePaths` from exports)

**Context:** Today `store.ts` holds mutable module state set by `configurePersistencePaths` at `packages/contracts/src/persistence/store.ts:92`. That global state is incompatible with multiple DataStore instances (e.g. tests). It must go.

**Steps:**

1. Delete the module-level mutable `paths` state and the `configurePersistencePaths` function.
2. Delete the JSON-file read/write helpers in `store.ts`.
3. Retain `StoredSession` interface and its sub-types (`StoredCheck`, `StoredFinding` if present).
4. Optionally export a small `createSessionRepo(datastore)` factory if the call sites prefer that ergonomic — otherwise consumers `new SessionRepo(datastore)`.
5. Update `packages/contracts/src/index.ts` to remove `configurePersistencePaths` and any helpers that depended on the path state. Add `SessionRepo` to exports.

**Wiring:** Existing call sites of `configurePersistencePaths` (the CLI bootstrap and tests) will fail to compile after this task. Task 1.4 + 1.5 + the dashboard task wire those up to the new SessionRepo path. Tests under `packages/contracts/src/__tests__/` that touched `configurePersistencePaths` need updating — covered in Phase 6.

**Verification:**

```bash
pnpm --filter=@opensip-tools/contracts build
# Other packages will fail until Task 1.4 lands; that's expected within this phase.
```

**Commit:** `refactor(contracts): drop configurePersistencePaths; store.ts becomes thin facade`

---

## Task 1.4: Extend `ToolCliContext` with `datastore`

**Files:** [size: S]
- Modify: `packages/core/src/tools/types.ts`

**Context:** `ToolCliContext` is the existing DI surface for tools (defined at `packages/core/src/tools/types.ts:60`). It's how the CLI hands shared infrastructure into each Tool's `register(cli)` call. Adding a `datastore` field is the structural way to provide DB access without resurrecting global state.

**Steps:**

1. Read the existing `interface ToolCliContext` at `packages/core/src/tools/types.ts:60` to confirm field naming conventions.
2. Add `readonly datastore: DataStore;` field.
3. Import `DataStore` from `@opensip-tools/datastore`. Add `@opensip-tools/datastore` to `packages/core/package.json` deps.
4. Re-export `DataStore` from `packages/core/src/index.ts` if other packages would otherwise need to import it from datastore directly (audit the layer rules — if datastore is a direct dep of consumers, no re-export needed).

**Wiring:** Tools' `register(cli, ctx)` calls now see `ctx.datastore`. Phase 1's downstream tasks (1.5, 1.6) and Phases 2–4 use it.

**Verification:**

```bash
pnpm --filter=@opensip-tools/core build
pnpm typecheck
```

**Commit:** `feat(core): add datastore field to ToolCliContext`

---

## Task 1.5: Bootstrap the DataStore in the CLI

**Files:** [size: M]
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json` (add `@opensip-tools/datastore` dep)

**Context:** Today, `packages/cli/src/index.ts:236-238` calls `resolveProjectPaths(cwd)` then `configurePersistencePaths(projectPaths)`. After this task, `configurePersistencePaths` is gone; the CLI opens a DataStore and passes it through `ToolCliContext`. **DataStore.open is synchronous** (per Phase 0), so this slots into the existing synchronous bootstrap without restructuring `cli/src/index.ts` around `async main()`.

**Steps:**

1. Add `@opensip-tools/datastore` to `packages/cli/package.json` deps. Run `pnpm install`.
2. In `cli/src/index.ts`, remove the `configurePersistencePaths(projectPaths)` call at line 238.
3. After `resolveProjectPaths(cwd)`, compute the SQLite path: `join(projectPaths.runtimeDir, 'datastore.sqlite')`. **`runtimeDir` is already exposed on `ProjectPaths`** (`packages/core/src/lib/paths.ts` — line ~60 of the interface). No core change needed.
4. Ensure the parent directory exists: `mkdirSync(projectPaths.runtimeDir, { recursive: true })` (the directory may not yet exist on a fresh project). The SQLite backend's own `mkdirSync` in Phase 0 Task 0.3 also handles this; double-mkdir is idempotent.
5. Open the DataStore synchronously: `const datastore = DataStoreFactory.open({ backend: 'sqlite', path: dbPath })`. No `await`.
6. Pass `datastore` into `buildToolCliContext()` at line 247; include it in the returned context object at line 253.
7. Register a process-exit hook so the DB closes cleanly: `process.on('exit', () => datastore.close())`. `close()` is synchronous; `process.on('exit')` only accepts synchronous handlers, so the sync API is the only correct option here. Best-effort — if the process crashes hard, WAL replay on next open handles consistency.

**Wiring:** All `register(cli, ctx)` calls in the tool registry now see a real `ctx.datastore`. CLI-only commands (`init`, `sessions`, `configure`, `plugin`, `completion`, `uninstall`) that need DB access pull `ctx.datastore` from the local closure.

**Verification:**

```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
pnpm fit                                     # smoke: runs against the real CLI
```

**Commit:** `feat(cli): open DataStore at bootstrap and thread through ToolCliContext`

---

## Task 1.6: Wire `sessions list` / `sessions purge` to `SessionRepo`

**Files:** [size: M]
- Modify: `packages/cli/src/index.ts` (the `sessions list` command is registered at line 386; `sessions purge` at line 395 — both inline, no separate commands file exists)
- Modify: `packages/contracts/src/persistence/dashboard/sessions.ts`
- Modify: `packages/contracts/src/persistence/dashboard/generator.ts`

**Context:** Three call sites consume session data today: `sessions list` and `sessions purge` (both inline in `cli/src/index.ts`), and the dashboard generator's session-list section. All of them must switch to `SessionRepo`. The dashboard generator additionally needs to accept the repo (or the DataStore) as input rather than reaching for module state.

**Steps:**

1. In `cli/src/index.ts`, locate the `sessions list` `.command('list')` block at line 386 and `sessions purge` `.command('purge')` at line 395. Both currently consume the old store helpers.
2. Reshape both handlers to construct a `SessionRepo` from the local `cliContext.datastore` and call `.list(...)` / `.purge(...)` synchronously. Remove the old store-helper imports.
3. Update `dashboard/sessions.ts` to take a `SessionRepo` instance (or the `DataStore`) as input rather than reading from old module state.
4. Update `dashboard/generator.ts`'s signature to accept `{ datastore: DataStore }` (or a constructed repo) so it can hydrate session data. Confirm the dashboard's overall entrypoint (likely `generator.ts`'s exported function) propagates this.
5. Audit other files under `packages/contracts/src/persistence/dashboard/` for any other consumer of the old store helpers (search for `readSession`, `listSessions`, or whatever exported names existed). Update each.

**Wiring:** Dashboard tests (`packages/contracts/src/__tests__/dashboard-*.test.ts`) are the regression net. They must continue to pass once they're updated to construct an in-memory DataStore in setup. Test updates land in Phase 6; signature changes here may temporarily break those tests — acceptable within the phase.

**Verification:**

```bash
pnpm build
pnpm typecheck
pnpm test                                    # some dashboard tests may fail; tracked into Phase 6
pnpm fit && pnpm exec opensip-tools sessions list
```

**Commit:** `refactor(sessions): consume SessionRepo from DataStore`

---

## Task 1.7: Verify uninstall covers `datastore.sqlite` (no code change expected)

**Files:** [size: XS]
- (Inspect-only) `packages/cli/src/commands/uninstall.ts`

**Context:** `CLAUDE.md` documents the "uninstall is precise" property: `~/.opensip-tools/config.yml` and `opensip-tools/.runtime/` are the only state. After this migration, `datastore.sqlite` (plus its WAL/SHM sidecars) lives inside `.runtime/`. Verified during plan refinement: the existing uninstall (`packages/cli/src/commands/uninstall.ts`) already does `rm -rf <project>/opensip-tools/` in `--project` mode, which catches all SQLite files transitively. **No code change is needed** — only test that the round-trip works (Phase 7 Task 7.4) and confirm by inspection.

**Steps:**

1. Open `packages/cli/src/commands/uninstall.ts` and confirm the `--project` mode removes `<path>/opensip-tools/` recursively (the file's top-comment at lines 12–22 documents exactly this behavior). The SQLite database, its `-wal` and `-shm` sidecar files, and any logs/reports are all under that path.
2. No code change. Add a single inline comment near the removal call noting that `.runtime/datastore.sqlite` and its sidecars are covered transitively — future contributors should not need to re-derive this.

**Wiring:** Used directly by the `opensip-tools uninstall` command.

**Verification:**

```bash
pnpm --filter=@opensip-tools/cli build
# Manual: run uninstall against a project and verify .runtime/ is empty.
```

**Commit:** `chore(cli): uninstall cleans up datastore.sqlite WAL files`

---

## Phase 1 End-to-End Verification

After all seven tasks land:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test                                    # dashboard tests may need Phase 6 updates
pnpm fit                                     # smoke: runs warm; sessions are written to SQLite
pnpm exec opensip-tools sessions list        # reads from SQLite
pnpm exec opensip-tools sessions purge --before <date>
sqlite3 opensip-tools/.runtime/datastore.sqlite '.tables'   # observe sessions, session_findings
```

Expected state: `configurePersistencePaths` no longer exists. Sessions land in `sessions` + `session_findings` tables. `ToolCliContext.datastore` is wired end-to-end. JSON session files under `.runtime/sessions/` are not consulted (test fixtures may still contain old JSONs — cleaned up in Phase 5).
