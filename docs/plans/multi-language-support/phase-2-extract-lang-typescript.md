# Phase 2: Extract `@opensip-tools/lang-typescript`

**Goal:** Ship the first `LanguageAdapter` implementation as a new workspace package: `@opensip-tools/lang-typescript`. It owns the TS adapter, exposes the `parseSource` / `getSharedSourceFile` / AST helpers that checks-builtin uses today, and registers itself as a language pack. The `framework/parse-cache.ts` and `framework/ast-utilities.ts` shims become thin re-exports; the 48 TS-direct checks under `packages/checks-builtin/src/checks/` keep their existing import paths.
**Depends on:** Phase 1

Task order: 2.1 (new package) → 2.2 (TS adapter + parse) → 2.3 (TS query API) → 2.4 (TS strip-strings/comments) → 2.5 (re-export legacy helpers) → 2.6 (shim collapse) → 2.7 (tests).

---

## Task 2.1: Create `@opensip-tools/lang-typescript` package

**Files:** [size: S]
- Create: `packages/lang-typescript/package.json`
- Create: `packages/lang-typescript/tsconfig.json`
- Create: `packages/lang-typescript/src/index.ts` (initially empty barrel)

**Context:** Mirror the shape of `packages/checks-builtin/package.json`. The package's `dependencies` are `@opensip-tools/core` (workspace) and `typescript` (the real parser). Subpath exports mirror what checks-builtin currently imports from core (`./parse-cache`, `./ast-utilities`) so the redirection in Task 2.6 is path-preserving.

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
       "./strip": "./dist/strip.js"
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
2. `packages/lang-typescript/tsconfig.json` extends the repo root `tsconfig.json` and sets `outDir: "dist"`, `rootDir: "src"`, identical to other packages.
3. Empty `src/index.ts` for now.
4. Run `pnpm install` from repo root — Turborepo/pnpm picks up the new package.

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

**Context:** The TS adapter implements `LanguageAdapter<ts.SourceFile, ts.Node>`. `parse()` mirrors `getSharedSourceFile`'s direct-parse branch (no cache here — caching is the framework's job via `getParseTree`). Adapter ID is `'typescript'`; aliases include `'javascript'`, `'tsx'`, `'jsx'` so existing scope declarations still match. Extensions are `['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']`.

The `ts.ScriptKind.TSX` choice from `parse-cache.ts:35` is the right default — it handles both `.ts` and `.tsx` (and is safe for `.js`/`.jsx` because the TS parser is permissive enough).

**Steps:**

1. `packages/lang-typescript/src/parse.ts`:
   ```typescript
   import ts from 'typescript'

   export function parseSource(content: string, filePath: string): ts.SourceFile | null {
     try {
       return ts.createSourceFile(
         filePath,
         content,
         ts.ScriptTarget.Latest,
         /* setParentNodes */ true,
         ts.ScriptKind.TSX,
       )
     } catch {
       return null
     }
   }
   ```
2. `packages/lang-typescript/src/adapter.ts`:
   ```typescript
   import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'
   import type ts from 'typescript'

   import { parseSource } from './parse.js'
   import { stripStrings, stripComments } from './strip.js'    // see Task 2.4
   import { typescriptQuery } from './query.js'                // see Task 2.3

   export const typescriptAdapter: LanguageAdapter<ts.SourceFile, ts.Node> = {
     id: 'typescript',
     fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
     aliases: ['javascript', 'tsx', 'jsx', 'js'],
     parse: parseSource,
     stripStrings,
     stripComments,
     query: typescriptQuery,
   }
   ```
3. Export from `src/index.ts`:
   ```typescript
   export { typescriptAdapter } from './adapter.js'
   export { parseSource } from './parse.js'
   ```
