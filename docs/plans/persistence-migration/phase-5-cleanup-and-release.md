# Phase 5: Cleanup and v2 release

**Goal:** Documentation rewrites, fixture cleanup, CHANGELOG, version bump, and any straggler removals that finalize the v2.0.0 release.
**Depends on:** Phases 1, 2, 3, 4

This phase is mostly subtraction and documentation. No new architecture; the production code is already in its v2 shape by the end of Phase 4.

---

## Task 5.1: Rewrite the session-and-persistence runtime doc

**Files:** [size: M]
- Modify: `docs/web/50-runtime/03-session-and-persistence.md`

**Context:** This doc currently describes "five kinds of on-disk artifacts: the session record, the structured log, the dashboard report, the cache, and (optionally) the gate baseline" — all as JSON files. After the migration, sessions, cache, and baseline live in SQLite. Logs and reports stay as files. The doc must reflect the new architecture truthfully.

**Steps:**

1. Re-read the existing doc to internalize its conventions (frontmatter, voice, audience).
2. Rewrite the body:
   - "Three artifact kinds live in SQLite (`datastore.sqlite`): sessions, the graph catalog + baseline, the fit file-cache + baseline."
   - "Two artifact kinds stay as files (`logs/*.jsonl`, `reports/*.html`)."
   - Show the new `.runtime/` layout.
   - Cross-link to `decisions.md` (`../../plans/persistence-migration/decisions.md`) for rationale.
3. Update the frontmatter:
   - `last_verified: 2026-05-21`
   - `source-files` — drop deleted files (`cache/read.ts`, `cache/write.ts`); add `packages/datastore/src/data-store.ts`, the schema files, the repo files.
   - `related-docs` — add a pointer to `90-conventions/02-layer-policy.md` (which will be updated in Task 5.2 to describe the new layer).
4. If the doc has a "What you'll understand after this" section, refresh the bullets.

**Wiring:** Documentation-only. Should pass the fitness checks that validate doc structure (if any apply).

**Verification:**

```bash
pnpm lint                                    # 0 errors; docs pass any structural checks
```

**Commit:** `docs(runtime): rewrite session-and-persistence for SQLite + Drizzle`

---

## Task 5.2: Update the layer-policy convention doc

**Files:** [size: S]
- Modify: `docs/web/90-conventions/02-layer-policy.md`

**Context:** The layer policy doc describes the architectural layering enforced by `.dependency-cruiser.cjs`. The new `@opensip-tools/datastore` package between `core` and `contracts` belongs in the diagram and policy text.

**Steps:**

1. Add `@opensip-tools/datastore` to the layer diagram between `core` and `contracts`.
2. Document the policy: datastore depends only on core; contracts and tool packages depend on datastore; core does not depend on datastore.
3. Refresh `last_verified`.

**Verification:**

```bash
pnpm lint
```

**Commit:** `docs(conventions): document datastore layer in layer-policy`

---

## Task 5.3: CHANGELOG and README upgrade entry

**Files:** [size: S]
- Modify: `CHANGELOG.md` (or create if absent — verify)
- Modify: `README.md`

**Context:** v2.0.0 is a breaking change for users with v1 `.runtime/` state. The CHANGELOG must be unambiguous about the break.

**Steps:**

1. Add a CHANGELOG entry for `2.0.0` (Unreleased until publish) under sections:
   - **Breaking changes:** Runtime state has migrated from JSON files to SQLite. v1 `.runtime/` is ignored on first v2 run. Users wanting to preserve v1 state should stay on v1.x.
   - **Added:** `@opensip-tools/datastore` package; SQLite + Drizzle persistence layer.
   - **Removed:** `cache/read.ts`, `cache/write.ts`, `cache/normalize.ts` from graph engine. `configurePersistencePaths` global API from contracts.
   - **Changed:** `ToolCliContext` gains `datastore` field. `StoredSession` shape unchanged; layout changes from JSON files to SQLite tables.
