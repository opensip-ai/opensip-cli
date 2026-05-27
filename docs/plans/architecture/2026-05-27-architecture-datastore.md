# Architecture audit — datastore

**Date:** 2026-05-27
**Scope:** packages/datastore
**Auditor:** Claude

## Summary

`@opensip-tools/datastore` is a small, well-scoped persistence kernel: a
`DataStore` interface, two backends (`sqlite`, `memory`), a factory that
owns migration sequencing, and a typed migration error. Composition over
inheritance is consistently applied — backends are plain object literals
implementing the interface, not subclasses. Tests are good; the
ES2022 `Error.cause` handling is unusually careful for a project this
size.

The package has one significant abstraction leak that undermines its
stated polymorphism goal: the public `DrizzleHandle` type is hard-bound
to `BetterSQLite3Database`, and the factory function `migrate` is
imported from `drizzle-orm/better-sqlite3/migrator`. The `memory`
backend is not actually an alternative implementation — it is a SQLite
backend pointed at `:memory:`. There is no current consumer who would
notice (everyone is on SQLite), but the interface advertises a choice
that does not exist. Either lean in (drop the abstraction and admit
"this is the SQLite store") or pay it down (parameterise the dialect).

Other findings are smaller: a singleton-shaped factory that would be
clearer as a free function, a transaction type that prevents async
work, an error class that under-uses its own `migrationFile` field, and
schema paths in `drizzle.config.ts` that reach across package
boundaries the dependency-cruiser rules exist to prevent at runtime.

## Findings

### F1 — `memory` backend is a misleading abstraction; both backends are SQLite

- **Files:** `packages/datastore/src/backends/memory.ts:1-7`, `packages/datastore/src/backends/sqlite.ts:1-11`, `packages/datastore/src/backends/shared.ts:6-23`
- **Principle/Pattern:** Strategy / Liskov Substitution; honest interface naming
- **Status:** Problematic
- **Evidence:**
  - `backends/memory.ts:6` — `return buildSqliteDataStore(':memory:');`
  - `backends/sqlite.ts:10` — `return buildSqliteDataStore(opts.path);`
  - `backends/shared.ts:7` — `const sqlite = new Database(dbPath);` (always `better-sqlite3`)
- **Why it matters:** The `DataStore` interface and `DataStoreOpenOptions.backend: 'sqlite' | 'memory'` discriminator suggest two interchangeable storage strategies. They are not. `memory` is just SQLite with `:memory:` — same driver, same dialect, same SQL, same migration. The "polymorphism" only exists at the API surface; underneath it is one implementation. This becomes a hazard if a real second backend (Postgres, libsql, an actual JS object store) is ever introduced — callers will have already written code against `db: BetterSQLite3Database` (see F2), and the Strategy boundary will need to be rebuilt rather than extended.
- **Recommendation:** Pick a side. Option A (recommended for v2.0): rename `'memory'` to something honest like `'sqlite-memory'`, document the option as a SQLite ephemeral mode, and remove `backends/memory.ts` — the two-line file adds a directory level without abstraction. Option B (only if a real second backend is on the roadmap): keep the discriminator, but address F2 first so the abstraction is actually substitutable.

### F2 — `DrizzleHandle` leaks `BetterSQLite3Database` through the interface

- **Files:** `packages/datastore/src/data-store.ts:1-10`
- **Principle/Pattern:** Dependency Inversion / Leaky Abstraction
- **Status:** Problematic
- **Evidence:**
  - `data-store.ts:1` — `import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';`
  - `data-store.ts:3-4` — `export type DrizzleHandle<...> = BetterSQLite3Database<TSchema>;`
  - Consumers depend on this directly: `packages/contracts/src/persistence/session-repo.ts:116` — `this.datastore.db.select().from(sessions).where(...)` is typed against `BetterSQLite3Database`.
- **Why it matters:** The interface advertises backend choice but the type of `db` is a concrete SQLite-dialect class. Any consumer holding a `DataStore` already knows which driver they're on — there is no way to write driver-agnostic code against this interface. Worse, the type alias `DrizzleHandle` reads as "a generic Drizzle handle" but is a synonym for the SQLite handle, which is actively misleading. This is a textbook leaky abstraction.
- **Recommendation:** If the abstraction is real (F1 Option B), the public `db` field should be typed against `BaseSQLiteDatabase` or even the dialect-agnostic interface and migration should be dispatched per backend. If the abstraction is not real (F1 Option A), drop `DrizzleHandle` and just export `BetterSQLite3Database` under its real name — naming should match what the type is.

