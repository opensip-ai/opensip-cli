# Phase 8: Validation

**Goal:** Exercise the full integrated flow end-to-end. Confirm a customer can scaffold a fresh project, install, and run `opensip-tools fit` / `opensip-tools sim` against marker-discovered packs.

**Depends on:** All prior phases including Tests.

**Note on validation infrastructure:** opensip-tools is a CLI plus a Turborepo monorepo of TypeScript packages. It does not have Postgres / OTel / Redis dependencies. Validation runs Vitest plus manual smoke tests against a scratch project. The skill's "validate against lab infrastructure at port 5433" guidance does not apply here.

---

## Task 8.1: Add an end-to-end test for marker discovery against a real fixture project

**Files:** [size: M]
- Create: `packages/cli/src/__tests__/e2e-marker-discovery.test.ts`
- Create: `packages/cli/src/__tests__/fixtures/e2e-marker-project/` (a complete scratch project with workspace globs, scaffolded fit and sim packs, both with checks and recipes)

**Context:** A black-box test that:
1. Spawns the actual CLI binary (`bin/opensip-tools`) via Node's `spawn` or `execFile`.
2. Points it at the fixture project.
3. Runs `fit-list` and asserts the fixture pack's checks appear.
4. Runs `fit --recipe <fixture-recipe>` and asserts the recipe executes.
5. Runs `sim --scenario <fixture-scenario>` and asserts the scenario executes.
6. Runs `sim --recipe <fixture-recipe>` similarly.

This is the only test in the workspace that exercises the marker walker end-to-end (versus integration tests that import functions directly). It catches packaging issues — the marker walker reads `package.json` from disk, and if the fixture's `package.json` shape doesn't match what the walker expects, the test catches that.

**Steps:**

1. Build the fixture project structure:
   ```
   fixtures/e2e-marker-project/
     package.json (with workspaces: ['opensip-tools/*'])
     pnpm-workspace.yaml (mirrors)
     opensip-tools.config.yml (minimal targets config)
     opensip-tools/
       fit/
         package.json (with opensipTools.kind: "fit-pack")
         dist/
           index.js (pre-built, exports checks + recipes)
       sim/
         package.json (with opensipTools.kind: "sim-pack")
         dist/
           index.js (exports scenarios + recipes)
     node_modules/
       @your-scope/fit -> ../opensip-tools/fit (symlink)
       @your-scope/sim -> ../opensip-tools/sim (symlink)
   ```
   The `dist/index.js` files are pre-built JS (not TS) since the test spawns a real Node process. The fixture's `package.json` `main` points at `dist/index.js`.

2. The test setUp creates the fixture in `os.tmpdir()` via copy (since symlinks need real paths). Teardown cleans up.

3. Run each CLI command via `spawn` and assert on stdout / exit code.

4. Assert the log events fire correctly (e.g. parse the `.runtime/logs/<date>.jsonl` file and look for `cli.check_package.loaded` with `recipesRegistered > 0`).

**Verification:** `pnpm --filter=@opensip-tools/cli test src/__tests__/e2e-marker-discovery.test.ts`

**Commit:** `test(cli): e2e marker-discovery against scratch project fixture`

---

## Task 8.2: Manual smoke — fresh init + install + fit/sim run

**Files:** [size: S — manual test, no code changes]
- (run by the implementer; results recorded in PR description)

**Context:** A hand-run that exercises the customer-side flow exactly as a new customer would. Cannot be automated to the same fidelity as the e2e test because it touches `pnpm install` (network).

**Steps:**

1. `mkdir /tmp/sip-smoke && cd /tmp/sip-smoke && pnpm init -y`
2. Make sure the local CLI build is current: `pnpm --filter=@opensip-tools/cli build`
3. Run init: `node <path-to-cli>/dist/index.js init`
4. Verify scaffolded layout:
   - `opensip-tools/fit/{package.json, tsconfig.json, vitest.config.ts, index.ts, checks/example-check.ts, recipes/example-recipe.ts, README.md}` all exist
   - `opensip-tools/sim/{package.json, tsconfig.json, vitest.config.ts, index.ts, scenarios/example-scenario.ts, recipes/example-recipe.ts, README.md}` all exist
   - `opensip-tools/fit/package.json` has `"opensipTools": { "kind": "fit-pack" }`
   - `opensip-tools/sim/package.json` has `"opensipTools": { "kind": "sim-pack" }`
   - `pnpm-workspace.yaml` (or `package.json#workspaces`) includes `opensip-tools/*`
   - `.gitignore` includes `opensip-tools/.runtime/`, `opensip-tools/fit/dist/`, `opensip-tools/sim/dist/`
5. `pnpm install` — should succeed and symlink the fit + sim packs into `node_modules/@your-scope/`. If the customer never renamed the placeholder, the symlinks land under `@your-scope/`; verify discovery still works (the marker is what matters, not the scope).
6. `node <path-to-cli>/dist/index.js fit-list` — example check appears.
7. `node <path-to-cli>/dist/index.js fit --recipe example` — runs to completion.
8. `node <path-to-cli>/dist/index.js sim --scenario example` — runs to completion.
9. `node <path-to-cli>/dist/index.js sim --recipe example` — runs to completion.
10. Inspect `opensip-tools/.runtime/logs/<date>.jsonl` — confirm `cli.check_package.loaded` and `cli.scenario_package.loaded` events fired with `recipesRegistered: > 0`.

Record the output (or screenshot) in the PR description.

**Verification:** Manual.

**Commit:** No code commit; document the smoke result in the PR.

---

## Task 8.3: Regression check — legacy customer flows still work

**Files:** [size: S — manual]
- (run by the implementer)

**Context:** A second hand-run that validates backwards-compat for the legacy paths. The skill's "no backwards compat" default doesn't apply here (confirmed in Step 0) — we explicitly want to verify the old paths keep working.

**Steps:**

1. **Name-pattern path.** In a separate scratch project, manually create a pack under `node_modules/@opensip-tools/checks-legacy/` exporting `checks` + `recipes`. Confirm `opensip-tools fit` discovers it via the existing scope scan, registers both checks and recipes (the recipe loading is new in this PR — legacy packs benefit).

2. **`packageScopes` path.** Same scratch project, write `plugins.packageScopes: ['@acme']` in `opensip-tools.config.yml`. Create a pack at `node_modules/@acme/checks-legacy/` (no marker). Confirm `opensip-tools fit` discovers it.

3. **Explicit listing path.** Write `plugins.checkPackages: ['@anything/whatever']` and a pack at that path (no marker, non-conforming name). Confirm `opensip-tools fit` discovers it.

4. **Marker path with non-`@opensip-tools` scope.** Write a pack at `node_modules/@anything/anything-fit-pack/` with `"opensipTools": { "kind": "fit-pack" }`. No config entry needed. Confirm `opensip-tools fit` discovers it.

All four paths should register checks AND recipes (the recipe-loading fix is universal).

**Verification:** Manual.

**Commit:** No code commit; document results in the PR.

---

## Phase 8 End-to-End Verification

- `pnpm test` — entire workspace green, including the new e2e test.
- `pnpm lint` — 0 errors.
- Manual smoke tests 8.2 and 8.3 both pass; results in PR description.
- Performance smoke: `time opensip-tools fit-list` on the scratch project completes in < 2 seconds (marker walk adds one ancestor traversal per discovery call; should be negligible).

> **Deferred:** Customer-facing release notes — CHANGELOG entries land in Phase 6.3; this phase confirms they describe shipped behavior. Human review pass on the CHANGELOG copy before merge.
