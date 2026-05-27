# Phase 0: Audit & Design

**Goal:** Lock in the design of the dogfood loop (CI strategy, baseline strategy, output sinks) and supersede the candidates doc. No production code changes.
**Depends on:** —

This phase exists to make the design decisions explicit before any CI wiring or check porting begins. The output is documented decisions + a cleaned-up plans/ directory.

---

## Task 0.1: Run `pnpm fit` against current main and record the baseline state

**Files:**
- Modify: none (read-only audit)

**Context:** Before deciding whether the CI step should hard-fail on existing violations or accept a baseline, we need to know what violations currently exist. `pnpm fit` is wired (`package.json:11`) and the config (`opensip-tools.config.yml`) is present. No one has reported what it currently emits.

**Steps:**

1. From a clean working tree on `main`, run `pnpm build && pnpm fit`. Capture stdout to `/tmp/fit-baseline.txt`.
2. Capture the JSON form too: `pnpm fit --json > /tmp/fit-baseline.json`.
3. Categorize the violations: (a) genuine code-quality issues we should fix before the CI gate goes live, (b) false positives in the existing checks, (c) issues whose fix is non-trivial and warrants a baseline ratchet.
4. Record the result in this phase file's "Audit findings" section below — fill in the empty bullet list with actual numbers.

**Observability:** `fit` emits structured events via the core logger; the run produces a session under `opensip-tools/.runtime/sessions/<timestamp>-fit.json` per the runtime layout in CLAUDE.md. No new observability needed for this audit task.

**Wiring:** Read-only audit. No code or config changes. The recorded findings inform Task 0.2's CI-strategy decision.

**Error cases:** If `pnpm fit` errors before producing output (e.g., a check throws), capture the error message. This itself is a bug to file. Per the existing `analyze()` pattern in checks-typescript, parse errors are swallowed inside individual checks, so a top-level throw indicates a real engine bug.

**Verification:**
```bash
pnpm build && pnpm fit; echo "exit: $?"
pnpm fit --json | jq '.summary'
```

**Commit:** No commit — audit findings recorded in this phase file as part of plan revision.

### Audit findings (to be filled in)

- Total violations: TBD
- Severity breakdown (error / warning / info): TBD
- Per-check top offenders: TBD
- Recommended treatment per check: TBD (fix-before-CI vs. baseline-and-ratchet vs. disable-as-N/A)

---

## Task 0.2: Decide CI strategy, baseline strategy, and output sinks

**Files:**
- Modify: `docs/plans/ready/dogfood-fit-against-self/phase-0-audit-and-design.md` (this file)

**Context:** Three design decisions feed Phase 1. Make them explicit here so Phase 1 is purely execution.

Critical constraint discovered during plan-authoring research: opensip-tools' baseline system is **SQLite-resident and one-way**. `fit --gate-save` is a boolean flag (no path argument) that writes the current findings into `opensip-tools/.runtime/datastore.sqlite` (which is gitignored). `fit --gate-compare` compares against that same SQLite row. `fit-baseline-export --out <path>` exports the SQLite baseline to a SARIF file on disk for GH Code Scanning consumption — but there is **no corresponding import command**, so a committed SARIF baseline cannot be loaded into CI's ephemeral SQLite. This means a "git-tracked baseline + CI compares against it" workflow is **not implementable today** without adding the missing import direction to opensip-tools itself (out of scope for this plan).

**Steps:**

Decide the following and record the choice + rationale below.