4. Add a plugin entry point — at the package root, the `register` hook for plugin-domain loading:
   ```typescript
   // Re-export shape consumed by the lang plugin domain
   export const adapters = [typescriptAdapter] as const
   ```
   (Re-checking Phase 1 Task 1.3's loader shape, the plugin contract reads `module.adapters`. Confirm the loader does this; if it expects a `register(registry)` function instead, adjust here.)

**Wiring:** This package doesn't auto-register globally. Two registration paths:
1. The plugin domain — a user adds `@opensip-tools/lang-typescript` under `~/.opensip-tools/lang/node_modules/` or declares it in `plugins.lang` in `opensip-tools.config.yml`.
2. **For the bundled-by-default case** (TS is the default language for opensip-tools itself), the CLI bootstrap will explicitly register the adapter. This is wired in Task 2.6.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build && pnpm --filter=@opensip-tools/lang-typescript typecheck
```

**Commit:** `feat(lang-typescript): TS LanguageAdapter implementation`

---

## Task 2.3: TS query API implementation

**Files:** [size: M]
- Create: `packages/lang-typescript/src/query.ts`

**Context:** Implement `LanguageQueryAPI<ts.SourceFile, ts.Node>` against the TS compiler. The shape is in `packages/core/src/languages/adapter.ts` (Phase 0). For TS, `findFunctions`, `findImports`, `findCallsTo`, `findStringLiterals`, `getLocation`, `getText` are all expressible against `ts.forEachChild` traversal — the same pattern used by `framework/ast-utilities.ts:35` (`walkNodes`).

This is the first concrete instance of the query API and sets the bar for what other adapters must support. Keep the implementation idiomatic to TS — don't try to anticipate how Rust/Python will implement the same primitives.

**Steps:**

1. `packages/lang-typescript/src/query.ts`:
   ```typescript
   import ts from 'typescript'

   import type {
     LanguageQueryAPI,
     GenericFunction,
     Import,
     Location,
   } from '@opensip-tools/core/languages/adapter.js'

   function locationOf(sourceFile: ts.SourceFile, node: ts.Node): Location {
     const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
     return { file: sourceFile.fileName, line: line + 1, column: character }
   }

   function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
     visit(node)
     ts.forEachChild(node, (child) => walk(child, visit))
   }

   export const typescriptQuery: LanguageQueryAPI<ts.SourceFile, ts.Node> = {
     findFunctions(tree) {
       const out: GenericFunction<ts.Node>[] = []
       walk(tree, (n) => {
         if (
           ts.isFunctionDeclaration(n) ||
           ts.isFunctionExpression(n) ||
           ts.isArrowFunction(n) ||
           ts.isMethodDeclaration(n)
         ) {
           const name = (n as ts.FunctionDeclaration).name?.text ?? null
           out.push({ name, location: locationOf(tree, n), node: n })
         }
       })
       return out
     },
     findImports(tree) {
       const out: Import[] = []
       walk(tree, (n) => {
         if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
           const specifier = n.moduleSpecifier.text
           const names: string[] = []
           const clause = n.importClause
           if (clause?.name) names.push(clause.name.text)
           if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
             for (const elem of clause.namedBindings.elements) names.push(elem.name.text)
           }
           out.push({ specifier, names, location: locationOf(tree, n) })
         }
       })
       return out
     },
     findCallsTo(tree, name) {
       const out: ts.Node[] = []
       walk(tree, (n) => {
         if (ts.isCallExpression(n)) {
           const expr = n.expression
           const target = ts.isIdentifier(expr) ? expr.text
             : ts.isPropertyAccessExpression(expr) ? expr.name.text
             : ''
           if (target === name) out.push(n)
         }
       })
       return out
     },
     findStringLiterals(tree) {
       const out: { value: string; location: Location }[] = []
       walk(tree, (n) => {
         if (ts.isStringLiteralLike(n)) {
           out.push({ value: n.text, location: locationOf(tree, n) })
         }
       })
       return out
     },
     getLocation(tree, node) {
       return locationOf(tree, node)
     },
     getText(tree, node) {
       return node.getText(tree)
     },
   }
   ```

**Wiring:** Consumed by `typescriptAdapter.query` (Task 2.2). Cross-language checks in `@opensip-tools/checks-universal` (Phase 4) will hit this API rather than the native AST.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build && pnpm --filter=@opensip-tools/lang-typescript typecheck
```

**Commit:** `feat(lang-typescript): implement LanguageQueryAPI for TS`

---

## Task 2.4: TS string/comment stripping

**Files:** [size: M]
- Create: `packages/lang-typescript/src/strip.ts`

**Context:** Move the TS-scanner-based stripping from `packages/core/src/framework/content-filter.ts:11` into the adapter. The framework keeps a `filterContent()` function for backwards compatibility (Phase 4 makes it dispatch to the adapter); this task only owns the TS portion.

The existing `filterContent` produces two outputs (`code` with strings stripped, `codeNoComments` with strings + comments stripped) plus position-aware predicates (`isInString`, `isInComment`). Phase 0's `LanguageAdapter` interface only requires the two string outputs (`stripStrings(content): string`, `stripComments(content): string`). The position predicates remain a TS-specific extra exported from `lang-typescript` for the checks that use them today.

