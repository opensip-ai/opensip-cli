# Phase 2: Extract `@opensip-tools/lang-typescript` (hard cutover)

**Goal:** Ship the first `LanguageAdapter` implementation as a new workspace package: `@opensip-tools/lang-typescript`. It owns the TS adapter, parse, query, strip, and AST utilities. All 48 TS-direct checks under `packages/checks-builtin/src/checks/` are updated to import from `@opensip-tools/lang-typescript`. `framework/parse-cache.ts` and `framework/ast-utilities.ts` become pure re-exports. The `typescript` runtime dependency is removed from `@opensip-tools/core`.
**Depends on:** Phase 1

Task order: 2.1 (new package) → 2.2 (TS adapter + parse) → 2.3 (TS query API) → 2.4 (TS strip-strings/comments) → 2.5 (AST utilities + getSharedSourceFile) → 2.6 (migrate all 48 checks) → 2.7 (collapse core shims + remove TS dep) → 2.8 (tests).

---

## Task 2.1: Create `@opensip-tools/lang-typescript` package

**Files:** [size: S]
- Create: `packages/lang-typescript/package.json`
- Create: `packages/lang-typescript/tsconfig.json`
- Create: `packages/lang-typescript/src/index.ts` (initially empty barrel)

**Context:** Mirror the shape of `packages/checks-builtin/package.json`. The package's `dependencies` are `@opensip-tools/core` (workspace) and `typescript` (the real parser).

**Steps:**

1. `packages/lang-typescript/package.json`:
   ```json
   {
     "name": "@opensip-tools/lang-typescript",
     "version": "0.6.1",
     "license": "MIT",
     "description": "TypeScript/JavaScript language adapter for opensip-tools",
     "repository": { "type": "git", "url": "https://github.com/opensip-ai/opensip-tools.git", "directory": "packages/lang-typescript" },
     "homepage": "https://github.com/opensip-ai/opensip-tools",
     "bugs": { "url": "https://github.com/opensip-ai/opensip-tools/issues" },
     "type": "module",
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "exports": {
       ".": "./dist/index.js",
       "./adapter": "./dist/adapter.js",
       "./parse": "./dist/parse.js",
       "./query": "./dist/query.js",
       "./strip": "./dist/strip.js",
       "./ast-utilities": "./dist/ast-utilities.js"
     },
     "scripts": {
       "build": "tsc",
       "test": "vitest run --passWithNoTests",
       "typecheck": "tsc --noEmit",
       "clean": "rm -rf dist"
     },
     "dependencies": {
       "@opensip-tools/core": "workspace:*",
       "typescript": "~5.7.0"
     },
     "devDependencies": {
       "@types/node": "^22.0.0",
       "vitest": "^2.1.0"
     }
   }
   ```
2. Same `tsconfig.json` pattern as other packages.
3. Empty `src/index.ts` for now.
4. Run `pnpm install` from repo root.

**Verification:**
```bash
pnpm install && pnpm --filter=@opensip-tools/lang-typescript build
```

**Commit:** `feat(lang-typescript): scaffold workspace package`

---

## Task 2.2: Implement TS adapter — parse + identity

**Files:** [size: M]
- Create: `packages/lang-typescript/src/parse.ts`
- Create: `packages/lang-typescript/src/adapter.ts`

**Context:** The TS adapter implements `LanguageAdapter<ts.SourceFile, ts.Node>`. `parse()` mirrors the existing `getSharedSourceFile`'s direct-parse logic. Adapter ID is `'typescript'`; aliases include `'javascript'`, `'tsx'`, `'jsx'`. Extensions are `['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']`.

**Steps:**

1. `packages/lang-typescript/src/parse.ts`:
   ```typescript
   import ts from 'typescript'

   export function parseSource(content: string, filePath: string): ts.SourceFile | null {
     try {
       return ts.createSourceFile(
         filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
       )
     } catch { return null }
   }
   ```

