# Phase 5: Verification

**Goal:** Confirm the full dogfood loop works in CI against an actual PR. Inspect each output sink (CI logs, SARIF, dashboard). Grep for silent error paths introduced by the plan.
**Depends on:** All prior phases

This phase is the final acceptance gate. It is intentionally manual — automated tests can verify code-level correctness, but only running against a real GitHub PR can verify the SARIF integration, the GH Security tab annotations, and the contributor experience when the gate fails.

---

## Task 5.1: Full local pre-CI check

**Files:**
- Modify: none (verification task)

**Context:** Before opening the validation PR, confirm everything passes locally.

**Steps:**

1. From a clean `main` checkout, run:
   ```bash
   pnpm install
   pnpm build && pnpm typecheck && pnpm test && pnpm lint
   pnpm fit:ci
   ```

2. Expect: all commands exit 0. The `pnpm fit:ci` exit code is 0 because the baseline (committed in Phase 1 Task 1.1) accepts whatever violations existed when it was generated.

3. If any command fails on `main`, that's a bug introduced by the plan — investigate root cause before opening the validation PR. Do NOT use `--force` flags or `--no-verify` to push past it.

**Observability:** Run output is the observation surface. Note exit codes.

**Wiring:** N/A.

**Error cases:** Any non-zero exit is the failure to investigate. No silent fallback.

**Verification:** All commands exit 0.

**Commit:** None.

---

## Task 5.2: Validation PR — gate works on a synthetic violation

**Files:**
- Modify: any one production source file with a deliberate violation (revert at the end of the task)

**Context:** Open a PR with a synthetic violation to confirm the gate actually fails when it should.

**Steps:**

1. Create a branch `validate-dogfood-gate`.
2. Pick a violation type:
   - **For `no-focused-tests`:** add `it.only(...)` to any existing test file (e.g., a one-line addition inside an existing `describe`).
   - **For `no-console-log`:** add `console.log('test')` to a non-allowlisted production file (e.g., a function body in `packages/core/src/`).
3. Commit + push.
4. Open a PR. Wait for CI.

**Expected behavior:**

- The `Build`, `Typecheck`, `Test` steps pass.
- The `Fit (dogfood)` step **fails** with exit code != 0.
- The step log shows the specific new violation: file, line, message, suggestion.
- The `Upload fit SARIF` step still runs (because of `if: always()` from Phase 1 Task 1.2) and uploads the SARIF.
- The GitHub Security tab shows the violation as a new Code Scanning alert.
- The PR diff shows an inline annotation on the violating line.

**Observability:** GH Actions step logs + GH Security tab + PR diff annotations are the three observation surfaces. All three must show the violation.

**Wiring:** This task verifies the wiring chain end-to-end: source file → check → engine → SARIF emitter → upload action → GH Security tab.

**Error cases:**
- If the step does NOT fail, the gate is broken. Investigate: is `--gate-compare` reading the baseline? Is the baseline path correct? Is `failOnErrors` set correctly in `opensip-tools.config.yml`?
- If the SARIF upload fails, investigate permissions (`security-events: write` was added in Phase 1 Task 1.2) and the SARIF file's validity (`jq '.' fit.sarif` should parse).
- If the violation appears in the step log but NOT in the Security tab, the SARIF format may be invalid — file as a fitness-engine bug; don't suppress the SARIF upload as a workaround.

**Verification:**
- CI fails on `Fit (dogfood)`. Confirmed via the workflow run page.
- SARIF uploads. Confirmed via Security → Code scanning alerts.
- PR shows inline annotation on the violating line. Confirmed in the PR diff view.

**Commit:** None on `main`. Push to the validation branch only.

---

## Task 5.3: Validation PR — gate passes when violation is reverted

**Files:**
- Modify: revert the file modified in Task 5.2

**Steps:**

1. On the same `validate-dogfood-gate` branch, revert the synthetic violation.
2. Push.
3. CI should re-run and the `Fit (dogfood)` step should pass.

**Observability:** Same as 5.2.

**Wiring:** Same.

