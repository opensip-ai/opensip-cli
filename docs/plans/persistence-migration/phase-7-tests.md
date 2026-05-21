# Phase 7: Tests

**Goal:** Cover the work in Phases 0–6 with unit and integration tests using the in-memory backend for unit tests and SQLite-in-tmp-dir for integration tests.
**Depends on:** All implementation phases (0–6).

This phase is a scaffold. opensip-tools does not have the OpenSIP backend's plan-improvements pipeline (which would enrich test patterns from a Phase 10 prompt). Test patterns here follow the existing conventions in this repo: Vitest, `*.test.ts` adjacent to source, no global mocks unless necessary.

The phase is structured around three test scopes: per-package unit tests (against in-memory DataStore), cross-package integration tests (against SQLite in a tmp dir), and the dashboard regression net (existing tests in `packages/contracts/src/__tests__/dashboard-*.test.ts`).

---

## Task 7.1: Datastore package unit tests

**Files:** [size: M]
- Create: `packages/datastore/src/__tests__/data-store.test.ts`
- Create: `packages/datastore/src/__tests__/backends/sqlite.test.ts`
- Create: `packages/datastore/src/__tests__/backends/memory.test.ts`
- Create: `packages/datastore/src/__tests__/factory.test.ts`

**Context:** The datastore contract is what every other repo builds against. Covering its lifecycle, transaction semantics, and migration application end-to-end means the rest of the migration's tests can trust the foundation.

**Steps:**