1. **Ratchet mechanism.** Three options:
   - **(A) Fix-now hard gate.** Fix all current violations as part of this plan (or accept them via the existing `failOnErrors`/`disabledChecks` config in `opensip-tools.config.yml`). CI runs `pnpm fit` (no gate flags); `failOnErrors: 1` already in config makes the CI step fail on any error-level violation. Simplest if violation count is low.
   - **(B) GH Code Scanning ratchet.** CI runs `pnpm fit --gate-save` (saves baseline to ephemeral CI SQLite), then `pnpm fit-baseline-export --out fit.sarif`, then uploads SARIF to GitHub Code Scanning. GH tracks new-vs-existing across runs and surfaces only new alerts on PRs. Optional branch protection on "no new Code Scanning alerts" turns it into a hard gate. **Works with opensip-tools as-is.**
   - **(C) Defer ratchet until SARIF-import lands.** Add a `fit-baseline-import` command to opensip-tools as a follow-up plan first; only then can a committed SARIF baseline drive `--gate-compare` in CI. Push the dogfood-gate effort behind that infrastructure.

   **Recommended decision rule:** Run Task 0.1 first. If error-level violation count is <20 → **(A)**. Otherwise → **(B)**. Choose **(C)** only if both (A) is too noisy and (B)'s reliance on GitHub-side ratchet is unacceptable.

2. **SARIF upload.** Always upload via `github/codeql-action/upload-sarif@v3` regardless of which ratchet is chosen — SARIF in the GH Security tab provides inline PR annotations contributors will look at. The `fit-baseline-export --out <path>` command (verified at `packages/fitness/engine/src/cli/baseline-export.ts`) produces valid SARIF.

3. **`pnpm fit` flag set for CI.**
   - Decide between extending the existing `pnpm fit` script vs. adding `pnpm fit:ci` with CI-specific flags.
   - **Recommended:** add `pnpm fit:ci` as a separate script in `package.json`. Keeps the local-dev `pnpm fit` ergonomic (interactive output, no SARIF noise) while the CI script is unambiguous about what flags it uses.
   - For ratchet (B), the script would be: `pnpm fit:ci` = `node packages/cli/dist/index.js fit --gate-save` followed by a separate workflow step running `node packages/cli/dist/index.js fit-baseline-export --out fit.sarif`. These are two CLI commands, not one script.

**Observability:** N/A — decision-recording task.

**Wiring:** N/A. Decisions land in this phase file and are consumed by Phase 1.

**Error cases:** N/A.

**Verification:** None — this is documentation. Confirm the three decisions are written into the file below before marking the task done.

**Commit:** `docs(plans): dogfood-fit-against-self phase 0 design decisions`

### Decisions (to be filled in)

- Ratchet mechanism: **TBD** ((A) / (B) / (C)) — rationale: TBD
- SARIF upload: **TBD** — rationale: TBD
- CI script naming: **TBD** — rationale: TBD

---

## Task 0.3: Supersede the candidates doc

**Files:**
- Move: `docs/plans/dogfood-check-candidates.md` → `docs/plans/ready/dogfood-fit-against-self/references/candidates-original.md`

**Context:** The candidates doc was the input to this plan. It's now superseded — three of its five candidates turned out to be already-ported. Keeping the original at the plan's `references/` path preserves the historical analysis for anyone who wants to see what the gap looked like at the time of writing.

**Steps:**

1. `git mv docs/plans/dogfood-check-candidates.md docs/plans/ready/dogfood-fit-against-self/references/candidates-original.md`.
2. At the top of the moved file, add a short "Supersession note" callout pointing to this plan and noting that 3 of the 5 candidates were already ported by the time the new plan was authored.
3. Update the `dogfood-check-candidates.md` reference in `git log` history isn't a file change — but check if any other doc in `docs/` links to the old path. `grep -rn "dogfood-check-candidates" docs/` should return zero results after the move.

**Observability:** N/A.

**Wiring:** N/A.

**Error cases:** If any doc still links to the old path, update each link to point to the new `references/candidates-original.md` location.

**Verification:**
```bash
git mv docs/plans/dogfood-check-candidates.md docs/plans/ready/dogfood-fit-against-self/references/candidates-original.md
grep -rn "dogfood-check-candidates" docs/   # expect 0 results
```

**Commit:** `docs(plans): supersede dogfood-check-candidates with full plan`

---

## Task 0.4: Create `opensip-tools/fit/checks/` with explanatory README

**Files:**
- Create: `opensip-tools/fit/checks/README.md`