### F3 — Factory dispatches migrations using a SQLite-only `migrate` import

- **Files:** `packages/datastore/src/factory.ts:4`, `packages/datastore/src/factory.ts:31`
- **Principle/Pattern:** Open/Closed; Strategy
- **Status:** Problematic
- **Evidence:**
  - `factory.ts:4` — `import { migrate } from 'drizzle-orm/better-sqlite3/migrator';`
  - `factory.ts:31` — `migrate(datastore.db, { migrationsFolder });`
- **Why it matters:** Adding a non-SQLite backend would require editing the factory to branch on `opts.backend` before picking a migrator — exactly the conditional logic that the backend Strategy is supposed to eliminate. The migration responsibility belongs to the backend itself.
- **Recommendation:** Push `migrate(...)` into each backend's `open*Backend` function, or add an optional `migrate(folder: string): void` method to `DataStore`. The factory then becomes a switch on backend kind + a polymorphic call. This pairs with fixing F1/F2.

### F4 — `DataStoreFactory` is a single-method object literal masquerading as a class

- **Files:** `packages/datastore/src/factory.ts:16-38`, `packages/datastore/src/index.ts:3`
- **Principle/Pattern:** Factory Method / over-applied pattern
- **Status:** Problematic (mild)
- **Evidence:**
  - `factory.ts:16` — `export const DataStoreFactory = { open(opts) { ... } };`
  - Used as `DataStoreFactory.open(...)` everywhere; never extended, never re-implemented, no state, no second method.
- **Why it matters:** The `Factory` suffix and namespace-as-object pattern signals more variability than exists. The runtime cost is zero, but readers spend time wondering whether they should subclass it, register additional factories, or DI-inject it. The answer is "no" in every case. The shape also makes it harder to tree-shake than a plain function, and harder to add overloads.
- **Recommendation:** Replace with `export function openDataStore(opts): DataStore`. If you want a namespace for related operations later (e.g. `closeAll`, `pingMigrations`), reintroduce the object then.

### F5 — `DataStore.transaction` is synchronous-only; future async work will need a parallel API

- **Files:** `packages/datastore/src/data-store.ts:9`, `packages/datastore/src/backends/shared.ts:19-21`
- **Principle/Pattern:** Interface Segregation / forward compatibility
- **Status:** Missing opportunity
- **Evidence:**
  - `data-store.ts:9` — `transaction<T>(fn: (tx: DrizzleHandle<TSchema>) => T): T;`
  - `backends/shared.ts:19-21` — `return db.transaction(fn);` (better-sqlite3 is sync-only)
- **Why it matters:** `better-sqlite3` is synchronous by design; that constraint has been hoisted into the public interface. Any future backend (libsql, postgres-js, drizzle-d1) is async, and any new caller that needs to do an async step mid-transaction (e.g. read from disk while computing a row) cannot. Today this is fine. The day someone needs `await` inside a transaction, the interface will fork into `transaction` and `transactionAsync` rather than evolve cleanly.
- **Recommendation:** Either accept the constraint and rename to `transactionSync` to make it explicit (signals intent and reserves `transaction` for an async-capable future), or change the signature to `transaction<T>(fn: (tx) => T | Promise<T>): Promise<T>` now and `await` in the SQLite case (the body runs sync; the wrapper is async). I'd lean to the rename — it's honest and cheap.

### F6 — `DataStoreMigrationError.migrationFile` is declared but never populated

- **Files:** `packages/datastore/src/data-store.ts:17-28`, `packages/datastore/src/factory.ts:32-35`
- **Principle/Pattern:** YAGNI / dead-field
- **Status:** Problematic
- **Evidence:**
  - `data-store.ts:18` — `readonly migrationFile: string | undefined;`
  - The only thrower (`factory.ts:34`) constructs `new DataStoreMigrationError(..., { cause: error })` — `migrationFile` is never set.
  - Tests at `__tests__/factory.test.ts:133-136` only confirm the field can be set by hand, not that the production path ever sets it.
