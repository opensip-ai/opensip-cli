# Phase 7: TS-migration bridge

**Goal:** Document and demonstrate the migration path from `import ts from 'typescript'` + direct `getSharedSourceFile` usage to adapter-API consumption. Migrate exactly TWO TS-AST checks as worked examples. The long-tail migration of the remaining ~46 checks is explicitly out of scope and deferred to a follow-up plan.
**Depends on:** Phases 2 and 4

This phase exists to (a) prove the migration shape works end-to-end on real existing checks and (b) produce a written guide future contributors can follow without re-deriving the pattern.

Task order: 7.1 (write the migration guide) -> 7.2 (migrate `no-eval` as the simplest worked example) -> 7.3 (migrate a more complex check that uses `walkNodes`) -> 7.4 (regression test).

---

## Task 7.1: Write the TS-check migration guide

**Files:** [size: S]
- Create: `docs/plans/multi-language-support/migration-guide.md`

**Context:** The 48 checks under `packages/checks-builtin/src/checks/` that import `typescript` directly fall into ~3 shapes by import pattern:

1. **Pure pattern-matching** — imports `typescript` but only uses it for `ts.isXxx` predicates; the parse tree comes from `getSharedSourceFile`.
2. **Custom walkers** — imports `typescript` and uses `ts.forEachChild` directly or via `walkNodes` from `framework/ast-utilities.ts`.
3. **Scanner-based** — imports `typescript` for `ts.createScanner` (rare; e.g. comment extraction checks).

The migration guide describes the new shape and shows the diff for each pattern.

**Steps:**

1. Create the guide with three sections:

   **Section 1: The new shape.** A migrated check imports the TS adapter and uses the framework's `getParseTree` helper:
   ```typescript
   // Before
   import ts from 'typescript'
   import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

   const sf = getSharedSourceFile(filePath, content)

   // After
   import ts from 'typescript'  // still allowed; just for ts.isXxx type guards
   import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'
   import { typescriptAdapter } from '@opensip-tools/lang-typescript'

   const sf = getParseTree(typescriptAdapter, filePath, content)
   ```

   The `import ts from 'typescript'` is still allowed because `ts.isFunctionDeclaration` etc. are pure type-guard utilities — they don't trigger a parser load. Removing the dep entirely is a separate, future step.

   **Section 2: Scope declarations.** Existing checks have `scope: { languages: ['typescript'], ... }` — fine. Migrated checks SHOULD additionally declare `fileTypes: ['.ts', '.tsx']` for safety (the framework already filters by `fileTypes` in `define-check.ts:328` via `filterFilesByType`).

   **Section 3: Common pitfalls.**
   - `getSharedSourceFile` is sync and returns `ts.SourceFile`. `getParseTree(typescriptAdapter, ...)` returns the same type — no async, no API surprise.
   - The adapter is registered by the CLI bootstrap. If you run a check standalone in a test, `register` it explicitly: `defaultLanguageRegistry.register(typescriptAdapter)` in `beforeAll`.
   - If you currently import `walkNodes` from `@opensip-tools/core/framework/ast-utilities.js`, that path still works (Phase 2 turned it into a re-export from `lang-typescript`). You can optionally update the import to `@opensip-tools/lang-typescript`.

**Wiring:** None — documentation.

**Verification:** Readability check — get one teammate (or, in lieu, do a self-review pass after a 1-day gap) to migrate a third check using only this guide. If they have to ask questions the guide didn't answer, expand the guide.

**Commit:** `docs(plans): migration guide for TS check adapter API adoption`

---

## Task 7.2: Migrate `no-eval` as the simplest worked example

**Files:** [size: S]
- Modify: `packages/checks-builtin/src/checks/no-eval.ts`

**Context:** Pick the simplest TS-AST check that's currently importing `typescript` directly. `packages/checks-builtin/src/checks/no-eval.ts` is a strong candidate — it's at the top of the checks tree, likely uses a small AST walker, and the migration diff is small enough to use as the canonical example in the guide.

Verify by reading the file first; if it doesn't actually use `getSharedSourceFile`, pick a different one (e.g. `no-console-log.ts` is purely regex-based — skip it; pick the simplest one that does walk an AST).

**Steps:**