**Context:** Phases 2 and 3 both create `.mjs` files in `opensip-tools/fit/checks/`. The directory doesn't exist yet. More importantly: the directory has a **dual purpose** that future readers (and future checks) need to know about — project-local enforcement AND documentation-by-example for plugin authors. Establishing the README in Phase 0 sets the convention before any check files land.

**Steps:**

1. Create the directory: `mkdir -p opensip-tools/fit/checks`.
2. Write `opensip-tools/fit/checks/README.md` with this structure:

   ```markdown
   # Project-local fitness checks for opensip-tools

   This directory holds **project-local** fit checks that the
   opensip-tools repo uses to analyze itself. They are auto-discovered
   by the plugin loader (see `packages/core/src/plugins/discover.ts`)
   and run as part of every `pnpm fit` invocation against this repo.

   ## Dual purpose

   These checks serve two audiences:

   1. **Enforcement for this codebase.** Each check encodes a convention
      we care about — committed `it.only`, raw `console.log` in
      production, etc.
   2. **Documentation-by-example for plugin authors.** opensip-tools
      is open-source. Anyone evaluating it or learning to author their
      own checks can read these files top-to-bottom to see how
      `defineCheck` is actually used in practice. We deliberately
      author these checks to be **readable** — small files, lots of
      explanatory comments, no clever abstractions.

   ## Conventions for new project-local checks

   - **File shape:** ES modules with `.mjs` extension. The plugin
     loader auto-discovers `.js` and `.mjs` (not `.ts`).
   - **Required export:** `export const checks = [defineCheck({...})]`
     — see `packages/core/src/plugins/__tests__/discover.test.ts:68-104`
     for the contract.
   - **Imports:** `import { defineCheck, isTestFile, ... } from '@opensip-tools/fitness'`.
     Resolves via workspace linkage in this monorepo and via the
     published package in any other consumer.
   - **UUID:** every check needs a fresh `id` field — generate with
     `uuidgen`.
   - **Comments:** prioritize "why this shape" over "what this code
     does." A reader landing here is learning the pattern, not
     reviewing the implementation.
   - **Tests:** project-local checks don't get a per-file Vitest
     config. Coverage comes from the integration test at
     `packages/fitness/checks-typescript/src/__tests__/dogfood-integration.test.ts`.

   ## Promoting to first-party

   If a check here proves valuable to other opensip-tools consumers,
   promote it to `packages/fitness/checks-typescript/src/checks/`
   (as a `.ts` file with the full first-party machinery: barrel
   export, display entry, dedicated unit tests). The project-local
   version can stay as the worked example, with a header comment
   noting "see also packages/fitness/checks-typescript/... for the
   first-party version of this check."
   ```

3. Confirm `git check-ignore opensip-tools/fit/checks/README.md` returns empty (the `.gitignore` rule `opensip-tools/.runtime/` does not affect `opensip-tools/fit/`).

**Observability:** N/A — documentation file.

**Wiring:** This README is the convention surface. Future plans referencing this directory point here for the shape rules.

**Error cases:** N/A — file creation.

**Verification:**
```bash
ls opensip-tools/fit/checks/README.md
git check-ignore opensip-tools/fit/checks/README.md   # expect empty
```

**Commit:** `docs(fit): establish opensip-tools/fit/checks/ with README explaining its dual purpose`

---

## Phase 0 End-to-End Verification

After all four tasks:

1. `pnpm fit` baseline state is documented (Task 0.1's audit findings filled in).
2. Three design decisions are recorded (Task 0.2's decision list filled in).
3. Old candidates doc moved; no stale references remain.
4. `opensip-tools/fit/checks/README.md` exists, explaining the directory's dual purpose.

```bash
grep -rn "dogfood-check-candidates" docs/   # expect 0 results
ls docs/plans/ready/dogfood-fit-against-self/references/candidates-original.md   # expect exists
ls opensip-tools/fit/checks/README.md   # expect exists
```

Phase 0 is complete when Phases 1, 2, and 3 can all be started by reading this phase file's recorded decisions and the new README's conventions — no further judgment calls about CI shape, baseline strategy, or project-local check authoring shape.
