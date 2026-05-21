# Phase 7: Validation

**Goal:** Exercise the full integrated flow against real SQLite-on-disk. Confirm parity with v1 behavior on this repo and on a representative sample of consumer projects.
**Depends on:** All prior phases including Phase 6.

This phase is a scaffold. opensip-tools does not have the OpenSIP backend's "lab infrastructure" (Postgres, OTel, Redis); validation runs against real on-disk SQLite at production-equivalent settings and uses the existing test corpus + this repo itself as the realistic input.

---

## Task 7.1: End-to-end run against this repo

**Files:** [no files modified — runtime validation only]

**Context:** This repository is the largest realistic input we have. Running the full `fit`, `graph`, and dashboard flows against it covers most code paths under realistic load.

**Steps:**

1. Clean state: `rm -rf opensip-tools/.runtime`.
2. Cold run:
   ```bash
   pnpm fit                                  # cold; populates file-cache + sessions
   pnpm graph                                # cold; populates catalog
   pnpm graph --gate-save                    # writes graph baseline
   pnpm fit --gate-save                      # writes fit baseline
   pnpm exec opensip-tools dashboard         # generates HTML report
   pnpm exec opensip-tools sessions list     # lists 3+ sessions
   ```
3. Warm run (second invocation):
   ```bash
   pnpm fit                                  # warm; fit_file_cache hits
   pnpm graph                                # warm; catalog cache hit
   ```
   Both warm runs should be measurably faster than cold. Record the times for the parity benchmark.
4. Invalidation check: edit a source file, re-run `pnpm graph`; observe partial rebuild driven by fingerprint mismatch (full rebuild is acceptable at parity — the perf follow-up makes it partial).
5. Database inspection:
   ```bash
   sqlite3 opensip-tools/.runtime/datastore.sqlite '.tables'
   sqlite3 opensip-tools/.runtime/datastore.sqlite '.schema'
   sqlite3 opensip-tools/.runtime/datastore.sqlite "SELECT name, sql FROM sqlite_master WHERE type='index';"
   ```
   Verify every expected table and index is present.
6. WAL files check:
   ```bash
   ls opensip-tools/.runtime/datastore.sqlite*
   ```
   Expect `datastore.sqlite`, `datastore.sqlite-wal`, `datastore.sqlite-shm` during operation; the WAL/SHM files may be empty or absent after clean shutdown depending on SQLite's WAL checkpoint timing — both states are acceptable.

**Verification:** All commands above complete without error. Warm runs are not slower than cold runs.

---

## Task 7.2: Multi-process safety (`--packages` runner)

**Files:** [no files modified — runtime validation only]

**Context:** `packages/graph/engine/src/cli/packages-runner.ts` spawns one child process per workspace package. Each child opens the SQLite DB. WAL mode permits concurrent readers + one writer; the implementation must not contend pathologically.

**Steps:**

1. Run `pnpm graph --packages` against this repo (17 packages — meaningful parallelism).
2. Observe no `database is locked` errors. WAL mode should handle this; if errors appear, the implementation has a write-contention bug worth investigating.
3. Run twice in a row; second run is warm.
4. Verify the catalog state in SQLite matches what a non-`--packages` run produces (modulo any documented cross-package edge resolution differences from `packages-runner.ts:18`).

**Verification:** No lock errors; warm second run; catalog content equivalent.

---

## Task 7.3: Cross-platform smoke (best-effort)

**Files:** [no files modified — runtime validation only]

**Context:** `better-sqlite3` ships prebuilt binaries for the common platforms. Smoke-test on at least the developer's platform; CI matrix exercises additional platforms in normal builds.

**Steps:**

1. On the developer's machine (Darwin per the environment): `pnpm install && pnpm build && pnpm test` — verify clean.
2. CI: confirm the build matrix runs against Linux x64, macOS x64+arm64, Windows x64 (whatever the existing matrix is — verify in `.github/workflows/`).
3. If install fails on any platform due to prebuilt-binary unavailability, document the workaround (likely `npm config set build-from-source true`) in the README upgrade section.

**Verification:** Builds clean on the developer's platform and in CI.

---

## Task 7.4: Uninstall round-trip

**Files:** [no files modified — runtime validation only]

**Context:** The CLAUDE.md "uninstall is precise" property — `rm ~/.opensip-tools/config.yml` and `rm -rf opensip-tools/.runtime/` removes all state — must continue to hold.

**Steps:**

1. From a clean state, install and run opensip-tools against a tmp project.
2. Observe state created: `~/.opensip-tools/config.yml` (if configured) and `<project>/opensip-tools/.runtime/datastore.sqlite` (plus WAL files).
3. Run `opensip-tools uninstall`.
4. Assert: no `~/.opensip-tools/` directory remains; no `<project>/opensip-tools/.runtime/` files remain.

**Verification:** Uninstall removes all SQLite files including WAL sidecars.

---

## Task 7.5: Release-smoke-test pass

**Files:** [no files modified — runtime validation only]

**Context:** `docs/release-smoke-test.md` is the canonical pre-publish checklist. After Phase 5 updated its `.runtime/` expectations to mention SQLite, this validation runs the full checklist.

**Steps:**

1. Walk through every step in `docs/release-smoke-test.md`.
2. Any step that mentions a JSON file under `.runtime/` should now refer to SQLite (Phase 5 Task 5.4 updated this).
3. Run the smoke-test commands; assert each expected outcome.

**Verification:** Every smoke-test step passes against the v2 release candidate.

---

## Phase 7 End-to-End Verification

After all tasks pass, the v2.0.0-rc.1 release is ready to publish. Document the validation results (parity benchmark numbers, any platform-specific notes) in the v2.0.0 CHANGELOG entry before publishing.

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
# (run validation tasks 7.1 through 7.5 above)
```

Expected state: v2.0.0 is shippable. Catalog perf work is the next plan (`docs/plans/graph-catalog-perf/`), scheduled for v2.1.0 or rolled into v2.0.0 depending on timing.
