# Phase 1: CI Integration

**Goal:** Wire `pnpm fit` into CI on every PR with the ratchet mechanism chosen in Phase 0 (default: GH Code Scanning ratchet via SARIF upload).
**Depends on:** Phase 0 (specifically the ratchet-mechanism decision in Task 0.2)

This phase is one PR. It does not depend on Phases 2 or 3 — wiring fit against the *existing* check set is independently valuable and validates the loop before new checks land.

The task content below assumes ratchet **(B) GH Code Scanning** as the default — adjust per Phase 0's recorded decision if (A) Fix-now hard gate was chosen instead. (C) Defer would mean this phase doesn't run; the plan is paused until the prerequisite SARIF-import lands.

---

## Task 1.1: Add `pnpm fit:ci` script

**Files:**
- Modify: `package.json`

**Context:** Per Phase 0 Task 0.2 decision (3), the CI script is separate from local-dev `pnpm fit`. For ratchet (B), `fit:ci` is a multi-step bash sequence, not a single fit invocation. We could put it in a script file, but a one-line npm script chaining the two commands keeps everything in `package.json` and is what `pnpm` invocation conventions expect.

**Steps:**

1. In `package.json`, after line 11 (`"fit": "..."`) and before `"dashboard": ...`, add:

   ```json
   "fit:ci": "node packages/cli/dist/index.js fit --gate-save && node packages/cli/dist/index.js fit-baseline-export --out fit.sarif",
   ```

   - `fit --gate-save` runs the checks and writes findings into the (CI-ephemeral) SQLite store. Exit code follows the normal fit semantics (`failOnErrors: 1` in `opensip-tools.config.yml` means non-zero on any error-level finding).
   - `fit-baseline-export --out fit.sarif` reads the SQLite baseline and writes SARIF to disk. Exit 0 on success, 2 on no-baseline-exists (which can't happen here since `--gate-save` just wrote one).
   - The `&&` chain: if `fit` exits non-zero, `fit-baseline-export` never runs, and `fit.sarif` doesn't exist. The CI workflow handles this case (Task 1.2 uses `if: always()` so the upload step still runs — but the upload action fails on missing file, which is the failure mode we want).
   - **Alternative if you want SARIF even on a failed fit:** chain with `;` instead of `&&`, then check `fit.sarif` exists before upload. The `&&` form is recommended because a failed fit followed by partial SARIF can mislead reviewers; better to surface the fit failure directly.

   Wait — actually, on reflection: we DO want the SARIF uploaded even when fit fails, because the SARIF contains the findings that caused the failure. Use `;` chain so both commands run:

   ```json
   "fit:ci": "node packages/cli/dist/index.js fit --gate-save; node packages/cli/dist/index.js fit-baseline-export --out fit.sarif",
   ```

   The npm script exit code is the last command's exit code (fit-baseline-export, which should be 0 if `--gate-save` wrote a baseline). To preserve the fit failure as the CI step's exit, the workflow YAML must do the chaining itself rather than relying on `pnpm fit:ci`. **Move the multi-step logic out of package.json and into the workflow YAML** — clearer and the exit code is correct.

   **Revised approach:** keep `package.json` simple. Add only:

   ```json
   "fit:ci": "node packages/cli/dist/index.js fit --gate-save",
   ```

   The export step lives in the workflow YAML (Task 1.2). This makes the exit-code contract obvious: `pnpm fit:ci` exits non-zero iff fit found errors.

2. Verify the script runs locally: `pnpm build && pnpm fit:ci; echo "exit: $?"`. Expected exit code: 0 (clean tree) or 1 (existing error-level violations — surface and investigate).

**Observability:** `pnpm fit:ci` emits the same Pino structured events as `pnpm fit` plus the gate-save event (writing baseline into SQLite). Both are captured in `opensip-tools/.runtime/logs/<date>.jsonl` when running locally. In CI, the events stream to the Actions step log.

**Wiring:** This script is the CI entry point. The workflow YAML in Task 1.2 invokes it directly.

**Error cases:**
- `pnpm fit:ci` exits non-zero if fit finds error-level violations. CI step fails. **Intended.**
- If fit crashes before producing findings (engine bug), exit code is non-zero with a different error class. CI step still fails. The fitness engine's session log under `.runtime/sessions/` records the crash.
- The `--gate-save` SQLite write can fail (disk full, sqlite-busy). Rare in CI's clean fresh container. If it does, fit logs the error and exits non-zero.

**Verification:**
```bash
pnpm build && pnpm fit:ci; echo "exit: $?"
ls opensip-tools/.runtime/datastore.sqlite   # baseline now exists locally
```

**Commit:** `feat(scripts): add pnpm fit:ci for the dogfood CI gate`

---

## Task 1.2: Add CI workflow steps for fit + SARIF export + upload

**Files:**
- Modify: `.github/workflows/ci.yml`

**Context:** `.github/workflows/ci.yml:30-46` currently has four steps: build, typecheck, test, docs-check. The fit steps belong after `test` (a broken test suite blocks first — faster feedback) but before any release-style artifact step. We add:
1. The fit step (`pnpm fit:ci`) — produces the SQLite baseline.
2. SARIF export step — reads SQLite, writes `fit.sarif`. Runs with `if: always()` so a failed fit still produces SARIF for upload.
3. SARIF upload step — pushes to GH Code Scanning. Runs with `if: always()`.

We also add the workflow-level `permissions:` block needed for SARIF upload.

**Steps:**

1. At the top of `jobs.build-and-test:` (before `runs-on:` on line 11), add:

   ```yaml
   permissions:
     contents: read
     security-events: write
   ```

2. After the `Test` step (line 37, `run: pnpm test`) and before `Check web docs in sync` (line 45), add:

   ```yaml
       - name: Fit (dogfood)
         id: fit
         run: pnpm fit:ci

       - name: Export fit baseline to SARIF
         if: always() && steps.fit.outcome != 'skipped'
         run: node packages/cli/dist/index.js fit-baseline-export --out fit.sarif

       - name: Upload fit SARIF
         if: always() && hashFiles('fit.sarif') != ''
         uses: github/codeql-action/upload-sarif@v3
         with:
           sarif_file: fit.sarif
           category: opensip-tools-fit
   ```

   - `id: fit` so subsequent steps can reference its outcome.
   - `if: always() && steps.fit.outcome != 'skipped'` on the export step: run even when fit failed (we want the SARIF), but not if fit was skipped (e.g., a build failure earlier would have already killed the workflow).
   - `if: always() && hashFiles('fit.sarif') != ''` on the upload step: only upload if the SARIF file actually exists. Without this guard, a fit crash that prevents SARIF emission would cause a confusing "file not found" error in the upload action.

3. Confirm: no `continue-on-error: true` anywhere on the fit step. The step must fail loudly on fit failure — that's the CI gate. Per CLAUDE.md "No band-aid fixes", suppressing the failure to keep CI green is exactly the antipattern to avoid.

**Observability:**
- GH Actions captures stdout/stderr of every step. The fit step's structured Pino events and the violation summary are both visible in the step log.
- The uploaded SARIF is the durable artifact: visible in GH Security → Code scanning alerts. New alerts surface inline on PR diffs.

**Wiring:** This is the central wiring change for the plan. Data flow:

```
PR opened
  → ci.yml runs
    → checkout
    → install
    → build
    → typecheck
    → test
    → Fit (dogfood)  ── runs pnpm fit:ci ── writes SQLite baseline
                                          ── exits non-zero on errors
    → Export fit baseline to SARIF (always)
                                          ── reads SQLite, writes fit.sarif
    → Upload fit SARIF (always, if file exists)
                                          ── pushes to GH Code Scanning
    → Check web docs in sync
```

GH Code Scanning then:
- Compares the uploaded SARIF against the latest main-branch upload.
- Computes "new alerts" and "fixed alerts".
- Shows new alerts inline on the PR diff (file/line annotations) and aggregated under Security → Code scanning alerts.

**Error cases:**
- **Fit finds new errors:** `Fit (dogfood)` step fails. Subsequent export + upload still run because of `if: always()`. SARIF appears in Security tab; reviewers see what failed. This IS the intended failure mode of the gate.
- **Fit crashes before SARIF is written:** export step fails (no baseline in SQLite to export, exit code 2 per `baseline-export.ts:51-58`). Upload step skipped because `hashFiles('fit.sarif') != ''` is false. The fit failure remains the surfacing signal.
- **Export fails for any reason:** logged in the step output. Upload skipped. PR shows "Fit (dogfood)" passed or failed but no SARIF — diagnosable from the step log.
- **Upload fails (permissions / GH outage):** GitHub's upload-sarif action exits non-zero; the workflow run is marked failed. This is loud, not silent. No workaround in the YAML — fix at the source.

**Verification:**
```bash
# Locally simulate the CI sequence
pnpm build
pnpm fit:ci; echo "fit exit: $?"
node packages/cli/dist/index.js fit-baseline-export --out fit.sarif
jq '.runs[0].results | length' fit.sarif
# Should print a number — the count of findings in the SARIF.
```

After PR opens, watch the workflow run:
- Three new steps appear: "Fit (dogfood)", "Export fit baseline to SARIF", "Upload fit SARIF".
- If fit passes: all three green; SARIF appears in Security tab with full findings (no new alerts on PR if main is also clean).
- If fit fails: first step red; subsequent steps green (they ran with `if: always()`); SARIF in Security tab with new-alert annotations on the PR diff.

**Commit:** `ci: run pnpm fit on every PR with SARIF upload to Code Scanning`

---

## Task 1.3: Optional — branch protection on "no new Code Scanning alerts"

**Files:**
- Modify: none (GitHub repo settings, not files in the repo)

**Context:** With ratchet (B), the workflow step fails on **existing** error-level violations (because of `failOnErrors: 1`), but does NOT fail on net-new violations alone — that judgment belongs to GH Code Scanning, which surfaces them as new alerts. To turn the alerts into a true hard gate, configure a branch protection rule.

**Steps:**

This task is **optional** and not file-changing — the user (Shaun) makes the call. Document the decision in this phase file but do NOT make the change as part of the plan's automated work.

If chosen:
1. Repo Settings → Branches → Edit rule for `main`.
2. Under "Require status checks to pass before merging", add the Code Scanning check (it appears as a check option once the first CI run uploads SARIF).
3. Save.

If declined: GH Code Scanning alerts still appear inline on PRs but don't block merges. This is the lighter posture and may be appropriate if the team is still settling on which checks are noisy.

**Observability:** Branch protection settings are visible in repo Settings. PR merge attempts that fail the rule show "blocked" status.

**Wiring:** N/A — repo settings.

**Error cases:** N/A.

**Verification:** N/A — the user confirms the decision.

**Commit:** None (no file change).

---

## Task 1.4: Document the dogfood loop in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Context:** Future contributors will see `Fit (dogfood)` failing on their PR and need to know what to do.

**Steps:**

1. After the "Before Committing" section in `CLAUDE.md`, add:

   ```markdown
   ## Dogfood Gate

   CI runs `pnpm fit:ci` on every PR — opensip-tools analyzes itself.
   The step writes findings into the (CI-ephemeral) datastore and exits
   non-zero if any error-level violations are present (`failOnErrors: 1`
   in `opensip-tools.config.yml`).

   A separate workflow step exports the findings to SARIF
   (`fit-baseline-export --out fit.sarif`) and uploads to GitHub Code
   Scanning. GH compares against the latest main-branch SARIF and
   surfaces **new** alerts inline on PR diffs and under Security →
   Code scanning alerts.

   If the dogfood step fails on your PR, run `pnpm fit` locally to see
   the specific finding and the suggestion. Fix the violation in your
   PR. Updating the gate (e.g., via `disabledChecks` in
   `opensip-tools.config.yml`) requires PR-description justification
   and reviewer sign-off — it is not a default contributor option.
   ```

2. Verify no contradiction with existing CLAUDE.md text.

**Observability:** N/A — documentation change.

**Wiring:** Documentation wiring. Without it, contributors hitting a fit-gate failure don't know how to proceed.

**Error cases:** N/A.

**Verification:**
```bash
grep -n "Dogfood Gate" CLAUDE.md   # expect one match
```

**Commit:** `docs(claude): explain dogfood gate workflow for contributors`

---

## Phase 1 End-to-End Verification

After all four tasks land:

1. `package.json` has the `fit:ci` script.
2. `.github/workflows/ci.yml` has three new steps + permissions block.
3. CLAUDE.md documents the dogfood gate.
4. (Optional) Branch protection on Code Scanning alerts is configured per Task 1.3.

Open a test PR with a deliberate violation (e.g., a new `console.log` in production code — though this can't be tested directly until Phase 3's `no-console-log` ships; until then, use an existing-check violation like adding `any` if `no-any-types` is enabled). Confirm:

- CI fails on "Fit (dogfood)" step.
- SARIF still uploads (subsequent steps green because of `if: always()`).
- GH Security tab shows the new alert with the file/line annotation on the PR diff.

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm fit:ci
```

Revert the test PR. Confirm CI passes again.

Phase 1 is complete when (a) a fresh `main` checkout passes the full CI sequence and (b) a synthetic violation correctly fails the CI step on a test branch.