- **Why it matters:** A public field that's always `undefined` in real use sends a false signal to callers ("you can switch on which migration failed") and to maintainers ("someone is filling this in"). It's API surface that exists only as a stub.
- **Recommendation:** Either parse Drizzle's migration error to extract the failing file and populate the field (genuine value), or drop the field and let callers read `error.cause` if they need detail.

### F7 — `drizzle.config.ts` reaches into sibling packages' source — schema ownership is inverted

- **Files:** `packages/datastore/drizzle.config.ts:5-10`
- **Principle/Pattern:** Single Responsibility / inversion of layering
- **Status:** Problematic
- **Evidence:**
  - `drizzle.config.ts:5-9` — `schema: ['../contracts/src/persistence/schema/sessions.ts', '../graph/engine/src/persistence/schema.ts', '../fitness/engine/src/persistence/schema.ts']`
- **Why it matters:** datastore is supposed to be a kernel that knows nothing about fitness/graph/sessions, but `db:generate` requires it to maintain a hand-curated list of every sibling's schema file. Adding a new tool with persistence means editing this file in datastore — i.e., datastore becomes the registry of all consumers, the inverse of the layering rule (`core ← contracts ← {lang-*, fitness, simulation, graph}`). It also means schemas live in three packages but migrations live in a fourth, so a refactor to a schema in `fitness/engine` has its blast radius in `datastore/migrations` — easy to miss in code review.
- **Recommendation:** Two options. (a) Have each persistence-owning package generate and ship its own migrations; datastore exposes a `runMigrations(folder)` primitive that callers chain. (b) Use an inversion of control where consumers `register()` a schema module with datastore, and `db:generate` is driven by that registry. (a) is simpler and aligns with the "each package owns its schema" instinct. Either way, datastore should not enumerate its consumers.

### F8 — Migration folder path resolution assumes `dist`-relative layout, undocumented coupling

- **Files:** `packages/datastore/src/factory.ts:12-14`
- **Principle/Pattern:** Implicit contract / fragile path math
- **Status:** Problematic (mild)
- **Evidence:**
  - `factory.ts:12-14` — `return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');` — works only because compiled JS lives in `dist/` and `migrations/` is a peer of `dist/`.
- **Why it matters:** Any change to `tsconfig.json` `outDir` (e.g. `dist/src/` vs `dist/`) silently breaks migration discovery at runtime, with the error surfacing as `DataStoreMigrationError("Schema migration failed")` — opaque to the user. The relationship between `outDir` and the `..` is implicit.
- **Recommendation:** Either add a comment at `factory.ts:12` documenting the layout assumption, or resolve the migrations folder by walking up to the package root (e.g. find the nearest `package.json` whose name is `@opensip-tools/datastore`). The latter is more robust; the former is the cheap fix.

### F9 — No repository / unit-of-work abstraction; consumers reach into `datastore.db` directly

- **Files:** `packages/contracts/src/persistence/session-repo.ts:116-186`, `packages/graph/engine/src/persistence/baseline-repo.ts` (entire file)
- **Principle/Pattern:** Repository / Unit of Work; encapsulation
- **Status:** Missing opportunity (informational — boundary lives outside this package)
- **Evidence:**
  - `session-repo.ts:116` — `this.datastore.db.select().from(sessions).where(...)`
  - `session-repo.ts:143, 153, 161, 186` — direct `datastore.db.*` query chains.
  - `session-repo.ts:218` — `this.datastore.transaction((tx) => { ... })` mixes raw Drizzle and the abstraction.
- **Why it matters:** This is not a datastore-package finding strictly — but it's the question the audit prompt asked ("repository / unit-of-work shape, if any"). The current shape is: datastore exposes a raw Drizzle handle; every consumer writes its own repository against that handle (`SessionRepo`, `BaselineRepo`, `CatalogRepo`). That's a fine pattern, but `DataStore`'s only contributions are `db`, `close`, and `transaction` — there's no unit-of-work, no scoped query context, no batched-writer. Repositories construct themselves with `new SessionRepo(datastore)` and hold the whole store, which is more privilege than they need (any repo can drop any table).
- **Recommendation:** Not actionable at the datastore-package layer alone. If a future change wants finer-grained access, introduce a `QueryContext` abstraction (a narrow view: `tx` + schema slice) that repositories receive instead of the full `DataStore`. Out of scope for this audit; flagged because the prompt asked.

### F10 — Two-line backend files duplicate structure without adding value

