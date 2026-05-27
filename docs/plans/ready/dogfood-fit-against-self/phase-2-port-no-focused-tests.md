# Phase 2: Port `no-focused-tests` as a project-local check

**Goal:** Add `opensip-tools/fit/checks/no-focused-tests.mjs` — a project-local check that flags `describe.only`, `it.only`, `test.only`, `fit(`, `fdescribe(` in test files. Auto-discovered by the plugin loader. Independent PR; does not depend on Phase 1 or Phase 3.
**Depends on:** Phase 0 (especially Task 0.4's README which sets the conventions every check in this dir follows)

The check pattern is universal (every Vitest/Jest/Jasmine project wants it), but per the plan's framing we deliberately land it as project-local — it becomes the **first worked example** of `defineCheck` in this repo's source tree, and dogfoods opensip-tools against itself at the same time.

**Authoring constraint:** project-local checks are `.mjs` (or `.js`) — see `packages/core/src/plugins/discover.ts:266`. The source check we're porting is TypeScript (`~/Documents/Code/opensip-ai/opensip/opensip-tools/fit/checks/testing/no-focused-tests.ts`, 102 lines); we rewrite as `.mjs` per the conventions in `opensip-tools/fit/checks/README.md`.

---

## Task 2.1: Write the project-local check

**Files:**
- Create: `opensip-tools/fit/checks/no-focused-tests.mjs`

**Context:** Source at `~/Documents/Code/opensip-ai/opensip/opensip-tools/fit/checks/testing/no-focused-tests.ts`. Pure regex over per-line content after masking comments/strings. The source's helpers (`maskCommentsLines`, inline `isTestFile`) become imports from `@opensip-tools/fitness` in our port.

**Steps:**

1. Read the source file.
2. Create `opensip-tools/fit/checks/no-focused-tests.mjs`:

   ```javascript
   // opensip-tools/fit/checks/no-focused-tests.mjs
   //
   // Project-local: flags committed focused-test patterns
   // (describe.only, it.only, test.only, fit(, fdescribe() in test
   // files. A focused test silently skips every other test in the
   // file when CI runs, masking regressions.
   //
   // This check is one of the worked examples in opensip-tools/fit/checks/
   // — see ./README.md for the directory's conventions. The same
   // pattern works for any TypeScript/JavaScript project using
   // Vitest, Jest, or Jasmine.

   import { defineCheck, isTestFile, stripStringsAndComments } from '@opensip-tools/fitness'

   const CHECK_ID = '<fresh-uuid>'  // run uuidgen

   // Each form's display string + the regex that detects it.
   // Whitespace-tolerant: matches `it . only (`, `describe.only(`, etc.
   const FOCUS_PATTERNS = [
     { form: 'describe.only(', pattern: /\bdescribe\s*\.\s*only\s*\(/g },
     { form: 'it.only(',       pattern: /\bit\s*\.\s*only\s*\(/g },
     { form: 'test.only(',     pattern: /\btest\s*\.\s*only\s*\(/g },
     { form: 'fit(',           pattern: /\bfit\s*\(/g },
     { form: 'fdescribe(',     pattern: /\bfdescribe\s*\(/g },
   ]

   const FILE_IGNORE_RE = /@fitness-ignore-file\s+no-focused-tests/

   /**
    * Analyze a test file for focused-test patterns.
    *
    * @param {string} content - file contents
    * @param {string} filePath - absolute or workspace-relative path
    * @returns {Array<{line: number, severity: string, message: string, suggestion: string}>}
    */
   export function analyzeNoFocusedTests(content, filePath) {
     // Scope: only test files. isTestFile() recognizes *.test.ts,
     // *.test.tsx, *.spec.ts, *.spec.tsx, and anything under __tests__/.
     if (!isTestFile(filePath)) return []

     // Fast path: if none of the trigger substrings appear at all,
     // skip the regex pass entirely. Worth doing on every file because
     // most test files don't contain focused patterns.
     if (
       !content.includes('only') &&
       !content.includes('fit') &&
       !content.includes('fdescribe')
     ) {
       return []
     }

     // File-level opt-out: '// @fitness-ignore-file no-focused-tests'
     // in the first ~50 lines disables the check for the file.
     const rawLines = content.split('\n')
     if (rawLines.slice(0, 50).some((line) => FILE_IGNORE_RE.test(line))) return []

     // Mask strings and comments so a JSDoc example like
     // /* @example it.only('...') */ doesn't trip the regex.
     const stripped = stripStringsAndComments(content)
     const lines = stripped.split('\n')

     const violations = []
     for (let i = 0; i < lines.length; i++) {
       const line = lines[i] ?? ''
       for (const fp of FOCUS_PATTERNS) {
         // Note: regex has /g flag so we reset lastIndex implicitly
         // by using matchAll instead of .exec in a loop.
         for (const _match of line.matchAll(fp.pattern)) {
           void _match
           violations.push({
             line: i + 1,
             severity: 'error',
             message:
               `Focused test pattern \`${fp.form}\` will skip every other test in this file ` +
               `when CI runs. Remove before committing.`,
             suggestion: fp.form.startsWith('f')
               ? `Replace \`${fp.form}\` with \`${fp.form.slice(1)}\`.`
               : `Remove \`.only\` to restore full-suite execution.`,
           })
         }
       }
     }
     return violations
   }

   const noFocusedTestsCheck = defineCheck({
     id: CHECK_ID,
     slug: 'no-focused-tests',
     description:
       'Test files must not contain describe.only, it.only, test.only, fit(, or fdescribe( — ' +
       'these silently skip every other test in the file.',
     tags: ['testing', 'ci', 'hygiene'],
     fileTypes: ['ts', 'tsx'],
     scope: { languages: ['typescript'], concerns: ['testing'] },
     confidence: 'high',
     contentFilter: 'raw',
     analyze: analyzeNoFocusedTests,
   })

   // Discovery contract — see opensip-tools/fit/checks/README.md
   // and packages/core/src/plugins/__tests__/discover.test.ts:68-104.
   export const checks = [noFocusedTestsCheck]
   ```

3. Generate the UUID: `uuidgen` (lowercase) and paste into `CHECK_ID`.

4. Run `pnpm fit --check no-focused-tests` to confirm the check is discovered and runs cleanly against the existing test suite. If any existing test files contain focused patterns, that's a finding — see Task 2.2.

**Observability:** The fitness engine logs the check's invocation and any returned violations via existing Pino events. The check itself emits no new instrumentation.

**Wiring:** Auto-discovered by `packages/core/src/plugins/discover.ts` on the next `pnpm fit` run after the file lands. **No barrel re-export. No display registry entry.** The check appears in `fit-list` and runs as part of the default recipe.

**Error cases:**
- Returns `[]` for non-test files (the `isTestFile` guard).
- Returns `[]` for files containing none of the trigger substrings (fast-path).
- Returns `[]` if the file-level ignore directive is present.
- No throw paths — pure regex + string operations.
- If the `.mjs` has a syntax error, the plugin loader logs a parse error per `packages/core/src/plugins/loader.ts` and the check is silently absent until fixed. **`fit-list` not showing the check is the diagnostic signal.**

**Verification:**
```bash
pnpm build
node packages/cli/dist/index.js fit-list 2>&1 | grep "no-focused-tests"
# Expect: one line.