1. Lifecycle tests: open → use → close cycle for both backends. Verify close is idempotent (calling twice doesn't throw) and post-close access fails predictably.
2. Transaction tests: nested transactions (Drizzle's behavior — likely throws or no-ops; verify expected behavior and lock it down); rollback on error; commit on success.
3. Factory tests: opening with `backend: 'memory'` produces an isolated store (two memory backends in the same process don't share data); opening with `backend: 'sqlite'` produces a file that re-opens with state intact across factory calls.
4. Migration application — happy path: open against an empty SQLite file, observe that all migrations apply cleanly. Open against a SQLite file at the latest migration, observe no-op.
5. **Migration application — schema bump path** (covers the v2.x → v2.y upgrade story): seed an in-memory DB with the *initial* migration only (skipping later ones via a custom `migrationsFolder` pointing at a fixture), then re-open with the *full* migrations folder and confirm later migrations apply on top. This is the test that catches "we shipped an in-place edit of a previous migration" type bugs — without it, the schema-evolution workflow documented in Phase 0 Task 0.5 has no verification.
6. **`DataStoreMigrationError` corruption recovery path** (covers the failure-mode story): corrupt the SQLite file header (e.g., write garbage to the first 16 bytes), attempt to open, assert `DataStoreMigrationError` is thrown, assert the error message contains the recovery hint about deleting the file. Without this test, the documented recovery path is unverified.
7. Concurrency smoke (WAL mode): open two SQLite handles against the same file path; one writer + one reader can coexist; document any locking caveats observed.

**Wiring:** Tests run via `pnpm --filter=@opensip-tools/datastore test`.

**Verification:**

```bash
pnpm --filter=@opensip-tools/datastore test
```

**Commit:** `test(datastore): cover DataStore contract, backends, factory`

---

## Task 7.2: Sessions / `SessionRepo` tests

**Files:** [size: M]
- Create: `packages/contracts/src/__tests__/session-repo.test.ts`
- Modify: Any existing `packages/contracts/src/__tests__/store*.test.ts` files — port them to use `SessionRepo` over an in-memory DataStore, or delete those tests if they were testing the old `configurePersistencePaths` global state directly.

**Context:** Cover `save`, `list`, `get`, `purge`, including the foreign-key cascade from sessions → findings. Use an in-memory DataStore in each test's setup; tear down between tests by closing it.

**Steps:**

1. Construct an in-memory DataStore in `beforeEach`; pass to `new SessionRepo(datastore)`.
2. Test cases:
   - Save a session with findings, get it back, assert structural equality.
   - List sessions filtered by tool; assert ordering by timestamp DESC.
   - List with limit honored.
   - Purge with date earlier than all sessions: rowcount = total.
   - Purge with date between two sessions: rowcount = 1.
   - Cascade: purge a session, assert its findings are also gone.
   - Get with nonexistent ID: returns null (not throws).
3. Round-trip a `summary` aggregate to confirm JSON-mode encoding is lossless.

**Verification:**

```bash
pnpm --filter=@opensip-tools/contracts test
```

**Commit:** `test(contracts): cover SessionRepo over in-memory DataStore`

---

## Task 7.3: Graph baseline + catalog repo tests

**Files:** [size: L]
- Create: `packages/graph/engine/src/__tests__/persistence/baseline-repo.test.ts`
- Create: `packages/graph/engine/src/__tests__/persistence/catalog-repo.test.ts`
- Modify or delete: `packages/graph/engine/src/__tests__/gate.test.ts` (rewrite against in-memory DataStore)

**Context:** `BaselineRepo` tests mirror `SessionRepo` tests structurally — save, load, exists, replace-on-save invariant. `CatalogRepo` tests are larger because the surface is larger: upsert deduplication on `body_hash`, occurrence/edge insertion, per-package replacement, full-catalog load returning the legacy `Catalog` shape, fingerprint storage.

**Steps:**

1. Baseline tests:
   - Save signals, load them back, assert structural equality.
   - Re-save with a different set; assert the prior set is gone (replace semantics).
   - `exists()` returns false on empty DB, true after first save.
2. Catalog tests — by sub-surface:
   - **Content addressing:** call `upsertFunction(bodyHash='X', ...)` twice with the same hash. Assert one row in `catalog_functions`.
   - **Occurrence insert:** insert occurrences pointing at a hash; assert FK linkage; assert generated IDs are returned for the edges step.
   - **Edge insert:** insert edges referencing occurrence IDs; round-trip via full catalog load.
   - **Per-package replace:** seed two packages; call `replaceForPackage('typescript', 'pkg-a', ...)`; assert pkg-a's occurrences are replaced and pkg-b's are untouched.
   - **FK cascade:** insert occurrences + edges, then delete occurrences; assert edges are cascaded.
   - **Fingerprint round-trip:** `setFingerprint('typescript', 'pkg-a', 'hashX')`; `getFingerprint('typescript', 'pkg-a')` returns `'hashX'`; mismatch case returns the stored value, not the queried one.
3. Gate tests: rewrite the previous `gate.test.ts` (if it exists) to construct a `BaselineRepo` over in-memory DataStore. Behavior unchanged from v1; storage layer is what's under test.

**Verification:**

```bash
pnpm --filter=@opensip-tools/graph test
```

**Commit:** `test(graph): cover BaselineRepo and CatalogRepo`

---

## Task 7.4: Fit file-cache + baseline repo tests

**Files:** [size: M]
- Create: `packages/fitness/engine/src/__tests__/persistence/baseline-repo.test.ts`
- Create: `packages/fitness/engine/src/__tests__/persistence/file-cache-repo.test.ts`
- Modify: any existing fitness gate or file-cache tests to use the new repo surfaces.

**Context:** Mirrors Task 7.3 structurally. File-cache tests focus on the composite primary-key behavior (file_path + content_hash + check_slug) and on invalidation semantics.

**Steps:**

1. Baseline tests: mirror graph baseline tests (save, load, exists, replace-on-save).
2. File-cache tests:
   - Store entry, lookup with matching (file, hash, check): returns it.
   - Lookup with mismatched content_hash: returns null (cache miss = file changed).
   - Lookup with mismatched check_slug: returns null (different check, different result).
   - `invalidateFile(filePath)` removes all entries for that file across check_slugs; assert rowcount.
   - `purge(olderThan)` removes stale entries; assert rowcount.
   - JSON round-trip of a representative `result` payload.

**Verification:**

```bash
pnpm --filter=@opensip-tools/fitness test
```

**Commit:** `test(fitness): cover FitBaselineRepo and FitFileCacheRepo`

---

## Task 7.5: Dashboard regression tests (the safety net)

**Files:** [size: M]
- Modify: `packages/contracts/src/__tests__/dashboard-*.test.ts` (all of them — see the list below)

**Context:** The dashboard generator tests (`dashboard-generator-graph-catalog.test.ts`, `dashboard-view-coupling.test.ts`, `dashboard-view-hot.test.ts`, `dashboard-view-sccs.test.ts`, `dashboard-trace.test.ts`, `dashboard-function-card.test.ts`, etc.) cover the rich derivations that this migration most affects. They are the strongest correctness signal we have; they must pass.

**Steps:**

1. List every `dashboard-*.test.ts`:
   ```bash
   ls packages/contracts/src/__tests__/dashboard-*.test.ts
   ```
2. For each: identify the test's data setup (where it constructs the catalog and session input). Refactor those setups using the pattern below.
3. The test assertions on rendered HTML or derived structure should remain unchanged — the migration is at-parity. If a test's assertion changes substantively, that's a signal of a parity regression to investigate, not a sign to update the assertion.

**Worked example — the canonical refactor pattern.** Use this as the template for every dashboard test:

```ts
// BEFORE (current v1 shape — illustrative)
import { describe, it, expect } from 'vitest';
import { generateDashboard } from '../persistence/dashboard/generator.js';
import type { Catalog, StoredSession } from '../persistence/store.js';

describe('dashboard-view-coupling', () => {
  it('renders coupling for a function with two callers', () => {
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      cacheKey: 'test',
      builtAt: '2026-05-21T00:00:00.000Z',
      functions: {
        'src/a.ts:target': [/* occurrence with two incoming edges */],
        'src/b.ts:caller1': [/* occurrence calling target */],
        'src/c.ts:caller2': [/* occurrence calling target */],
      },
    };
    const session: StoredSession = { /* ... */ };

    const html = generateDashboard({ catalog, session });
    expect(html).toContain('callers: 2');
  });
});
```

```ts
// AFTER (v2 — in-memory DataStore + repos)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataStoreFactory } from '@opensip-tools/datastore';
import { CatalogRepo } from '@opensip-tools/graph/persistence';
import { SessionRepo } from '../persistence/session-repo.js';
import { generateDashboard } from '../persistence/dashboard/generator.js';
import type { Catalog, StoredSession } from '../persistence/store.js';

describe('dashboard-view-coupling', () => {
  let datastore: ReturnType<typeof DataStoreFactory.open>;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
  });

  afterEach(() => {
    datastore.close();
  });

  it('renders coupling for a function with two callers', () => {
    // Seed via the same Catalog literal as before — the repo absorbs it.
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      cacheKey: 'test',
      builtAt: '2026-05-21T00:00:00.000Z',
      functions: {
        'src/a.ts:target': [/* occurrence with two incoming edges */],
        'src/b.ts:caller1': [/* occurrence calling target */],
        'src/c.ts:caller2': [/* occurrence calling target */],
      },
    };
    new CatalogRepo(datastore).replaceAll(catalog);

    const session: StoredSession = { /* ... */ };
    new SessionRepo(datastore).save(session);

    // Generator now takes the datastore instead of in-memory objects.
    const html = generateDashboard({ datastore });
    expect(html).toContain('callers: 2');
  });
});
```

Key points to copy verbatim across tests:
- `beforeEach` opens a fresh in-memory DataStore. `afterEach` closes it. Tests are fully isolated.
- The test author keeps writing the **same `Catalog` literal** they wrote before. `replaceAll(catalog)` does the row decomposition. No test needs to learn the SQLite schema.
- Same for sessions: `SessionRepo.save(session)` accepts the same `StoredSession` literal.
- The generator's signature changes from `{ catalog, session }` to `{ datastore }` (matching the Phase 1 Task 1.6 change). The generator internally constructs repos and queries them.
- Assertions on the rendered output **do not change**. If they have to, that's a parity bug.

If a test originally constructed dozens of small `Catalog` mutations across `it` blocks, the same pattern applies per-`it`: each `beforeEach` gives a fresh DataStore, each `it` seeds whatever shape it wants. The in-memory backend is cheap enough that per-test setup is negligible.

**Verification:**

```bash
pnpm --filter=@opensip-tools/contracts test
```

If any dashboard test fails for reasons other than test-setup syntax, **do not update the assertion to match**. Investigate the regression in the production code instead.

**Commit:** `test(dashboard): refactor regression tests to in-memory DataStore`

---

## Task 7.6: CLI command tests

**Files:** [size: S]
- Modify: `packages/cli/src/__tests__/*.test.ts` (or wherever CLI integration tests live)

**Context:** The CLI's smoke tests should run end-to-end against a SQLite-in-tmp-dir DataStore (not in-memory — we want to exercise the actual file-based path including WAL mode). The fixtures under `__tests__/fixtures/` are real project directories.

**Steps:**

1. Identify CLI tests that previously depended on `.runtime/sessions/*.json` files being present in fixtures. Those tests now require running the CLI against a fixture, observing that `datastore.sqlite` is created, and asserting expected state via direct SQLite queries (or via re-invoking the CLI's `sessions list`).
2. Tests for `sessions list` / `sessions purge`: invoke against a tmp project dir, observe DB state.
3. Tests for `uninstall`: invoke and assert the DB file is removed.

**Verification:**

```bash
pnpm --filter=@opensip-tools/cli test
```

**Commit:** `test(cli): exercise CLI against SQLite-in-tmp-dir`

---

## Phase 7 End-to-End Verification

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint
pnpm test                                    # 0 failures across the workspace
```

Expected state: every new repo class has unit-test coverage against the in-memory backend; the dashboard regression tests pass against the new persistence layer with identical assertions; CLI integration tests run against real SQLite-on-disk including the WAL pathway.