2. `packages/lang-typescript/src/adapter.ts`:
   ```typescript
   import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'
   import type ts from 'typescript'

   import { parseSource } from './parse.js'
   import { stripStrings, stripComments } from './strip.js'
   import { typescriptQuery } from './query.js'

   export const typescriptAdapter: LanguageAdapter<ts.SourceFile, ts.Node> = {
     id: 'typescript',
     fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
     aliases: ['javascript', 'tsx', 'jsx', 'js'],
     parse: parseSource,
     stripStrings,
     stripComments,
     query: typescriptQuery,
   }

   export const adapters = [typescriptAdapter] as const
   ```

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build && pnpm --filter=@opensip-tools/lang-typescript typecheck
```

**Commit:** `feat(lang-typescript): TS LanguageAdapter implementation`

---

## Task 2.3: TS query API implementation

**Files:** [size: M]
- Create: `packages/lang-typescript/src/query.ts`

**Context:** Implement `LanguageQueryAPI<ts.SourceFile, ts.Node>` against the TS compiler. The implementation is identical to Phase 3's Rust query API in spirit — `findFunctions`, `findImports`, `findCallsTo`, `findStringLiterals`, `getLocation`, `getText` — but uses TS-native APIs (`ts.forEachChild`, `ts.isFunctionDeclaration`, etc.).

**Steps:**

1. `packages/lang-typescript/src/query.ts` — implement the query API using `ts.forEachChild` traversal. See the original plan for the full implementation.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build
```

**Commit:** `feat(lang-typescript): implement LanguageQueryAPI for TS`

---

## Task 2.4: TS string/comment stripping

**Files:** [size: M]
- Create: `packages/lang-typescript/src/strip.ts`

**Context:** Move the TS-scanner-based stripping from `packages/core/src/framework/content-filter.ts` into the adapter. The `filterContent` function (richer position-aware API) also moves here for checks that use it.

**Steps:**

1. `packages/lang-typescript/src/strip.ts` — extract the TS-scanner logic from `content-filter.ts`:
   ```typescript
   export function stripStrings(content: string): string { /* ... */ }
   export function stripComments(content: string): string { /* ... */ }
   export interface FilteredContent { /* same shape */ }
   export function filterContent(content: string): FilteredContent { /* same impl */ }
   ```

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build
```

**Commit:** `feat(lang-typescript): TS strip-strings/strip-comments + position-aware filter`

---

## Task 2.5: Move AST utilities + getSharedSourceFile

**Files:** [size: S]
- Create: `packages/lang-typescript/src/ast-utilities.ts`
- Modify: `packages/lang-typescript/src/index.ts`

**Context:** `framework/ast-utilities.ts` exports `parseSource`, `walkNodes`, `getIdentifierName`, `getPropertyChain`, etc. Move the implementations here. Also add `getSharedSourceFile` that delegates to the language-aware cache via the TS adapter.

**Steps:**

1. Create `packages/lang-typescript/src/ast-utilities.ts` by copying `packages/core/src/framework/ast-utilities.ts` contents.
2. Add `getSharedSourceFile` to the barrel:
   ```typescript
   import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'
   import { typescriptAdapter } from './adapter.js'

   export function getSharedSourceFile(filePath: string, content: string) {
     return getParseTree(typescriptAdapter, filePath, content)
   }
   ```
3. Update `src/index.ts` to export everything.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build
```

**Commit:** `feat(lang-typescript): move AST helpers + getSharedSourceFile from core`

---

## Task 2.6: Migrate all 48 checks to import from lang-typescript

**Files:** [size: L — high file count, low per-file complexity]
- Modify: all 48 files under `packages/checks-builtin/src/checks/` that import from `@opensip-tools/core/framework/parse-cache.js`, `@opensip-tools/core/framework/ast-utilities.js`, or `import ts from 'typescript'`

**Context:** This is the hard cutover. Every check that directly imports `typescript` or uses `getSharedSourceFile`/`parseSource`/`walkNodes` from core switches to importing from `@opensip-tools/lang-typescript`. The changes are mechanical — find and replace import paths.

**Steps:**

1. Find all affected files:
   ```bash
   grep -rln "@opensip-tools/core/framework/parse-cache\|@opensip-tools/core/framework/ast-utilities\|from 'typescript'" packages/checks-builtin/src/checks/
   ```