1. Read `packages/checks-builtin/src/checks/no-eval.ts` and note the current shape.
2. Replace any direct `getSharedSourceFile` call with `getParseTree(typescriptAdapter, ...)`.
3. Update the import: add `import { typescriptAdapter } from '@opensip-tools/lang-typescript'` and `import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'`.
4. Remove the import of `getSharedSourceFile` from `@opensip-tools/core/framework/parse-cache.js` if no other line uses it.
5. Add `@opensip-tools/lang-typescript` to `packages/checks-builtin/package.json` dependencies.

**Wiring:** The check is still discovered by the existing `register-checks.ts` (`packages/checks-builtin/src/register-checks.ts` from the CLAUDE.md description). No changes to the registry.

**Verification:**

Capture before/after output to confirm the violations match:
```bash
pnpm fit | grep -i 'no-eval' > /tmp/before-no-eval.txt
# Make the migration changes
pnpm fit | grep -i 'no-eval' > /tmp/after-no-eval.txt
diff /tmp/before-no-eval.txt /tmp/after-no-eval.txt
```
Empty diff = success.

**Commit:** `refactor(checks-builtin): migrate no-eval to LanguageAdapter API`

---

## Task 7.3: Migrate a more complex check that uses `walkNodes`

**Files:** [size: S]
- Modify: one TS-AST check chosen from `packages/checks-builtin/src/checks/architecture/` (e.g. `di-static-inject-usage.ts`, `typed-inject-scope-mismatch.ts`, or `modules/unused-modules.ts`)

**Context:** Pick a check that imports both `getSharedSourceFile` and `walkNodes` (or equivalent AST helpers from `framework/ast-utilities.ts`). The migration shape is the same as Task 7.2 plus updating the helper import path.

The candidates with confirmed both-imports usage (from Phase 0 research):
- `di-static-inject-usage.ts` (line 12, 421)
- `typed-inject-scope-mismatch.ts` (line 8, 188)
- `modules/unused-modules.ts` (line 9, 40, 85)
- `api/api-response-validation.ts` (line 17, 159)

Pick the one with the smallest line count to keep the diff focused.

**Steps:**

1. Read the chosen check.
2. Update imports per Task 7.1 guide.
3. The `walkNodes` import from `@opensip-tools/core/framework/ast-utilities.js` keeps working (re-exported from `lang-typescript`); optionally update to `@opensip-tools/lang-typescript/ast-utilities` for hygiene.
4. Sanity-run the check against the existing test fixtures it has (each check in this directory has corresponding tests under `packages/checks-builtin/src/checks/architecture/__tests__/`).

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-builtin test
pnpm fit | grep -i '<slug>' > /tmp/before.txt
# migrate
pnpm fit | grep -i '<slug>' > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

**Commit:** `refactor(checks-builtin): migrate <check-slug> to LanguageAdapter API`

---

## Task 7.4: Regression test for the migration shape

**Files:** [size: XS]
- Modify: existing test file for the check migrated in Task 7.3 (e.g. its `__tests__/<slug>.test.ts`)

**Context:** Add ONE assertion to the migrated check's test: that running the check standalone (without the CLI bootstrap) requires explicit adapter registration. This protects against a future refactor that accidentally hides the dependency on the registered adapter.

**Steps:**

1. In the chosen test file, add a test:
   ```typescript
   it('returns no violations when the TS adapter is not registered (graceful)', async () => {
     defaultLanguageRegistry.clear()
     // run the check against a known-violating fixture
     const result = await runCheckAgainst(fixturePath)
     expect(result.signals).toHaveLength(0)
   })

   it('works when the TS adapter is registered', async () => {
     defaultLanguageRegistry.register(typescriptAdapter)
     const result = await runCheckAgainst(fixturePath)
     expect(result.signals.length).toBeGreaterThan(0)
   })
   ```

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-builtin test
```

**Commit:** `test(checks-builtin): adapter-registration regression test for migrated check`

---

## Phase 7 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm fit > /tmp/fit-phase7.txt 2>&1
diff /tmp/fit-baseline.txt /tmp/fit-phase7.txt
```

Empty diff = the migration is semantically transparent. Any non-empty diff means the two migrated checks behave differently after migration, which is a bug.

Then count remaining direct-import checks:
```bash
grep -rln "import ts from 'typescript'\|import \* as ts from 'typescript'" packages/checks-builtin/src/checks | wc -l
```

Expected: 46 (down from 48). The long-tail migration plan starts here.
