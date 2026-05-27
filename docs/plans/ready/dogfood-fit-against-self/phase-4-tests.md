# Phase 4: Tests

**Goal:** Cross-phase integration test that exercises both new project-local checks end-to-end. Both checks live in `opensip-tools/fit/checks/` and are auto-discovered by the plugin loader; the test verifies discovery + violation detection + scoping for each.
**Depends on:** Phase 2, Phase 3

Per the conventions in `opensip-tools/fit/checks/README.md` (Phase 0 Task 0.4), project-local checks do NOT get per-file Vitest configs. All test coverage for `no-focused-tests` and `no-console-log` lives in this single integration test.

---

## Task 4.1: Integration test for the new checks via the fitness engine

**Files:**
- Create: `packages/fitness/checks-typescript/src/__tests__/dogfood-integration.test.ts`

**Context:** Unit tests verify each `analyze()` in isolation. They don't verify that the engine actually picks up the new check from the registry, applies file scoping correctly, or interacts with the baseline. The risk of skipping this: a check could be perfectly correct in isolation but invisible to `pnpm fit` because of a barrel-wiring or display-registration mistake.

**Pattern reference:** Look for existing integration tests in `packages/fitness/engine/src/__tests__/` or `packages/cli/src/__tests__/` (especially `e2e-discovery.test.ts` — verified at `packages/cli/src/__tests__/e2e-discovery.test.ts:18,31` it spawns the CLI binary). The pattern to follow: spawn the built CLI in a child process against a fixture directory, then assert on the output.

If `e2e-discovery.test.ts` is too heavy as a template (full child-process pattern), use the lighter pattern: import the registry directly and call its run methods in-process.

**Test helpers:** `vitest` mkdtempSync from `node:fs` + `os.tmpdir()` for fixture directories (mirrors `e2e-discovery.test.ts:54`).

**Steps:**

1. Create `packages/fitness/checks-typescript/src/__tests__/dogfood-integration.test.ts`.
2. Test cases (~9 cases — both checks tested via direct `.mjs` import + discovery-loader assertion):

   **Discovery (both checks):**

   a. **Both checks are discoverable via the project-local plugin loader.** Invoke the discovery API from `@opensip-tools/core/plugins` on the workspace's `opensip-tools/fit/checks/` directory. Assert the discovered set contains entries with slugs `no-focused-tests` and `no-console-log`. This confirms the auto-discovery wiring works end-to-end.

   **`no-focused-tests` (Phase 2 check):**

   b. **Fires on `it.only` in a `.test.ts` file.** Import `analyzeNoFocusedTests` from `opensip-tools/fit/checks/no-focused-tests.mjs`. Call against fixture content `it.only('x', () => {})` with file path `foo.test.ts`. Assert one violation, line 1, message contains "it.only(".

   c. **Fires on each of the 5 focus patterns.** Parameterized test: for each of `describe.only`, `it.only`, `test.only`, `fit(`, `fdescribe(` → exactly one violation.

   d. **Does NOT fire on non-test files.** Same `.only` content but file path `foo.ts` → 0 violations.

   e. **Does NOT fire on patterns in comments or strings.** `// it.only(...)` or `const s = 'it.only('` in a `.test.ts` file → 0 violations (verifies `stripStringsAndComments` works).

   f. **Respects the file-ignore directive.** File starting with `// @fitness-ignore-file no-focused-tests` → 0 violations regardless of `.only` patterns below.

   **`no-console-log` (Phase 3 check):**

   g. **Fires on each console method.** Parameterized: `console.log`, `.error`, `.warn`, `.info`, `.debug` in `packages/cli/src/foo.ts` → 1 violation each with the CLI-routed suggestion.

   h. **Does NOT fire on allowlisted paths.** Same content but file path is one of the allowlist segments (e.g., `packages/core/src/lib/logger.ts` or anything under `packages/cli-ui/src/`) → 0 violations.

   i. **Does NOT fire on test files.** Same content but path is `foo.test.ts` → 0 violations (the check's `isTestFile` guard).

3. Target: 9 test cases (1 discovery + 5 for `no-focused-tests` + 3 for `no-console-log`).

**Observability:** Integration tests run silently on success. If a test fails, Vitest prints the assertion diff. No log output verification needed in this test (the unit tests already cover that violation messages contain the expected text).

**Wiring:** This test verifies wiring. It is itself wired into `pnpm test` via Vitest's default include pattern (`**/*.test.ts`).

**Error cases:**
- If a fixture file can't be written (disk full, permission denied), `mkdtempSync` / `writeFileSync` throw and Vitest reports a failed test. Acceptable failure mode.
- If the in-process engine API isn't exported usefully (the engine assumes CLI ownership of session creation), fall back to the child-process pattern from `e2e-discovery.test.ts`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-typescript test dogfood-integration
```

**Commit:** `test(checks-typescript): integration test for dogfood checks`

---

## Phase 4 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test
```

The full test suite must pass — including the new integration test and all per-check unit tests from Phases 2 and 3.

Phase 4 is complete when the integration test passes and the existing test suite is unaffected.
