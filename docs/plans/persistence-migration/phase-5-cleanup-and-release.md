# Phase 5: Cleanup, CHANGELOG, version bump

**Goal:** CHANGELOG, README upgrade notes, test-fixture cleanup, and workspace version bump. Architecture-doc rewrites and the web-sync regeneration move to Phase 6.
**Depends on:** Phases 1, 2, 3, 4

This phase is the non-architecture cleanup. Production code is already in its v2 shape after Phase 4; architecture-docs work runs in Phase 6 against the now-finished code.

---

## Task 5.1: CHANGELOG and README upgrade entry

**Files:** [size: S]
- Modify: `CHANGELOG.md` (or create if absent — verify)
- Modify: `README.md`

**Context:** v2.0.0 is a breaking change for users with v1 `.runtime/` state. The CHANGELOG must be unambiguous about the break.

**Steps:**

1. Add a CHANGELOG entry for `2.0.0` (Unreleased until publish) under sections:
   - **Breaking changes:** Runtime state has migrated from JSON files to SQLite. v1 `.runtime/` is ignored on first v2 run. Users wanting to preserve v1 state should stay on v1.x.
   - **Added:** `@opensip-tools/datastore` package; SQLite + Drizzle persistence layer. Automatic schema migrations on upgrade between v2.x versions (no user action required).
   - **Removed:** `cache/read.ts`, `cache/write.ts`, `cache/normalize.ts` from graph engine. `configurePersistencePaths` global API from contracts. `DEFAULT_BASELINE_PATH` constant and `--baseline <path>` flag from fitness (everything in the SQLite store now; no per-baseline file paths).
   - **Changed:** `ToolCliContext` gains `datastore` field. `StoredSession` shape unchanged; layout changes from JSON files to SQLite tables.
   - **Upgrade behavior (v2.x → v2.y):** first invocation applies pending schema migrations automatically. No user action.
   - **Downgrade unsupported:** downgrading across schema changes will throw `DataStoreMigrationError` on next run; recover by deleting `<project>/opensip-tools/.runtime/datastore.sqlite` (cache rebuilds; session history lost).
2. README: add an "Upgrading from v1.x to v2.x" section near the top. One paragraph: states the break, notes the runtime state reset, links to the CHANGELOG, says "stay on v1.x if you need the v1 layout."

**Verification:**

```bash
pnpm lint
```

**Commit:** `docs: document v2.0.0 breaking change`

---

## Task 5.2: Confirm release ordering, document schema evolution, run release-smoke-test

**Files:** [size: M]
- Modify: `RELEASING.md` (final check + new schema-evolution section)
- Modify: `docs/release-smoke-test.md` (if it enumerates `.runtime/` layout expectations)

**Context:** Release tooling needs to publish `@opensip-tools/datastore` between `core` and `contracts`. Phase 0 set this; Phase 5 confirms. `RELEASING.md` is also the natural home for the schema-evolution workflow developers will need going forward — it sits alongside the existing publish-order and OIDC documentation.

**Steps:**

1. Re-read `RELEASING.md`. Verify datastore appears in the publish order between core and contracts. Verify package count matches the new total (18).
2. Add a new section to `RELEASING.md` titled "Schema evolution between versions." Contents (drawn from Phase 0 Task 0.5's workflow description):
   - When to add a migration: any change to a Drizzle schema file (`packages/contracts/src/persistence/schema/`, `packages/graph/engine/src/persistence/schema.ts`, `packages/fitness/engine/src/persistence/schema.ts`).
   - How to generate: `pnpm --filter=@opensip-tools/datastore db:generate`. Review the produced SQL before committing.
   - Never edit a previously-committed migration file in place — Drizzle tracks by content hash; in-place edits leave users undefined.
   - Migration files ship in the package tarball; users on a new version run migrations automatically on next `DataStoreFactory.open()`.
   - Downgrades are unsupported; users downgrading hit `DataStoreMigrationError` and recover by deleting `datastore.sqlite`.
3. Read `docs/release-smoke-test.md` for any assertions about `.runtime/` contents. Update assertions that mention JSON files (catalog.json, baseline.json, session JSONs) to assert SQLite-table presence instead.
4. Run the smoke test locally if the CLI supports it.

**Verification:**

```bash
# From RELEASING.md / smoke-test:
pnpm install && pnpm build && pnpm test && pnpm lint
```

**Commit:** `chore(release): confirm v2 release order and smoke-test expectations`

---

## Task 5.3: Test fixtures cleanup

**Files:** [size: S]
- Delete or clear: `packages/cli/src/__tests__/fixtures/*/opensip-tools/.runtime/` (sessions JSON files, baseline JSON files, catalog JSON files in fixtures)

**Context:** Test fixtures under `packages/cli/src/__tests__/fixtures/` carry v1 `.runtime/` state from when they were authored. Some tests will rely on this; others may have already been updated in Phase 7 of this plan. This task is the final sweep.

**Steps:**

1. List all fixture `.runtime/` contents:
   ```bash
   find packages/cli/src/__tests__/fixtures -path "*/opensip-tools/.runtime/*" -type f
   ```
2. For each fixture: if the tests using it have been updated to construct a fresh in-memory DataStore in setup (Phase 7), the fixture's `.runtime/` contents are no longer consulted and should be deleted to avoid confusion. If a test still depends on a fixture state, fix the test (return to Phase 7 if needed).
3. After cleanup, leave the `.runtime/` directories themselves in place (they exist as project markers).

**Verification:**

```bash
pnpm test
find packages/cli/src/__tests__/fixtures -path "*/opensip-tools/.runtime/*" -type f
# Should produce minimal or empty output.
```

**Commit:** `test(fixtures): remove v1 JSON fixtures from test runtime dirs`

---

## Task 5.4: Workspace version bump to 2.0.0

**Files:** [size: XS]
- Modify: root `package.json`
- Modify: every workspace package's `package.json` (`core`, `datastore`, `contracts`, all `lang-*`, `fitness/engine`, `simulation/engine`, `graph/engine`, all `checks-*`, `cli`)

**Context:** All packages publish at the same version (verify from `RELEASING.md`'s coordinated-publish description). Bumping the root + all 18 packages (17 existing + new `@opensip-tools/datastore`) to `2.0.0` is the release-prep step. Per CLAUDE.md and `RELEASING.md`, the publish itself is OIDC-driven and runs in Phase 9; this task does only the version-string bump.

**Steps:**

1. Walk every `package.json` in the workspace; set `"version": "2.0.0"`.
2. Verify `pnpm install` regenerates the lockfile cleanly with the new versions.

**Verification:**

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

**Commit:** `chore: bump workspace to 2.0.0`

---

## Phase 5 End-to-End Verification

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
grep -l "2.0.0" CHANGELOG.md README.md
# Confirm no JSON-era state in fixtures
find packages/cli/src/__tests__/fixtures -path "*/opensip-tools/.runtime/*" -type f
# Confirm version
grep '"version"' package.json packages/*/package.json packages/*/*/package.json
```

Expected state: every package at 2.0.0, CHANGELOG and README document the v2 break, fixtures no longer carry v1 JSON state. Architecture docs are not yet updated — that's Phase 6.