2. README: add an "Upgrading from v1.x to v2.x" section near the top. One paragraph: states the break, links to the CHANGELOG, says "stay on v1.x if you need the v1 layout."

**Verification:**

```bash
pnpm lint
```

**Commit:** `docs: document v2.0.0 breaking change`

---

## Task 5.4: Confirm release ordering and run release-smoke-test

**Files:** [size: S]
- Modify: `RELEASING.md` (final check; primary change was Phase 0 Task 0.6)
- Modify: `docs/release-smoke-test.md` (if it enumerates `.runtime/` layout expectations)

**Context:** Release tooling needs to publish `@opensip-tools/datastore` between `core` and `contracts`. Phase 0 set this; Phase 5 confirms.

**Steps:**

1. Re-read `RELEASING.md`. Verify datastore appears in the publish order between core and contracts. Verify package count matches the new total (18).
2. Read `docs/release-smoke-test.md` for any assertions about `.runtime/` contents. Update assertions that mention JSON files (catalog.json, baseline.json, session JSONs) to assert SQLite-table presence instead.
3. Run the smoke test locally if the CLI supports it.

**Verification:**

```bash
# From RELEASING.md / smoke-test:
pnpm install && pnpm build && pnpm test && pnpm lint
```

**Commit:** `chore(release): confirm v2 release order and smoke-test expectations`

---

## Task 5.5: Test fixtures cleanup

**Files:** [size: S]
- Delete or clear: `packages/cli/src/__tests__/fixtures/*/opensip-tools/.runtime/` (sessions JSON files, baseline JSON files, catalog JSON files in fixtures)

**Context:** Test fixtures under `packages/cli/src/__tests__/fixtures/` carry v1 `.runtime/` state from when they were authored. Some tests will rely on this; others may have already been updated in Phase 6 of this plan. This task is the final sweep.

**Steps:**

1. List all fixture `.runtime/` contents:
   ```bash
   find packages/cli/src/__tests__/fixtures -path "*/opensip-tools/.runtime/*" -type f
   ```
2. For each fixture: if the tests using it have been updated to construct a fresh in-memory DataStore in setup (Phase 6), the fixture's `.runtime/` contents are no longer consulted and should be deleted to avoid confusion. If a test still depends on a fixture state, fix the test (return to Phase 6 if needed).
3. After cleanup, leave the `.runtime/` directories themselves in place (they exist as project markers).

**Verification:**

```bash
pnpm test
find packages/cli/src/__tests__/fixtures -path "*/opensip-tools/.runtime/*" -type f
# Should produce minimal or empty output.
```

**Commit:** `test(fixtures): remove v1 JSON fixtures from test runtime dirs`

---

## Task 5.6: Workspace version bump to 2.0.0

**Files:** [size: XS]
- Modify: root `package.json`
- Modify: every workspace package's `package.json` (`core`, `datastore`, `contracts`, all `lang-*`, `fitness/engine`, `simulation/engine`, `graph/engine`, all `checks-*`, `cli`)

**Context:** All packages publish at the same version (verify from `RELEASING.md`'s coordinated-publish description). Bumping the root + all 17 (or 18) packages to `2.0.0` is the release-prep step. Per CLAUDE.md and `RELEASING.md`, the publish itself is OIDC-driven and runs separately; this task does only the version-string bump.

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
# Inspect docs
ls docs/web/50-runtime/ docs/web/90-conventions/
grep -l "2.0.0" CHANGELOG.md README.md
# Confirm no JSON-era state in fixtures
find packages/cli/src/__tests__/fixtures -path "*/opensip-tools/.runtime/*" -type f
# Confirm version
grep '"version"' package.json packages/*/package.json packages/*/*/package.json
```

Expected state: every package at 2.0.0, documentation reflects SQLite+Drizzle architecture, CHANGELOG documents the v2 break, fixtures no longer carry v1 JSON state. The release is ready for the standard publish flow.
