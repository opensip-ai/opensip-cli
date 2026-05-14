# Phase 9: Validation

**Goal:** Exercise the full integrated flow against a realistic multi-language fixture repo through the actual CLI binary (not just the test harness). Verify per-language dispatch, the lang plugin domain loading, fail-loud error messages, and that the existing TS-only opensip-tools run is unchanged.
**Depends on:** All prior phases.

This phase runs `opensip-tools fit` end-to-end against on-disk fixtures via the bin defined in `packages/cli/package.json` (`opensip-tools` -> `./dist/index.js`). No mocks. The validation phase is the only place where the actual shipped binary is exercised against a multi-language project.

---

## Task 9.1: Build the multi-language fixture repo

**Files:** [size: M]
- Create: `packages/cli/__fixtures__/multi-lang/opensip-tools.config.yml`
- Create: `packages/cli/__fixtures__/multi-lang/sample.ts` (if not yet present from Phase 3)
- Verify: existing fixtures from Phases 3, 5, 6 (`sample.rs`, `sample.py`, `Sample.java`, `sample.go`, `sample.cpp`)
- Create: `packages/cli/__fixtures__/multi-lang/.opensip-tools/lang/package.json` declaring all six language packs as deps
- Create: `packages/cli/__fixtures__/multi-lang/.opensip-tools/fit/package.json` declaring the six check packs as deps

**Context:** The fixture is a self-contained mini-project. Its `opensip-tools.config.yml` declares one target per language. Its `.opensip-tools/lang/` directory has a `package.json` listing the six lang packs as dependencies (the discovery system from Phase 1 Task 1.3 reads this to know which packs to load). Same for `.opensip-tools/fit/`.

**Steps:**

1. `opensip-tools-config.yml`:
   ```yaml
   targets:
     typescript-sources:
       description: TS sources
       languages: [typescript]
       concerns: [backend]
       include: ["**/*.ts"]
     rust-sources:
       description: Rust sources
       languages: [rust]
       concerns: [backend]
       include: ["**/*.rs"]
     python-sources:
       description: Python sources
       languages: [python]
       concerns: [backend]
       include: ["**/*.py"]
     java-sources:
       description: Java sources
       languages: [java]
       concerns: [backend]
       include: ["**/*.java"]
     go-sources:
       description: Go sources
       languages: [go]
       concerns: [backend]
       include: ["**/*.go"]
     cpp-sources:
       description: C++ sources
       languages: [cpp]
       concerns: [backend]
       include: ["**/*.cpp", "**/*.hpp"]

   plugins:
     lang:
       - "@opensip-tools/lang-typescript"
       - "@opensip-tools/lang-rust"
       - "@opensip-tools/lang-python"
       - "@opensip-tools/lang-java"
       - "@opensip-tools/lang-go"
       - "@opensip-tools/lang-cpp"
     fit:
       - "@opensip-tools/checks-rust"
       - "@opensip-tools/checks-python"
       - "@opensip-tools/checks-java"
       - "@opensip-tools/checks-go"
       - "@opensip-tools/checks-cpp"
       - "@opensip-tools/checks-universal"
   ```
2. `sample.ts` — a TS file with a known-violating line (e.g. one `console.log` if no-console-log is in checks-builtin) just so the TS scope dispatch is also exercised.
3. The `.opensip-tools/lang/package.json` and `.opensip-tools/fit/package.json` reference the workspace packages via `"workspace:*"` so the fixture is reproducible from `pnpm install` at the repo root.

**Verification:**
```bash
pnpm install
ls -la packages/cli/__fixtures__/multi-lang/
```

**Commit:** `test(fixtures): multi-language fixture repo for validation`

---

## Task 9.2: Smoke run via the actual CLI binary

**Files:** [size: S]
- Create: `packages/cli/src/__tests__/multi-lang-cli-smoke.test.ts`

**Context:** Spawn the built `dist/index.js` as a child process (the actual bin path), point it at the fixture dir, capture stdout, assert the report contains the expected per-language proof violations. This is different from the integration test in Phase 8: that one calls the pipeline functions directly; this one shells out.