**Steps:**

1. `packages/lang-typescript/src/strip.ts` — extract the TS-scanner logic from `content-filter.ts` into:
   ```typescript
   import ts from 'typescript'

   export function stripStrings(content: string): string { /* replace string literal regions with spaces */ }
   export function stripComments(content: string): string { /* replace both strings AND comments with spaces */ }

   // Position-aware helpers retained for the TS checks that use them
   export interface FilteredContent { /* same shape as the original */ }
   export function filterContent(content: string): FilteredContent { /* same impl */ }
   ```
   Use `ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.JSX, content)` and walk tokens, recording offset ranges for `StringLiteral`, `NoSubstitutionTemplateLiteral`, `TemplateHead`, `TemplateMiddle`, `TemplateTail`, `SingleLineCommentTrivia`, `MultiLineCommentTrivia`. The exact algorithm matches the existing one in `content-filter.ts` lines 1–80+.

2. Export from `src/index.ts`:
   ```typescript
   export { stripStrings, stripComments, filterContent } from './strip.js'
   ```

**Wiring:** `typescriptAdapter.stripStrings` and `.stripComments` (Task 2.2). `filterContent` (the richer position-aware API) keeps its current shape and is consumed by `core/framework/content-filter.ts` as a re-export starting in Phase 4.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build && pnpm --filter=@opensip-tools/lang-typescript test
```

Manual sanity: pipe a TS snippet with comments and string literals into a one-off script and confirm the two outputs match what `core/framework/content-filter.ts` produces today on the same input.

**Commit:** `feat(lang-typescript): TS strip-strings/strip-comments + position-aware filter`

---

## Task 2.5: Re-export legacy helpers (`parseSource`, `getSharedSourceFile`, AST utilities)

**Files:** [size: S]
- Modify: `packages/lang-typescript/src/index.ts`
- Create: `packages/lang-typescript/src/ast-utilities.ts`

**Context:** 48 checks in `packages/checks-builtin/src/checks/` import `typescript` directly. ~15 of them additionally import from `@opensip-tools/core/framework/ast-utilities.js` and `@opensip-tools/core/framework/parse-cache.js`. After this phase, those import paths still work (via Task 2.6's shim), but the underlying implementation lives in `lang-typescript`.

`framework/ast-utilities.ts` exports `parseSource`, `walkNodes`, `getIdentifierName`, `getPropertyChain`, and a handful of other helpers (read the full file to enumerate). Move the IMPLEMENTATIONS here; the shim in core will re-export.

**Steps:**

1. Create `packages/lang-typescript/src/ast-utilities.ts` by copying the contents of `packages/core/src/framework/ast-utilities.ts` verbatim. Same exports, same behavior.
2. Re-export from `src/index.ts`:
   ```typescript
   export * from './ast-utilities.js'
   export { typescriptAdapter, adapters } from './adapter.js'
   export { parseSource } from './parse.js'
   export { stripStrings, stripComments, filterContent } from './strip.js'
   export { typescriptQuery } from './query.js'
   ```
3. Add a `getSharedSourceFile` export that delegates to the language-aware cache via the adapter:
   ```typescript
   import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'
   import { typescriptAdapter } from './adapter.js'

   export function getSharedSourceFile(filePath: string, content: string) {
     return getParseTree(typescriptAdapter, filePath, content)
   }
   ```

**Wiring:** Phase 2 Task 2.6 turns `core/src/framework/ast-utilities.ts` and `core/src/framework/parse-cache.ts` into thin re-exports of these.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-typescript build
```

**Commit:** `feat(lang-typescript): re-export legacy AST helpers for back-compat`

---

## Task 2.6: Collapse the core shims + bootstrap default registration

**Files:** [size: M]
- Modify: `packages/core/src/framework/parse-cache.ts`
- Modify: `packages/core/src/framework/ast-utilities.ts`
- Modify: `packages/core/package.json` (add `@opensip-tools/lang-typescript` as a regular dependency)
- Modify: `packages/cli/src/index.ts` (or wherever the CLI bootstraps registries — verify by grepping for `defaultRegistry`)

**Context:** Now that `lang-typescript` exists, the core shims become trivial re-exports — no more private TS cache. The CLI bootstrap explicitly registers the TS adapter at startup so existing single-package usage keeps working without the user having to install `lang-typescript` as a plugin. Other language packs (Rust, Python, etc.) are NOT bundled — they load via the `'lang'` plugin domain.