**Error cases:** If the gate still fails after revert, the baseline may not match the actual main-branch state. Re-run `pnpm fit --gate-save opensip-tools/fit/baseline.json` locally and commit the regenerated baseline (with PR description explaining the regeneration).

**Verification:** CI passes after the revert.

**Commit:** None on `main`. The validation branch is throwaway.

---

## Task 5.4: Silent-failure grep

**Files:**
- Modify: none (verification task)

**Context:** Per CLAUDE.md ("No band-aid fixes") and per the silent-failure-hunter agent's rubric, this plan should not introduce empty catch blocks, swallowed errors, or `continue` patterns that drop work. Grep for them.

**Steps:**

1. Run:
   ```bash
   # Find empty catches in code touched by this plan
   grep -rn "catch {}" packages/fitness/checks-typescript/src/checks/{testing,quality}/
   grep -rn "catch (_)" packages/fitness/checks-typescript/src/checks/{testing,quality}/
   grep -rn "catch (e) {}" packages/fitness/checks-typescript/src/checks/{testing,quality}/

   # Find continue-on-error in CI workflow
   grep -n "continue-on-error" .github/workflows/ci.yml
   ```

2. Expected: zero hits. If any hit appears, evaluate:
   - Empty catches around `stripStringsAndComments` are allowed IF marked with the existing `@swallow-ok` convention (see `incomplete-regex-escaping.ts:219` for the canonical comment shape).
   - `continue-on-error: true` in CI is NOT allowed for the `Fit (dogfood)` step — would make the gate non-functional.

**Observability:** Grep output is the observation surface.

**Wiring:** N/A.

**Error cases:** Each unexpected hit is a finding to triage before declaring the plan done.

**Verification:** Grep returns no unexpected results.

**Commit:** None.

---

## Task 5.5: Dashboard renders the new checks

**Files:**
- Modify: none

**Context:** The dashboard package renders checks by display entry. New checks added in Phases 2 and 3 should appear with their pretty names and icons.

**Steps:**

1. After Phase 1's baseline is committed and Phases 2/3 are merged, run locally:
   ```bash
   pnpm fit && pnpm dashboard
   ```
2. The dashboard generator (`packages/dashboard/`) writes HTML to `opensip-tools/.runtime/reports/latest.html`. Open in a browser.
3. Confirm:
   - `No Focused Tests` appears in the check list with its 🎯 (or chosen) icon.
   - `No Console Log` appears with its 📝 (or chosen) icon.
   - Both render under their categories (Testing and Quality respectively).
   - If either check produced violations in the run, they appear under the appropriate file/line in the dashboard's per-file view.

**Observability:** Browser is the observation surface.

**Wiring:** Dashboard reads from the most recent session under `opensip-tools/.runtime/sessions/`. The session is written by `pnpm fit`. After the new checks land, sessions include their results.

**Error cases:**
- If a new check appears with a kebab-case name instead of the pretty name, the display entry didn't land. Re-verify Phase 2 Task 2.3 and Phase 3 Task 3.4.
- If a new check doesn't appear at all, the barrel wiring didn't land. Re-verify Phase 2 Task 2.2 and Phase 3 Task 3.3.

**Verification:** Dashboard shows the new checks with pretty names.

**Commit:** None.

---

## Phase 5 End-to-End Verification

The plan is complete when:

1. ✅ `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm fit:ci` exits 0 on `main`.
2. ✅ A synthetic violation on a feature branch causes CI to fail on the `Fit (dogfood)` step and produces an inline PR annotation via SARIF upload to GH Security.
3. ✅ Reverting the synthetic violation makes CI pass again.
4. ✅ Silent-failure grep returns no unexpected hits.
5. ✅ Dashboard renders both new checks with their pretty names and icons.

Once all five hold, close the plan: move `docs/plans/ready/dogfood-fit-against-self/` to `docs/plans/completed/<date>-dogfood-fit-against-self/` per project plan-lifecycle convention (if one exists), or simply note completion in the plan directory's `plan.md` with the date.