Uses `execFile` (NOT `exec`) per the repo's `execFileNoThrow.ts` utility convention.

**Steps:**

1. Test imports `execFile` from `node:child_process` (or a project utility if one exists).
2. `beforeAll`: build the workspace, set `cwd` to the fixture dir.
3. Run `node <repo>/packages/cli/dist/index.js fit` from the fixture dir.
4. Assert stdout includes:
   - `rust-no-unwrap` (twice — from `sample.rs`)
   - `python-no-bare-except` (once — from `sample.py`)
   - `java-no-system-out-println` (once — from `Sample.java`)
   - `go-no-fmt-println` (once — from `sample.go`)
   - either `cpp-clang-tidy` (if clang-tidy installed) or an error referencing it (gracefully)
5. Assert exit code is the expected one for a run with violations (likely non-zero — verify by checking what `pnpm fit` does today on the existing repo).

**Verification:**
```bash
pnpm build && pnpm --filter=@opensip-tools/cli test multi-lang-cli-smoke
```

**Commit:** `test(cli): smoke-run multi-language fitness through the shipped binary`

---

## Task 9.3: Verify existing single-language run is unchanged

**Files:** [size: XS]
- Create: `docs/plans/multi-language-support/validation-checklist.md`

**Context:** This plan's whole strangler premise — that existing TS-only opensip-tools usage is unchanged — must be verified end to end against the opensip-tools repo itself. Capture the report on `main` before any Phase 0 work begins, save it as `baseline.txt`, and after Phase 9 confirm the diff is empty.

**Steps:**

1. Document the procedure in `validation-checklist.md`:
   ```markdown
   # Validation Checklist

   ## Pre-flight (do BEFORE Phase 0 starts)
   ```bash
   git checkout main
   pnpm install && pnpm build
   pnpm fit > /tmp/opensip-tools-baseline.txt 2>&1
   cp /tmp/opensip-tools-baseline.txt docs/plans/multi-language-support/baseline.txt
   ```

   ## Per-phase regression gate
   At the end of each phase:
   ```bash
   pnpm build && pnpm fit > /tmp/opensip-tools-current.txt 2>&1
   diff docs/plans/multi-language-support/baseline.txt /tmp/opensip-tools-current.txt
   ```
   Empty diff is required to advance to the next phase. Any drift means a TS check is behaving differently and must be fixed before moving on.

   ## Phase 9 end-to-end gate
   - Empty diff against baseline.txt
   - Multi-language CLI smoke test (Task 9.2) passes
   - `pnpm test` passes across all packages
   - Manual smoke: `cd packages/cli/__fixtures__/multi-lang && opensip-tools fit` produces the expected report
   - Manual smoke: removing the `plugins.lang` block from the fixture's config causes a clear "no adapter registered for language X" error from Phase 8 Task 8.2's validator
   ```

**Verification:**

Read the checklist; confirm it captures the essential gates without ambiguity.

**Commit:** `docs(plans): validation checklist for multi-language support`

---

## Phase 9 End-to-End Verification

Final, exhaustive verification before declaring the plan done:

```bash
# 1. Build & test everything
pnpm build && pnpm typecheck && pnpm test

# 2. Regression diff against the captured baseline
pnpm fit > /tmp/final.txt 2>&1
diff docs/plans/multi-language-support/baseline.txt /tmp/final.txt
# Expected: empty

# 3. Multi-language fixture smoke
cd packages/cli/__fixtures__/multi-lang
node ../../packages/cli/dist/index.js fit

# 4. Negative path — remove a lang declaration and verify fail-loud
mv opensip-tools.config.yml opensip-tools.config.yml.bak
sed '/lang-rust/d' opensip-tools.config.yml.bak > opensip-tools.config.yml
node ../../../packages/cli/dist/index.js fit
# Expected: error message "Target rust-sources declares language rust but no adapter is registered"
mv opensip-tools.config.yml.bak opensip-tools.config.yml
```

If all four gates pass, the plan is complete. Any failure means a phase shipped a regression and that phase's verification gate was insufficient — surface that, fix the gate retroactively, and re-run.
