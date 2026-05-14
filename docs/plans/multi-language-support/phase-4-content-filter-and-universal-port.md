# Phase 4: Adapter-driven content filter + first universal checks port

**Goal:** Move per-language content filtering (`stripStrings`, `stripComments`) from the TS-hardcoded `packages/core/src/framework/content-filter.ts` to be adapter-driven. As proof, port two regex-based built-in checks into a new `@opensip-tools/checks-universal` package that uses the `LanguageQueryAPI` so they work on any language with an adapter.
**Depends on:** Phase 3

Task order: 4.1 (content-filter dispatch refactor) -> 4.2 (checks-universal package) -> 4.3 (port no-todo-comments) -> 4.4 (port file-length-limit) -> 4.5 (tests).

---

## Task 4.1: Refactor content-filter to dispatch to the adapter

**Files:** [size: M]
- Modify: `packages/core/src/framework/define-check.ts` (lines 107-115)
- Modify: `packages/core/src/framework/content-filter.ts`

**Context:** Today the analyze loop calls `filterContent(rawContent)` and reads `.code` or `.codeNoComments` at `define-check.ts` lines 109 to 112. `filterContent` lives in `core/framework/content-filter.ts:11` and hardcodes the TS scanner. Replace that with adapter dispatch: resolve the adapter for the file path; call `adapter.stripStrings(content)` or `adapter.stripComments(content)`. If no adapter is registered (e.g. a YAML config file matched by a TS check), fall through to a generic regex-based stripper (one-line strings, `//` and `#` comments) — best effort.

**Steps:**

1. In `packages/core/src/framework/define-check.ts` at lines 107-115, replace the inline `if`/`else if` block with adapter-driven dispatch:
   ```typescript
   import { defaultLanguageRegistry } from '../languages/index.js'

   const adapter = defaultLanguageRegistry.forFile(filePath)
   let content: string
   if (config.contentFilter === 'strip-strings') {
     content = adapter ? adapter.stripStrings(rawContent) : genericStripStrings(rawContent)
   } else if (config.contentFilter === 'strip-strings-and-comments') {
     content = adapter ? adapter.stripComments(rawContent) : genericStripComments(rawContent)
   } else {
     content = rawContent
   }
   ```
2. Add `genericStripStrings` / `genericStripComments` helpers as new internal functions in `define-check.ts` (or pull into a new `packages/core/src/framework/generic-strip.ts`). Implementation: simple regex replacements (`"..."` -> spaces, `'...'` -> spaces, `//.*$` -> spaces, `/\*[\s\S]*?\*/` -> spaces). These are intentionally imperfect — the framework only falls back when no adapter is registered, which should be rare in practice.
3. `packages/core/src/framework/content-filter.ts` is now legacy. Two options:
   - **(a)** Keep it as a re-export of TS-specific behavior from `@opensip-tools/lang-typescript/strip` for the few callers that import `filterContent` directly (e.g. for the position-aware predicates).
   - **(b)** Delete it and require callers to migrate.

   Pick **(a)** because checks may use the richer `filterContent()` return shape (`commentLines`, `isInString`, `isInComment`). Convert the file to:
   ```typescript
   export { filterContent } from '@opensip-tools/lang-typescript/strip'
   export type { FilteredContent } from '@opensip-tools/lang-typescript/strip'
   ```
4. Run `grep -rn "filterContent\|FilteredContent" packages/checks-builtin packages/core` to confirm call sites still resolve.
5. Remove the now-unused `typescript` import at the top of `content-filter.ts` (it lives in `lang-typescript` now).

**Wiring:** `define-check.ts`'s `executeAnalyzeMode` is the single dispatch site for `contentFilter`. After this task, no other code reaches into TS-specific stripping by default — only checks that explicitly import from `@opensip-tools/lang-typescript`.

**Verification:**
```bash
pnpm build && pnpm typecheck && pnpm test
pnpm fit > /tmp/fit-phase4.txt 2>&1
diff /tmp/fit-baseline.txt /tmp/fit-phase4.txt
```

Expected: identical output. Any drift means the adapter's strip implementation diverges from the original `filterContent` for the file being checked.

**Commit:** `refactor(core): dispatch contentFilter to LanguageAdapter`

---

## Task 4.2: Create `@opensip-tools/checks-universal` package

**Files:** [size: S]
- Create: `packages/checks-universal/package.json`, `tsconfig.json`, `src/index.ts`

**Context:** Mirror `packages/checks-rust/package.json` (Phase 3 Task 3.1). Dependencies: only `@opensip-tools/core`. The package contains checks that work on any language with a registered adapter — they reach the file via the framework's per-file analyze loop and use the `LanguageQueryAPI` (or pure string operations) to find violations.

**Steps:**

1. `packages/checks-universal/package.json`:
   ```json
   {
     "name": "@opensip-tools/checks-universal",
     "version": "0.6.1",
     "license": "MIT",
     "description": "Language-agnostic fitness checks for opensip-tools",
     "type": "module",
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "scripts": { "build": "tsc", "test": "vitest run --passWithNoTests", "typecheck": "tsc --noEmit", "clean": "rm -rf dist" },
     "dependencies": { "@opensip-tools/core": "workspace:*" },
     "devDependencies": { "@types/node": "^22.0.0", "vitest": "^2.1.0" }
   }
   ```