- **Files:** `packages/datastore/src/backends/memory.ts:1-7`, `packages/datastore/src/backends/sqlite.ts:1-11`, `packages/datastore/src/backends/shared.ts:6-23`
- **Principle/Pattern:** DRY / file-per-concept overuse
- **Status:** Problematic (mild)
- **Evidence:**
  - `backends/memory.ts` is 7 lines total: one import, one re-export-style wrapper.
  - `backends/sqlite.ts` is 11 lines: an `mkdirSync` + the same `buildSqliteDataStore` call.
  - The actual logic lives entirely in `backends/shared.ts`.
- **Why it matters:** Three files where one would do. The `backends/` directory advertises a Strategy pattern (see F1) and the file names imply distinct implementations, but `shared.ts` holds the entire implementation. Readers click through three files to understand 25 lines of code.
- **Recommendation:** Collapse `backends/{memory,sqlite,shared}.ts` into a single `backends/sqlite.ts` (or move it up into `data-store.ts`) with two exported functions. If F1 Option B is taken (real second backend), the directory structure becomes justified — but only then.

### F11 — `close()` idempotency is implementation-only, not contract

- **Files:** `packages/datastore/src/data-store.ts:8`, `packages/datastore/src/backends/shared.ts:11-18`, `packages/datastore/src/__tests__/factory.test.ts:45-49`
- **Principle/Pattern:** Interface Segregation / contract clarity
- **Status:** Problematic (mild)
- **Evidence:**
  - `data-store.ts:8` — interface says only `close(): void;`
  - `backends/shared.ts:11-18` — implementation tracks `closed` and no-ops on second call.
  - Tests assert it: `factory.test.ts:48` — `expect(() => ds.close()).not.toThrow();`
- **Why it matters:** The idempotency is behaviour the tests rely on and that callers in error paths (`factory.ts:33` calls `close()` on migrate failure, after which the caller may also try to close) will hit. It's part of the contract in practice, but a future backend author reading only the interface won't know that. The `factory.ts:33` early-close + caller-may-close pattern is itself a footgun without this guarantee.
- **Recommendation:** Document `close(): void` with a JSDoc note: "Idempotent — safe to call multiple times." This is a one-line fix and prevents a future backend from silently breaking the factory's error-path assumption.

## Strengths

- **Composition over inheritance is consistent.** Backends are object literals implementing `DataStore` (`backends/shared.ts:12-22`); no base class, no template-method, no inheritance chains. Easy to reason about, easy to test.
- **`Error.cause` is handled correctly.** The comment at `data-store.ts:22-23` explains exactly why the `cause` slot is delegated to `super(...)` rather than redeclared as a field — this is a subtle ES2022 issue and getting it right reflects care.
- **Conditional construction of `super(message, options)`** — `data-store.ts:24` — avoids passing `{ cause: undefined }` and triggering quirks in older runtimes. Defensive in the right way.
- **Error messages are actionable.** Both `openFailureMessage` and `migrateFailureMessage` (`factory.ts:40-52`) name the failing path and give a recovery command ("Delete `<path>`"). This is the right pattern for a CLI tool's persistence layer.
- **Tests cover the error paths, not just the happy paths.** `factory.test.ts:56-118` exercises corrupted-file, bad-migration-folder, and per-backend error message paths — unusually thorough for this size.
- **Migrations are checked in and shipped via `files: ["dist", "migrations"]`** (`package.json:21-24`) — no runtime generation, no environment drift.

## Notes

- The package is small (~150 LOC of source). Several findings (F4, F10, F11) are minor and could reasonably be left alone if there's no near-term plan for a second backend. The two structurally important ones are **F1+F2+F3 as a cluster** (the abstraction does not actually exist) and **F7** (drizzle.config.ts inverts the layering). I'd treat those as a single decision: either commit to real backend polymorphism and pay it down properly, or admit this is the SQLite store and simplify accordingly.
- F9 is out of scope for the datastore package but was explicitly requested by the audit prompt ("repository / unit-of-work shape, if any"). The short answer: no unit-of-work; repositories own raw `DataStore` references. That's a deliberate, defensible choice for a tool of this size — flagged for completeness, not as a fix-now item.
- `dependency-cruiser` enforces layering at runtime imports, but `drizzle.config.ts` (F7) is a build-time tool config and is not subject to those rules. This is a category of architectural drift the existing guardrails don't catch.
