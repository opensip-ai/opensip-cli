# Phase 0: Datastore foundation

**Goal:** Stand up the `@opensip-tools/datastore` package with `DataStore` interface, SQLite + in-memory backends, Drizzle wiring, and layer-policy enforcement. No tool consumes it yet — it's dead code in production until Phase 1.
**Depends on:** —

Tasks 0.1 → 0.6 are ordered by dependency: scaffolding first, then interface, then backends, then drizzle config, then layering rules.

---

## Task 0.1: Create the datastore package scaffolding

**Files:** [size: S]
- Create: `packages/datastore/package.json`
- Create: `packages/datastore/tsconfig.json`
- Create: `packages/datastore/vitest.config.ts`
- Create: `packages/datastore/src/index.ts` (barrel placeholder; populated in Task 0.2)
- Create: `packages/datastore/.gitignore` only if other packages have per-package `.gitignore` files (check `packages/core/.gitignore`; if absent there, datastore doesn't need one either — the root `.gitignore` covers `dist/`)

**Context:** The workspace recognizes any directory under `packages/*` as a package (see `pnpm-workspace.yaml`). Existing packages such as `packages/core`, `packages/contracts`, and `packages/graph/engine` define the convention to follow. The `opensipTools` field in package.json is reserved for tool packages (`kind: 'tool'`); datastore is *not* a tool, so no `opensipTools` block.

**Steps:**

1. Read `packages/core/package.json` and `packages/contracts/package.json` to confirm shared conventions (Node engines, type field, build/test/typecheck scripts, license, repository URL pattern, exports shape).
2. Create `packages/datastore/package.json` with:
   - `name: "@opensip-tools/datastore"`
   - `version: "0.0.0"` (will be bumped to 2.0.0 in Phase 5)
   - `type: "module"`, `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`, `exports: { ".": "./dist/index.js" }`
   - **`files: ["dist", "migrations"]`** — critical. By default npm publishes everything under the package root, but the project convention (visible in `packages/core/package.json` etc.) uses an explicit `files` allowlist. If datastore follows that convention without including `migrations/`, the published tarball ships without migration SQL and users hit "no migrations folder" on first run. This is the single subtlest gotcha in the entire plan.
   - Standard scripts: `build` (tsc), `test` (vitest run), `typecheck` (tsc --noEmit), `clean` (rm -rf dist)
   - License, repository, homepage, bugs fields matching the other packages
3. Create `packages/datastore/tsconfig.json` extending the root `tsconfig.json` (mirror what `packages/core/tsconfig.json` does); set `outDir: "./dist"` and include `src/**/*.ts`.
4. Create `packages/datastore/vitest.config.ts` mirroring `packages/core/vitest.config.ts`.
5. Create `packages/datastore/src/index.ts` as an empty barrel (`export {};` is fine for now).
6. Add `packages/datastore` to the root `tsconfig.json` `references` array if other packages do so (read root `tsconfig.json` first).

**Wiring:** No consumers yet. The package builds and tests in isolation. `pnpm install` from repo root picks it up because `pnpm-workspace.yaml` already covers `packages/*`.

**Verification:**

```bash
pnpm install
pnpm --filter=@opensip-tools/datastore build
pnpm --filter=@opensip-tools/datastore typecheck
pnpm --filter=@opensip-tools/datastore test
```

**Commit:** `feat(datastore): scaffold @opensip-tools/datastore package`

---

## Task 0.2: Define the `DataStore` interface

**Files:** [size: S]
- Create: `packages/datastore/src/data-store.ts`
- Modify: `packages/datastore/src/index.ts` (export from data-store.ts)

**Context:** This is the contract that all tools depend on. The interface deliberately exposes a Drizzle database handle directly rather than wrapping it in a domain-agnostic key-value API — see [`decisions.md`](./decisions.md) § 3 for why paradigm-bridging adapters are rejected. Tools get full Drizzle expressiveness through this handle while sharing one connection lifecycle.

**Steps:**

1. Add `drizzle-orm` as a `dependency` in `packages/datastore/package.json`. Run `pnpm install` to lock the version.
2. In `data-store.ts`, declare the `DataStore` interface — **synchronous** throughout. better-sqlite3 is sync; there is no underlying async I/O to surface. An async-shaped wrapper would be theater and would force the CLI bootstrap to restructure around top-level await for no benefit.
   - `readonly db: BetterSQLite3Database<Record<string, unknown>>` — the Drizzle handle (parametrize by a schema generic; consumers narrow it).
   - `close(): void` — releases the underlying connection.
   - `transaction<T>(fn: (tx: BetterSQLite3Database<...>) => T): T` — Drizzle's `db.transaction(...)` returns synchronously over better-sqlite3; surface that directly.
3. Define `interface DataStoreOpenOptions` with at minimum `{ path: string }` for the SQLite backend; backends may extend this internally.
4. Define `class DataStoreMigrationError extends Error` — thrown by the factory (Task 0.5) when `migrate()` fails. Carries the failed migration's filename and the underlying error message. Public API surface so consumers can `catch (e) if (e instanceof DataStoreMigrationError)` and present a recovery-oriented error message.
4. Re-export from `src/index.ts`.

**Wiring:** Used in Phase 1 by `cli/src/index.ts` to construct the store, and by `ToolCliContext` consumers via the `datastore` field added in Phase 1.

**Verification:**

```bash
pnpm --filter=@opensip-tools/datastore build && pnpm --filter=@opensip-tools/datastore typecheck
```

**Commit:** `feat(datastore): define DataStore interface`

---

## Task 0.3: Implement the SQLite backend

**Files:** [size: M]
- Create: `packages/datastore/src/backends/sqlite.ts`
- Modify: `packages/datastore/package.json` (add `better-sqlite3` + `@types/better-sqlite3` deps)
- Modify: `packages/datastore/src/index.ts` (export factory entrypoint via Task 0.5)

**Context:** `better-sqlite3` is synchronous; Drizzle wraps it in an async-shaped API for code uniformity without paying I/O scheduling cost. WAL mode is enabled at open time to support the `--packages` runner pattern (parent writes, children read concurrently — see `packages/graph/engine/src/cli/packages-runner.ts:1-19`).

**Steps:**

1. Add `better-sqlite3` and `@types/better-sqlite3` to `packages/datastore/package.json` deps. Pin versions explicitly. Run `pnpm install`.
2. In `sqlite.ts`, export `openSqliteBackend(opts: { path: string }): DataStore`:
   - `new Database(opts.path)` (better-sqlite3 constructor)
   - `db.pragma('journal_mode = WAL')` — enable WAL mode unconditionally
   - `db.pragma('foreign_keys = ON')` — enforce FK constraints
   - Wrap with `drizzle(db)` from `drizzle-orm/better-sqlite3`
   - Return a `DataStore` implementation that closes the underlying `Database` on `close()` and delegates `transaction(fn)` to `db.transaction(...)` directly — both are synchronous per the locked design call in Task 0.2
3. Ensure parent directory exists (`mkdirSync(dirname(opts.path), { recursive: true })`).
4. Do not run migrations here — migrations are applied by the factory (Task 0.5).

**Wiring:** Called by `DataStoreFactory.open(...)` (Task 0.5). Not consumed directly by tools.

**Verification:**

```bash
pnpm --filter=@opensip-tools/datastore build && pnpm --filter=@opensip-tools/datastore typecheck
```

A minimal smoke test that opens a SQLite DB in a tmp dir and closes it is fine to land here; comprehensive tests come in Phase 6.

**Commit:** `feat(datastore): implement SQLite backend with WAL mode`

---

## Task 0.4: Implement the in-memory backend

**Files:** [size: S]
- Create: `packages/datastore/src/backends/memory.ts`
- Modify: `packages/datastore/src/index.ts` (export factory entrypoint via Task 0.5)

**Context:** The in-memory backend is SQLite-in-`:memory:`. It exists for tests (fast, isolated, no I/O) and matches production semantics exactly except for persistence.

**Steps:**

1. In `memory.ts`, export `openMemoryBackend(): DataStore`:
   - Reuse the SQLite backend's construction logic with `path: ':memory:'` — extract the shared logic from Task 0.3 into a small helper if it makes the code cleaner; otherwise duplicate the four-line setup.
   - Same WAL + FK pragmas as production for parity.

**Wiring:** Called by `DataStoreFactory.open({ backend: 'memory' })` (Task 0.5). Tests across all packages instantiate it directly in test setup.

**Verification:**

```bash
pnpm --filter=@opensip-tools/datastore build && pnpm --filter=@opensip-tools/datastore typecheck
```

**Commit:** `feat(datastore): implement in-memory backend`

---

## Task 0.5: Factory, Drizzle migrations config, and migrations directory

**Files:** [size: M]
- Create: `packages/datastore/src/factory.ts`
- Create: `packages/datastore/drizzle.config.ts`
- Create: `packages/datastore/migrations/.gitkeep` (placeholder; populated by drizzle-kit as schemas land in later phases)
- Modify: `packages/datastore/package.json` (add `drizzle-kit` as devDependency; add `db:generate`, `db:migrate` scripts)
- Modify: `packages/datastore/src/index.ts` (export `DataStoreFactory`)

**Context:** The factory is the single entrypoint consumers use. It selects a backend, applies pending migrations, and hands back a ready-to-use `DataStore`. `drizzle.config.ts` tells `drizzle-kit generate` where to read schemas and where to write SQL migrations.

**Steps:**

1. Add `drizzle-kit` to devDependencies. Run `pnpm install`.
2. In `factory.ts`, export `DataStoreFactory` with a single static method — **synchronous**:
   ```ts
   static open(opts: { backend: 'sqlite' | 'memory'; path?: string }): DataStore
   ```
   - Dispatches to `openSqliteBackend` or `openMemoryBackend`.
   - After opening, applies pending Drizzle migrations from `./migrations/` via `migrate(db, { migrationsFolder: './migrations' })` from `drizzle-orm/better-sqlite3/migrator` — sync.
   - Returns the `DataStore`.
   - **On `migrate()` failure: re-throw with a wrapped error class** (`DataStoreMigrationError`) that includes a recovery hint: "Schema migration failed; the local cache may be corrupted or from a future version. Delete `<path>` to start fresh (cache will rebuild on next run; session history will be lost)." The CLI bootstrap surfaces this error message to the user — never silently swallow.
3. **Schema evolution workflow** (developer-facing, documented in this task because the factory is where it lands). When a future change modifies any schema file:
   - Edit the schema (e.g., add a column to `catalog_functions`).
   - Run `pnpm --filter=@opensip-tools/datastore db:generate`. Drizzle-kit diffs against the last applied migration and produces a new `NNNN_<name>.sql` file under `packages/datastore/migrations/`.
   - **Read and review the generated SQL** before committing. Drizzle-kit's automatic diffing handles most cases correctly but column renames are detected as drop+add (data loss); use the interactive prompts or hand-edit the migration if needed.
   - Commit the SQL alongside the schema edit. The factory's `migrate()` call applies it on the user's next run.
   - **Never** edit a previously-committed migration file. Drizzle tracks applied migrations by content hash; editing one in-place leaves users in undefined state. Add a new migration instead.
   - **Downgrades are unsupported.** Drizzle has no down-migration concept. If a user downgrades and the schema is incompatible, the error class above fires; recovery is to delete `datastore.sqlite`.
3. In `drizzle.config.ts`, configure for `dialect: 'sqlite'`. **At Phase 0 the schema array is empty** — `schema: []` — because no owning package has declared schemas yet. drizzle-kit's behavior on missing files is unreliable across versions; an empty array is unambiguous. Each subsequent phase (1, 2, 3, 4) appends its schema path to this array as part of that phase's first task.
   ```ts
   // Initial Phase 0 state:
   import type { Config } from 'drizzle-kit';
   export default {
     dialect: 'sqlite',
     schema: [],            // populated by Phases 1–4 as schemas land
     out: './migrations',
   } satisfies Config;
   ```
4. Add scripts to package.json:
   - `db:generate`: `drizzle-kit generate`
   - `db:check`: `drizzle-kit check` (verifies migrations are in sync with schemas)
5. Create `packages/datastore/migrations/.gitkeep` so the dir is committed even when empty.

**Wiring:** `DataStoreFactory.open` is called from `cli/src/index.ts` at bootstrap (Phase 1). Migrations apply automatically on open.

**Verification:**

```bash
pnpm --filter=@opensip-tools/datastore build
pnpm --filter=@opensip-tools/datastore typecheck
pnpm --filter=@opensip-tools/datastore db:check  # should pass with no schemas defined yet
```

**Commit:** `feat(datastore): add factory and drizzle-kit migrations config`

---

## Task 0.6: Layer policy and release ordering

**Files:** [size: M]
- Modify: `.dependency-cruiser.cjs`
- Modify: `tsconfig.json` (root — add datastore to project references if convention uses them)
- Modify: `turbo.json` (verify; likely no change needed since `packages/*` glob covers it)
- Modify: `RELEASING.md`

**Context:** `CLAUDE.md` documents the layering enforced by dependency-cruiser:

```
core → contracts → lang-*/fitness/simulation/graph → checks-* → cli
```

Datastore must slot between `core` and `contracts`. It depends on `core` (logger, errors) but nothing else. Contracts (Phase 1) and the tool packages (Phases 2–4) gain `@opensip-tools/datastore` as a dependency.

**Steps:**

1. Read `.dependency-cruiser.cjs` to understand the existing rule shape.
2. Add a rule allowing:
   - `@opensip-tools/datastore` → `@opensip-tools/core` only (no other workspace imports)
   - `@opensip-tools/contracts` and tool packages (`fitness`, `graph`, `simulation`, `cli`) → `@opensip-tools/datastore` permitted
   - `@opensip-tools/datastore` must not be imported by `core`
3. If root `tsconfig.json` uses `references`, add `{ "path": "./packages/datastore" }`. If it doesn't, skip.
4. Read `turbo.json`; the `packages/*` glob should pick up datastore automatically. Verify by running `pnpm turbo build` and confirming datastore appears in the graph.
5. Update `RELEASING.md` to place `@opensip-tools/datastore` between `@opensip-tools/core` and `@opensip-tools/contracts` in the publish order. The release becomes 18 packages.

**Wiring:** Enforcement is via `pnpm lint`, which runs dependency-cruiser as part of CI. A layer violation introduced in any later phase fails this check.

**Verification:**

```bash
pnpm lint                           # 0 errors expected
pnpm turbo build                    # datastore appears in graph
pnpm --filter=@opensip-tools/datastore build  # still builds clean
```

**Commit:** `chore(datastore): add to layer policy and release order`

---

## Phase 0 End-to-End Verification

After all six tasks land:

```bash
pnpm install
pnpm build                          # entire workspace; datastore included
pnpm typecheck
pnpm test                           # existing tests pass; new datastore tests trivial (Phase 6 expands)
pnpm lint                           # 0 errors; layer policy enforced
pnpm --filter=@opensip-tools/datastore db:check
```

Expected state: `@opensip-tools/datastore` exists, builds, has `DataStore` interface + SQLite + in-memory backends + a factory. No production code depends on it yet. Native module install succeeds on the developer's platform.