2. `pnpm install`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-universal build
```

**Commit:** `feat(checks-universal): scaffold workspace package`

---

## Task 4.3: Port `no-todo-comments` to universal

**Files:** [size: S]
- Create: `packages/checks-universal/src/checks/no-todo-comments.ts`

**Context:** Find an existing regex-based check in `packages/checks-builtin/src/checks/` that flags TODO comments (likely under `documentation/` or `quality/`). The check today is TS-scoped because `contentFilter` is TS-specific; once Phase 4 Task 4.1 lands, the same logic works for any language whose adapter implements `stripStrings` correctly.

The ported check:
- Declares `scope: { languages: [], concerns: [] }` — empty arrays mean "match any" per `target-registry.ts` lines 86-89.
- Uses `contentFilter: 'strip-strings'` so quoted text containing "TODO" is not flagged.
- Scans the filtered content with a line-based regex.

**Steps:**

1. Read the existing TS check (find via `grep -rn "TODO\\|FIXME\\|XXX" packages/checks-builtin/src/checks/`). Verify its current shape.
2. Create `packages/checks-universal/src/checks/no-todo-comments.ts`:
   ```typescript
   import { defineCheck, type CheckViolation } from '@opensip-tools/core'

   const PATTERN = /\b(TODO|FIXME|XXX)\b/

   export const noTodoComments = defineCheck({
     id: 'c1d2e3f4-a5b6-7890-abcd-ef0123456789',
     slug: 'no-todo-comments',
     description: 'Flags TODO / FIXME / XXX comments — author-action items rotting in the codebase',
     scope: { languages: [], concerns: [] },
     tags: ['quality', 'documentation'],
     contentFilter: 'strip-strings',
     analyze: (content, filePath) => {
       const violations: CheckViolation[] = []
       const lines = content.split('\n')
       for (let i = 0; i < lines.length; i++) {
         const m = PATTERN.exec(lines[i] ?? '')
         if (m) {
           violations.push({
             line: i + 1,
             column: m.index,
             message: `${m[0]} marker found — resolve or convert to a tracked issue`,
             severity: 'warning',
             match: m[0],
           })
         }
       }
       return violations
     },
   })
   ```
3. Export from `src/index.ts`.

**Wiring:** Registered via the `'fit'` plugin domain — users add `@opensip-tools/checks-universal` to their fit plugins. Whether the original TS-only `no-todo-comments` in checks-builtin is removed is a separate decision (NOT in scope for this plan — strangler).

**Verification:**

Run against the existing Rust fixture from Phase 3 (add a `// TODO: handle errors` line to `sample.rs`) and a TS fixture. Both should trigger the check.

**Commit:** `feat(checks-universal): port no-todo-comments to language-agnostic check`

---

## Task 4.4: Port `file-length-limit` to universal

**Files:** [size: S]
- Create: `packages/checks-universal/src/checks/file-length-limit.ts`

**Context:** A second universal check that's even simpler — flags files over N lines. No content filter needed; pure line-counting. Demonstrates that checks don't need any language API to work universally.

**Steps:**

1. Create the check with a configurable threshold (default 500 lines). Same shape as Task 4.3 but with `analyze` returning at most one violation at line 1 when the file exceeds the threshold.
2. Export from `src/index.ts`.

**Wiring:** Same as Task 4.3.

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-universal test
```

**Commit:** `feat(checks-universal): port file-length-limit to language-agnostic check`

---

## Task 4.5: Tests + cross-language regression

**Files:** [size: S]
- Create: `packages/checks-universal/src/__tests__/no-todo-comments.test.ts`
- Create: `packages/checks-universal/src/__tests__/cross-language.test.ts`

**Context:** Two test files. The first is a standard per-check unit test. The second is the load-bearing one: it runs `no-todo-comments` against TS, Rust, and a synthetic third language with a fake adapter, asserting that the same check produces correct results in each. This is what proves the cross-language design.

**Steps:**

1. `no-todo-comments.test.ts`: synthetic content with TODO/FIXME/XXX in code, in strings, in comments. Verify which are flagged.
2. `cross-language.test.ts`: register the TS and Rust adapters, run the check against a TS file with `const s = "TODO foo"; // TODO real` (only the comment should be flagged after `stripStrings`) and a `.rs` file with `let s = "TODO foo"; // TODO real` (same expectation). Use the Rust adapter from Phase 3 with warmup.

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-universal test
```

**Commit:** `test(checks-universal): cover cross-language application of no-todo-comments`

---

## Phase 4 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm fit > /tmp/fit-phase4-final.txt 2>&1
diff /tmp/fit-baseline.txt /tmp/fit-phase4-final.txt
```

Expected: identical output for existing checks; the new universal checks only appear if the user has explicitly added `@opensip-tools/checks-universal` to their plugins (which they haven't for the default opensip-tools run).