2. For each file, apply these import replacements:
   - `import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'`
     → `import { getSharedSourceFile } from '@opensip-tools/lang-typescript'`
   - `import { parseSource, walkNodes, getIdentifierName, ... } from '@opensip-tools/core/framework/ast-utilities.js'`
     → `import { parseSource, walkNodes, getIdentifierName, ... } from '@opensip-tools/lang-typescript/ast-utilities'`
   - `import ts from 'typescript'` stays — but `typescript` is now a transitive dep via `@opensip-tools/lang-typescript`. Add `@opensip-tools/lang-typescript` as a dependency of `@opensip-tools/checks-builtin`.

3. Update `packages/checks-builtin/package.json`:
   ```json
   "dependencies": {
     "@opensip-tools/core": "workspace:*",
     "@opensip-tools/lang-typescript": "workspace:*"
   }
   ```
   Remove `"typescript"` from `checks-builtin`'s direct dependencies if present (it comes transitively from `lang-typescript`).

**Verification:**
```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

All existing tests must pass identically. This is a pure import-path change — no behavioral change.

**Commit:** `refactor(checks-builtin): migrate all checks to import from @opensip-tools/lang-typescript`

---

## Task 2.7: Collapse core shims + remove typescript from core

**Files:** [size: S]
- Modify: `packages/core/src/framework/parse-cache.ts`
- Modify: `packages/core/src/framework/ast-utilities.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/cli/src/index.ts` (or wherever the CLI bootstraps)

**Context:** Now that `lang-typescript` owns all TS-specific code and all 48 checks import from it, core's shims become pure re-exports with no TS dependency.

**Steps:**

1. `packages/core/src/framework/parse-cache.ts` becomes:
   ```typescript
   // Re-export from language-aware parse cache.
   // getSharedSourceFile is now in @opensip-tools/lang-typescript.
   export {
     initParseCache,
     clearParseCache,
     getParseTree,
     getParseTreeForFile,
   } from '../languages/parse-cache.js'
   ```
   Remove the `getSharedSourceFile` stub and the `import ts from 'typescript'`.

2. `packages/core/src/framework/ast-utilities.ts` becomes:
   ```typescript
   // Re-export from @opensip-tools/lang-typescript.
   export * from '@opensip-tools/lang-typescript/ast-utilities'
   ```

3. Remove `"typescript"` from `packages/core/package.json` dependencies. Add `"@opensip-tools/lang-typescript": "workspace:*"` to core's dependencies (for the ast-utilities re-export).

4. In the CLI bootstrap (find via `grep -rn "defaultRegistry\|defaultLanguageRegistry" packages/cli`):
   ```typescript
   import { defaultLanguageRegistry } from '@opensip-tools/core/languages'
   import { typescriptAdapter } from '@opensip-tools/lang-typescript'

   defaultLanguageRegistry.register(typescriptAdapter)
   ```

**Verification:**
```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test
pnpm fit --list | head
```

Confirm `typescript` no longer appears in `packages/core/package.json` dependencies. Confirm `pnpm fit` produces the same results as before.

**Commit:** `refactor(core): remove typescript dep — all TS code now in @opensip-tools/lang-typescript`

---

## Task 2.8: Adapter tests

**Files:** [size: S]
- Create: `packages/lang-typescript/src/__tests__/adapter.test.ts`

**Context:** Cover the adapter surface end-to-end: parse, query, strip.

**Steps:**

1. `adapter.test.ts` covers:
   - `parse('const x = 1;', 'foo.ts')` returns a non-null `ts.SourceFile`
   - `query.findFunctions` on `function a(){} const b = () => {}` returns two entries
   - `query.findImports` on `import { x } from './foo'` returns one entry
   - `stripStrings('const x = "abc"')` replaces string content with spaces
   - `stripComments('// hi\nconst x = 1')` replaces comment content with spaces

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript test
```

**Commit:** `test(lang-typescript): cover adapter parse/query/strip end-to-end`

---

## Phase 2 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm fit > /tmp/fit-phase2.txt 2>&1
```

Compare `/tmp/fit-phase2.txt` against a baseline captured before Phase 2 — the set of violations reported must be identical.

Confirm no remaining imports of `getSharedSourceFile` from core:
```bash
grep -rn "@opensip-tools/core/framework/parse-cache" packages/checks-builtin/src | wc -l
```
Should be 0.

Confirm `typescript` is not in core's deps:
```bash
grep '"typescript"' packages/core/package.json
```
Should return nothing.