**Caveat:** This task introduces a dependency from `@opensip-tools/core` to `@opensip-tools/lang-typescript`. That's a cycle if `lang-typescript` also depends on `core`. Cycle is OK because `lang-typescript` only imports *types* from core (`LanguageAdapter` interface) — TypeScript handles type-only cycles fine at compile time, and the runtime cycle is broken by ESM hoisting. **However**, the cleaner alternative is to NOT make `core` depend on `lang-typescript` and instead have the CLI bundle do the registration. That's the recommended path. Verify by reading `packages/cli/src/index.ts` and finding the existing startup sequence.

**Steps:**

1. `packages/core/src/framework/parse-cache.ts` becomes:
   ```typescript
   export {
     getSharedSourceFile,
   } from '@opensip-tools/lang-typescript'
   export {
     initParseCache,
     clearParseCache,
   } from '../languages/parse-cache.js'
   ```
   This is a behavioral CHANGE for `getSharedSourceFile`: it now delegates to `getParseTree(typescriptAdapter, ...)` which requires the adapter to be registered. If the adapter isn't registered, the function still works (delegates to `adapter.parse` directly) but doesn't cache. The CLI bootstrap must register before any check runs.

2. `packages/core/src/framework/ast-utilities.ts` becomes:
   ```typescript
   export * from '@opensip-tools/lang-typescript/ast-utilities'
   ```

3. Add `"@opensip-tools/lang-typescript": "workspace:*"` to `packages/core/package.json` `dependencies` (or to `packages/cli/package.json` if you choose the CLI-bootstrap path).

4. In `packages/cli/src/index.ts` (verify path), at the entry point before checks register:
   ```typescript
   import { defaultLanguageRegistry } from '@opensip-tools/core/languages'
   import { typescriptAdapter } from '@opensip-tools/lang-typescript'

   defaultLanguageRegistry.register(typescriptAdapter)
   ```

5. `packages/core/package.json` still keeps `typescript` as a direct dep for now — `framework/content-filter.ts` still imports it. Phase 4 removes that. **Do not remove `typescript` from core's deps in this phase.**

**Wiring:** Every check under `packages/checks-builtin/src/checks/` that imports `getSharedSourceFile` from `@opensip-tools/core/framework/parse-cache.js` (15+ files) continues to work. Same for `import { parseSource, walkNodes } from '@opensip-tools/core/framework/ast-utilities.js'`.

**Verification:**
```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test
pnpm fit --list | head
```

If `pnpm fit` fails or `getSharedSourceFile` returns `null` unexpectedly, the bootstrap didn't register the adapter early enough. Move the registration earlier in the CLI startup.

**Commit:** `refactor(core): collapse parse-cache + ast-utilities shims to re-exports from lang-typescript`

---

## Task 2.7: Adapter tests

**Files:** [size: S]
- Create: `packages/lang-typescript/src/__tests__/adapter.test.ts`

**Context:** Cover the adapter surface end-to-end: parse, query, strip. Use real TS snippets — these tests double as documentation for what the adapter contract looks like in practice.

**Steps:**

1. `adapter.test.ts` covers:
   - `parse('const x = 1;', 'foo.ts')` returns a non-null `ts.SourceFile`
   - `parse('let x =;', 'broken.ts')` — broken source — returns a SourceFile (TS is forgiving) but parse errors live on the tree; don't assert null
   - `query.findFunctions` on `function a(){} const b = () => {}` returns two entries with names `'a'` and `null`
   - `query.findImports` on `import { x, y } from './foo'` returns one entry with `names: ['x', 'y']` and `specifier: './foo'`
   - `query.findCallsTo(tree, 'console.log')` doesn't match `console.log()` (because `findCallsTo` matches on the last segment of property access — assert it matches `findCallsTo(tree, 'log')` instead, OR change the implementation to match dotted paths)
   - `stripStrings('const x = "abc"; const y = 1')` produces a string of the same length with `"abc"` replaced by spaces, identifiers preserved
   - `stripComments('// hi\nconst x = "y"')` produces same length, both comment AND string content replaced

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

Compare `/tmp/fit-phase2.txt` against a baseline captured before Phase 2 — the set of violations reported must be identical. Any drift means the TS adapter is parsing differently from the old direct-call path.

Spot check imports in checks-builtin to confirm path stability:
```bash
grep -rn "@opensip-tools/core/framework/parse-cache\|@opensip-tools/core/framework/ast-utilities" packages/checks-builtin/src | wc -l
```
Should still be the same count as before this phase (those imports still resolve, now through the shim).
