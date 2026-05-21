# Phase 6: Architecture docs and web sync

**Goal:** Update `docs/architecture/` to reflect the v2 SQLite+Drizzle persistence layer, then regenerate `docs/web/` (the synced website mirror) via `pnpm docs:build`. Architecture is the source-of-truth; `docs/web/` is generated and committed.
**Depends on:** Phases 1, 2, 3, 4 (production code in its v2 shape); Phase 5 (CHANGELOG + version exist for the manifest's version field)

This phase exists because:

1. `docs/architecture/` is the source-of-truth for the architecture docset. `docs/web/` is a generated mirror with link rewriting + manifest, consumed by opensip.ai at runtime via the `rawBase` pin documented in `docs/website-integration.md`.
2. The CI sync check (per `docs/website-integration.md:351`) fails if `docs/web/` drifts from `docs/architecture/`. Skipping the regeneration step would land architecture changes that the website never sees and CI would block the release.
3. The manifest's `version` and `rawBase` fields embed the release tag (e.g. `v1.3.1`), so they must be updated for the v2.0.0 release.

---

## Task 6.1: Rewrite the session-and-persistence runtime doc

**Files:** [size: M]
- Modify: `docs/architecture/50-runtime/03-session-and-persistence.md`

**Context:** This doc currently describes "five kinds of on-disk artifacts: the session record, the structured log, the dashboard report, the cache, and (optionally) the gate baseline" — all as JSON files. After the migration, sessions, cache, and baseline live in SQLite. Logs and reports stay as files. **Edit the architecture/ version, not the web/ version** — `docs:build` regenerates `docs/web/` from `docs/architecture/`.

**Steps:**

1. Re-read the existing doc at `docs/architecture/50-runtime/03-session-and-persistence.md` to internalize its conventions (frontmatter, voice, audience).
2. Rewrite the body. Cover at minimum:
   - "Three artifact kinds live in SQLite (`datastore.sqlite`): sessions, the graph catalog + baseline, the fit file-cache + baseline."
   - "Two artifact kinds stay as files (`logs/*.jsonl`, `reports/*.html`)."
   - The new `.runtime/` layout (including the WAL/SHM sidecars produced by SQLite at runtime).
   - **Lifecycle commands and their data-layer effects:**
     - `sessions list` — `SELECT FROM sessions` ordered by timestamp DESC.
     - `sessions purge --before <date>` — `DELETE FROM sessions WHERE timestamp < ?`; FK cascade removes findings. **Row-level data deletion, not file removal.**
     - `--no-cache` flag on `fit`/`graph` — forces cache miss; the existing fingerprint-based invalidation path runs even if `datastore.sqlite` exists.
     - `opensip-tools uninstall --project` — removes `<project>/opensip-tools/` recursively, including `datastore.sqlite` and its WAL/SHM sidecars. **Destroys the whole DB along with all other project state.**
     - `opensip-tools uninstall` (no flag) — removes `~/.opensip-tools/`. No DB there; user-global state is a single config file.
   - **Upgrade behavior:** first run of a new opensip-tools version calls `DataStoreFactory.open()`, which applies any pending Drizzle migrations. Users see no extra step. Migrations are content-hashed and idempotent.
   - **Failure mode:** if migration throws (corrupted DB, downgrade across schema change), the CLI surfaces `DataStoreMigrationError` with a recovery hint: delete `datastore.sqlite` for a fresh start (cache rebuilds, session history lost).
   - Cross-link to `../../plans/persistence-migration/decisions.md` for rationale (note the path is relative to `docs/architecture/50-runtime/`).
3. Update the frontmatter:
   - `last_verified: <YYYY-MM-DD of this work>`
   - `source-files` — drop deleted files (`packages/graph/engine/src/cache/read.ts`, `cache/write.ts`); add `packages/datastore/src/data-store.ts`, `packages/datastore/src/factory.ts`, the schema files under each owning package, the repo files.
   - `related-docs` — add a pointer to `../90-conventions/02-layer-policy.md` (updated in Task 6.2).
4. If the doc has a "What you'll understand after this" section, refresh the bullets.

**Wiring:** Documentation-only. The `docs:build` run in Task 6.4 regenerates `docs/web/50-runtime/03-session-and-persistence.md` automatically.

**Verification:**

```bash
pnpm lint
```

**Commit:** `docs(architecture): rewrite session-and-persistence for SQLite + Drizzle`

---

## Task 6.2: Update the layer-policy convention doc

**Files:** [size: S]
- Modify: `docs/architecture/90-conventions/02-layer-policy.md`

**Context:** The layer policy doc describes the architectural layering enforced by `.dependency-cruiser.cjs`. The new `@opensip-tools/datastore` package between `core` and `contracts` belongs in the diagram and policy text.

**Steps:**

1. Add `@opensip-tools/datastore` to the layer diagram between `core` and `contracts`.
2. Document the policy: datastore depends only on core; contracts and tool packages depend on datastore; core does not depend on datastore.
3. Refresh `last_verified`.

**Verification:**

```bash
pnpm lint
```

**Commit:** `docs(architecture): document datastore layer in layer-policy`

---

## Task 6.3: Sweep other architecture docs for stale references

**Files:** [size: S]
- Modify (potentially): other files under `docs/architecture/**/*.md` that reference JSON files, `catalog.json`, `baseline.json`, `configurePersistencePaths`, or the deleted `cache/read.ts`/`cache/write.ts`/`cache/normalize.ts`.

**Context:** Beyond the two main docs (`03-session-and-persistence.md`, `02-layer-policy.md`), other architecture docs may reference the old persistence shape in passing — `40-the-graph-loop/`, `60-subsystems/`, or surface docs under `70-surfaces/`. A grep-driven sweep catches the rest.

**Steps:**

1. Grep for stale references:
   ```bash
   grep -rn "catalog\.json\|baseline\.json\|configurePersistencePaths\|cache/read\|cache/write\|cache/normalize" docs/architecture --include="*.md"
   ```
2. For each hit, decide: (a) update to reflect SQLite+Drizzle; (b) the reference is historically accurate (e.g. in a migration log) and stays; (c) the section is now wrong and needs rewriting.
3. Refresh `last_verified` on each modified doc.

**Verification:**

```bash
pnpm lint
# Re-grep after edits — only intentional historical references should remain:
grep -rn "catalog\.json\|baseline\.json\|configurePersistencePaths" docs/architecture --include="*.md"
```

**Commit:** `docs(architecture): sweep stale persistence references for v2`

---

## Task 6.4: Regenerate `docs/web/` via `pnpm docs:build`

**Files:** [size: S]
- Modify: every file under `docs/web/` that has a corresponding source in `docs/architecture/` (regenerated automatically by the script — do not hand-edit)
- Modify: `docs/web/manifest.json` (regenerated, including `version` and `rawBase` updates for v2.0.0)

**Context:** `tools/build-web-docs.mjs` reads `docs/architecture/**/*.md`, applies link rewriting (source-code refs to GitHub URLs pinned to the release tag; sibling `.md` links to website paths), and writes the result to `docs/web/`. Run via `pnpm docs:build`. The output is committed so the website needs no build-on-fetch logic and PR reviewers see exactly what will render.

**Steps:**

1. Run `pnpm docs:build`. The script reads `docs/architecture/`, processes the markdown, and writes `docs/web/`.
2. Confirm `docs/web/manifest.json` has the expected v2.0.0 fields:
   - `version: "2.0.0"` (matching the workspace bump in Phase 5 Task 5.4)
   - `rawBase: "https://raw.githubusercontent.com/opensip-ai/opensip-tools/v2.0.0/"`
   
   If the version field is derived from a package.json (likely `packages/core/package.json` per the existing script behavior), the bump in Phase 5 already drives this; otherwise update the script's source.
3. Confirm `pnpm docs:check` is now green:
   ```bash
   pnpm docs:check
   ```
   This is the CI sync check — fails if `docs/web/` drifts from `docs/architecture/`. After `docs:build`, it must pass.

**Verification:**

```bash
pnpm docs:build
pnpm docs:check                              # 0 errors; no drift
git diff --stat docs/web/                    # observe the regenerated files
```

**Commit:** `docs(web): regenerate for v2.0.0`

The commit message intentionally mirrors prior precedent (`docs(web): regenerate permalinks for v1.3.1` — git log shows this is the project's convention for sync regenerations).

---

## Phase 6 End-to-End Verification

```bash
pnpm install
pnpm docs:build
pnpm docs:check                              # green — no drift
pnpm lint                                    # 0 errors
# Confirm architecture is source-of-truth, not web:
diff <(grep -rn "datastore" docs/architecture --include="*.md" | wc -l) \
     <(grep -rn "datastore" docs/web --include="*.md" | wc -l)
# These should match — `docs/web/` is a direct mirror of `docs/architecture/`.
```

Expected state: `docs/architecture/` accurately reflects the v2 architecture; `docs/web/` is regenerated and committed; manifest's `version` and `rawBase` are pinned to v2.0.0; CI sync check (`pnpm docs:check`) is green.