pnpm fit --check no-focused-tests
# Expect: zero violations on a clean main (no committed .only patterns).
```

**Commit:** `feat(fit): project-local no-focused-tests check`

---

## Task 2.2: Fix any genuine violations found by the new check

**Files:**
- Modify: any test file containing a focused pattern that slipped through.

**Context:** Like Phase 3 Task 3.3 — project-local checks fire immediately without a baseline ratchet. If `pnpm fit --check no-focused-tests` reports findings, fix them before merging. The fix is typically a one-character delete (`.only` → empty, or removing the leading `f` in `fdescribe`/`fit`).

**Steps:**

1. For each finding from Task 2.1's verification step:
   - Decide if the focused pattern was intentional (rare — almost always a leftover from local debugging).
   - Replace `.only`/`fit(`/`fdescribe(` with the unfocused form.
   - Re-run the affected test file to confirm the broader suite still passes.

2. Re-run `pnpm fit --check no-focused-tests` after each fix; final state should be zero violations.

**Observability:** N/A.

**Wiring:** Test files. The fix re-engages the previously-skipped tests in CI.

**Error cases:** If un-focusing a test reveals a real test failure that was hidden by `.only`, that's a finding to surface — fix the test, don't re-introduce `.only`. Per CLAUDE.md "No band-aid fixes."

**Verification:**
```bash
pnpm test
pnpm fit --check no-focused-tests
# Both must pass cleanly.
```

**Commit:** Same PR as Task 2.1. Suggested message: `fix(tests): remove committed focused-test patterns`.

---

## Task 2.3: Integration test coverage

**Files:**
- Coverage handled by Phase 4's `dogfood-integration.test.ts`.

**Context:** Per the conventions in `opensip-tools/fit/checks/README.md` (Phase 0 Task 0.4), project-local checks don't get a per-file Vitest config. Coverage comes from Phase 4's single integration test. No work for this phase — Phase 4 includes the `no-focused-tests` assertions.

**Steps:**

1. Confirm Phase 4's task list includes `no-focused-tests` cases.
2. No file changes in this phase for testing.

**Observability:** N/A.

**Wiring:** N/A.

**Error cases:** N/A.

**Verification:** Phase 4's verification covers this.

**Commit:** None — placeholder task to make the testing approach explicit.

---

## Phase 2 End-to-End Verification

After both substantive tasks:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
node packages/cli/dist/index.js fit-list | grep "no-focused-tests"
# The check appears in the list (under its raw slug; no display entry).

pnpm fit --check no-focused-tests
# Expect: zero violations (after Task 2.2 cleanup).

ls opensip-tools/fit/checks/no-focused-tests.mjs
# Confirm file at the expected project-local path.
```

Phase 2 is complete when (a) the check is discovered, (b) running it in isolation produces zero violations after any necessary code fixes, (c) the integration test in Phase 4 covers it, and (d) `pnpm lint` passes (note: `.mjs` files are not lint-targeted by the current ESLint config — `"lint": "eslint 'packages/**/src/**/*.{ts,tsx}'"` per `package.json:13` — so syntax issues will surface via `node packages/cli/dist/index.js fit-list` parse errors instead).

### Why project-local for a universal check

This is the first check landing in `opensip-tools/fit/checks/`, so it carries an explanatory burden. The rationale:

- **Teaching artifact.** The `.mjs` file is on display in the GitHub source tree. Anyone evaluating opensip-tools or learning to write a check can read it without installing the npm package.
- **First worked example.** Phase 0's README sets the conventions; this check is the first concrete demonstration of them. Future project-local checks copy the shape.
- **Lost first-party benefit is small.** Other consumers who want this check can copy the ~80-line file. We can promote to first-party later if multiple consumers ask.

If multiple consumers do start asking, the promotion path is: copy the `.mjs` to `packages/fitness/checks-typescript/src/checks/testing/no-focused-tests.ts`, convert to TypeScript, add the barrel + display + per-file Vitest test, and leave the original `.mjs` in place with a header comment cross-referencing the first-party version.
