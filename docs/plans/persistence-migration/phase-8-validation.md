# Phase 8: Validation

**Goal:** Exercise the full integrated flow against real SQLite-on-disk. Confirm parity with v1 behavior on this repo and on a representative sample of consumer projects.
**Depends on:** All prior phases including Phase 7 (Tests).

This phase is a scaffold. opensip-tools does not have the OpenSIP backend's "lab infrastructure" (Postgres, OTel, Redis); validation runs against real on-disk SQLite at production-equivalent settings and uses the existing test corpus + this repo itself as the realistic input.

---

## Task 8.1: End-to-end run against this repo

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
3. Warm run (second invocation), **timed**:
   ```bash
   time pnpm fit                             # warm; fit_file_cache hits
   time pnpm graph                           # warm; catalog cache hit
   ```
   Both warm runs should be measurably faster than cold. **Record cold and warm wall-clock seconds for both fit and graph.**
4. **Parity benchmark — quantitative comparison against v1.** Compare v2 numbers to the v1 baseline captured before Phase 3 began (per Phase 3's pre-phase prerequisite). Apply these thresholds:
   - **v2 cold rebuild ≤ 1.5× v1 cold rebuild** — parity allows some overhead for the SQLite write path (whole-catalog replace, FK constraints, WAL journaling); a regression beyond 1.5× indicates a missing index, an unbatched insert, or a transaction-boundary issue worth investigating before merge.
   - **v2 warm load ≤ v1 warm load** — the load path is what `pipeline/indexes.ts` consumes; at parity it's still building in-memory maps from a `Catalog` value. SQLite's read shouldn't add overhead vs `JSON.parse`. If it does, the `loadFullCatalog()` join is likely missing an index.
   - **v2 dashboard generation ≤ 1.2× v1 dashboard generation** — the dashboard's view derivations still consume the legacy `Catalog`; only the load path changed.
   
   **If any threshold is exceeded, do not merge Phase 3.** Investigate the regression. The catalog-perf follow-up plan is for *additive* wins on top of parity; it cannot recover from a parity regression introduced here.
5. Database inspection:
   ```bash
   sqlite3 opensip-tools/.runtime/datastore.sqlite '.tables'
   sqlite3 opensip-tools/.runtime/datastore.sqlite '.schema'
   sqlite3 opensip-tools/.runtime/datastore.sqlite "SELECT name, sql FROM sqlite_master WHERE type='index';"
   ```
   Verify every expected table and index is present.
6. Invalidation check: edit a source file, re-run `pnpm graph`; observe partial rebuild driven by fingerprint mismatch (full rebuild is acceptable at parity — the perf follow-up makes it partial).
7. WAL files check:
   ```bash
   ls opensip-tools/.runtime/datastore.sqlite*
   ```
   Expect `datastore.sqlite`, `datastore.sqlite-wal`, `datastore.sqlite-shm` during operation; the WAL/SHM files may be empty or absent after clean shutdown depending on SQLite's WAL checkpoint timing — both states are acceptable.

**Verification:** All commands above complete without error. Cold/warm timing thresholds met against v1 baseline.

---

## Task 8.2: Multi-process safety (`--packages` runner)

**Files:** [no files modified — runtime validation only]

**Context:** `packages/graph/engine/src/cli/packages-runner.ts` spawns one child process per workspace package. Each child opens the SQLite DB. WAL mode permits concurrent readers + one writer; the implementation must not contend pathologically.

**Steps:**

1. Run `pnpm graph --packages` against this repo (17 packages — meaningful parallelism).
2. Observe no `database is locked` errors. WAL mode should handle this; if errors appear, the implementation has a write-contention bug worth investigating.
3. Run twice in a row; second run is warm.
4. Verify the catalog state in SQLite matches what a non-`--packages` run produces (modulo any documented cross-package edge resolution differences from `packages-runner.ts:18`).

**Verification:** No lock errors; warm second run; catalog content equivalent.

---

## Task 8.3: Cross-platform smoke (best-effort)

**Files:** [no files modified — runtime validation only]

**Context:** `better-sqlite3` ships prebuilt binaries for the common platforms. The native-module concern is real and worth verifying at PR time, not after release. Smoke-test on the developer's platform; CI matrix exercises additional platforms.

**Steps:**

1. On the developer's machine (Darwin per the environment): `pnpm install && pnpm build && pnpm test` — verify clean.
2. Inspect `.github/workflows/` to confirm the existing CI matrix covers, at minimum:
   - Linux glibc x64 (most common runner)
   - macOS x64 + macOS arm64
   - Windows x64
   
   These are the platforms with reliable better-sqlite3 prebuilts. If the matrix includes **Alpine Linux (musl)**, prebuilt binaries may not exist — confirm by inspecting `better-sqlite3`'s npm prebuilds page or by checking the install log on an Alpine runner. If Alpine is in the matrix and prebuilts don't cover it, either drop Alpine from the supported set or document the build-from-source fallback (`apt-get install python3 make g++` equivalent for Alpine) in the README.
3. If install fails on any platform due to prebuilt-binary unavailability, document the workaround in the README upgrade section. The fallback is `npm_config_build_from_source=true` (env var) — slower install but always works given a C++ toolchain.
4. Native-module reinstall: `rm -rf node_modules && pnpm install` on each platform; confirm clean install times are reasonable (target: under 60s on a warm cache; under 5min on a cold cache including better-sqlite3 prebuilt download).

**Verification:** Builds clean on the developer's platform and in CI.

---

## Task 8.4: Uninstall round-trip

**Files:** [no files modified — runtime validation only]

**Context:** The CLAUDE.md "uninstall is precise" property — `rm ~/.opensip-tools/config.yml` and `rm -rf opensip-tools/.runtime/` removes all state — must continue to hold.

**Steps:**

1. From a clean state, install and run opensip-tools against a tmp project.
2. Observe state created: `~/.opensip-tools/config.yml` (if configured) and `<project>/opensip-tools/.runtime/datastore.sqlite` (plus WAL files).
3. Run `opensip-tools uninstall`.
4. Assert: no `~/.opensip-tools/` directory remains; no `<project>/opensip-tools/.runtime/` files remain.

**Verification:** Uninstall removes all SQLite files including WAL sidecars.

---

## Task 8.5: Release-smoke-test pass

**Files:** [no files modified — runtime validation only]

**Context:** `docs/release-smoke-test.md` is the canonical pre-publish checklist. After Phase 5 updated its `.runtime/` expectations to mention SQLite, this validation runs the full checklist.

**Steps:**

1. Walk through every step in `docs/release-smoke-test.md`.
2. Any step that mentions a JSON file under `.runtime/` should now refer to SQLite (Phase 5 Task 5.4 updated this).
3. Run the smoke-test commands; assert each expected outcome.

**Verification:** Every smoke-test step passes against the v2 release candidate.

---

## Phase 8 End-to-End Verification

After all tasks pass, the v2.0.0-rc.1 release is ready to publish. Document the validation results (parity benchmark numbers, any platform-specific notes) in the v2.0.0 CHANGELOG entry before publishing.

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
# (run validation tasks 7.1 through 7.5 above)
```

Expected state: v2.0.0 is shippable. Catalog perf work is the next plan (`docs/plans/graph-catalog-perf/`), scheduled for v2.1.0 or rolled into v2.0.0 depending on timing.
