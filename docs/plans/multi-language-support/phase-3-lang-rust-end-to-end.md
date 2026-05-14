# Phase 3: `@opensip-tools/lang-rust` + proof check end-to-end

**Goal:** Prove the design works for a non-TypeScript language by shipping `@opensip-tools/lang-rust` (tree-sitter Rust adapter, lazy WASM grammar load) plus `@opensip-tools/checks-rust` (one "hello world" check that flags `unwrap()` calls). Run end-to-end against a `.rs` fixture. After this phase passes, the architecture is validated — Phase 5's Python/Java/Go packs are mechanical applications of this template.
**Depends on:** Phase 2

Task order: 3.1 (new packages) → 3.2 (grammar loader) → 3.3 (adapter parse + identity) → 3.4 (Rust query API) → 3.5 (Rust strip-strings/comments) → 3.6 (proof check) → 3.7 (CLI fixture + end-to-end test).

---

## Task 3.1: Create `lang-rust` and `checks-rust` packages

**Files:** [size: S]
- Create: `packages/lang-rust/package.json`, `tsconfig.json`, `src/index.ts`
- Create: `packages/checks-rust/package.json`, `tsconfig.json`, `src/index.ts`

**Context:** Two new workspace packages. `lang-rust` depends on `@opensip-tools/core` (workspace) and `web-tree-sitter` (~8 MB install but pure WASM — no native bindings). The Rust grammar WASM ships from `tree-sitter-rust` (~1.5 MB).

**Steps:**

1. `packages/lang-rust/package.json` — mirror `packages/lang-typescript/package.json` (Task 2.1) but:
   - `"name": "@opensip-tools/lang-rust"`
   - `"description": "Rust language adapter for opensip-tools (tree-sitter-based)"`
   - dependencies:
     ```json
     "dependencies": {
       "@opensip-tools/core": "workspace:*",
       "web-tree-sitter": "^0.24.0",
       "tree-sitter-rust": "^0.23.0"
     }
     ```
2. Same `tsconfig.json` pattern.
3. `packages/checks-rust/package.json`:
   - `"name": "@opensip-tools/checks-rust"`
   - `"description": "Built-in fitness checks for Rust"`
   - dependencies:
     ```json
     "dependencies": {
       "@opensip-tools/core": "workspace:*",
       "@opensip-tools/lang-rust": "workspace:*"
     }
     ```
4. `pnpm install` to register both.

**Verification:**
```bash
pnpm install && pnpm --filter=@opensip-tools/lang-rust build && pnpm --filter=@opensip-tools/checks-rust build
```

**Commit:** `feat(lang-rust,checks-rust): scaffold workspace packages`

---

## Task 3.2: Grammar loader with lazy WASM init

**Files:** [size: M]
- Create: `packages/lang-rust/src/grammar-loader.ts`

**Context:** `web-tree-sitter` requires an explicit `Parser.init()` call before use and a `Language.load(wasmBytes)` per grammar. Both are async. Initializing eagerly at module load adds ~100ms per language to cold start. Initialize lazily on first `parse()` call, then memoize. Because `parse()` in the adapter contract is sync but the underlying tree-sitter init is async, we need a strategy:

**Decision:** Make the lazy init *synchronous-after-warmup*. The CLI's bootstrap (Phase 2 Task 2.6 region) calls an exposed `warmup()` for each registered language adapter at startup, awaiting initialization before any check runs. Once warmed up, `parse()` is sync. If `parse()` is called before warmup (programmatic API misuse), it returns `null` and logs a diagnostic.

**Steps:**

1. `packages/lang-rust/src/grammar-loader.ts`:
   ```typescript
   import { readFileSync } from 'node:fs'
   import { dirname, join } from 'node:path'
   import { fileURLToPath } from 'node:url'

   import { Parser, Language } from 'web-tree-sitter'

   import { logger } from '@opensip-tools/core/logger'

   let parser: Parser | null = null
   let rustLang: Language | null = null
   let initPromise: Promise<void> | null = null

   const __filename = fileURLToPath(import.meta.url)
   const __dirname = dirname(__filename)

   /** Resolve the WASM file shipped by tree-sitter-rust. */
   function resolveWasmPath(): string {
     // tree-sitter-rust ships its WASM at <pkg>/tree-sitter-rust.wasm
     // resolve via require.resolve so pnpm hoisting is handled.
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     const path = require.resolve('tree-sitter-rust/tree-sitter-rust.wasm')
     return path
   }

   export async function warmup(): Promise<void> {
     if (initPromise) return initPromise
     initPromise = (async () => {
       await Parser.init()
       parser = new Parser()
       const wasmBytes = readFileSync(resolveWasmPath())
       rustLang = await Language.load(wasmBytes)
       parser.setLanguage(rustLang)
       logger.debug({ evt: 'lang.rust.warmup.ok', module: 'lang-rust' })
     })()
     return initPromise
   }

   export function getParser(): Parser | null {
     return parser
   }

   export function isReady(): boolean {
     return parser !== null
   }
   ```

**Wiring:** `adapter.parse` calls `getParser()`. If `null`, logs once and returns `null`. CLI bootstrap (extend Phase 2 Task 2.6) awaits `warmup()` for every registered adapter that exposes one (TS adapter does not — it's sync).

Add an optional `warmup?(): Promise<void>` to the `LanguageAdapter` interface (extend `packages/core/src/languages/adapter.ts`).

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-rust build
```

**Commit:** `feat(lang-rust): lazy WASM grammar loader with async warmup`

---

## Task 3.3: Rust adapter — parse + identity

**Files:** [size: M]
- Create: `packages/lang-rust/src/parse.ts`
- Create: `packages/lang-rust/src/adapter.ts`

**Context:** `parse()` returns `Tree | null` from tree-sitter. The native AST is `Tree`; nodes are `SyntaxNode`. These types come from `web-tree-sitter`.

**Steps:**

1. `packages/lang-rust/src/parse.ts`:
   ```typescript
   import type { Tree } from 'web-tree-sitter'

   import { getParser } from './grammar-loader.js'

   export function parseRust(content: string, _filePath: string): Tree | null {
     const parser = getParser()
     if (!parser) return null
     try {
       return parser.parse(content)
     } catch {
       return null
     }
   }
   ```
2. `packages/lang-rust/src/adapter.ts`:
   ```typescript
   import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'
   import type { Tree, SyntaxNode } from 'web-tree-sitter'

   import { parseRust } from './parse.js'
   import { stripStrings, stripComments } from './strip.js'
   import { rustQuery } from './query.js'
   import { warmup } from './grammar-loader.js'

   export const rustAdapter: LanguageAdapter<Tree, SyntaxNode> = {
     id: 'rust',
     fileExtensions: ['.rs'],
     aliases: ['rs'],
     parse: parseRust,
     stripStrings,
     stripComments,
     query: rustQuery,
     warmup,
   }

   export const adapters = [rustAdapter] as const
   ```
3. Update `src/index.ts`:
   ```typescript
   export { rustAdapter, adapters } from './adapter.js'
   export { warmup } from './grammar-loader.js'
   ```

**Wiring:** Loaded via the `'lang'` plugin domain when the user adds `@opensip-tools/lang-rust` to `.opensip-tools/lang/`. The CLI's bootstrap (Task 2.6) also awaits `warmup()` for any registered adapter that exposes one.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-rust build && pnpm --filter=@opensip-tools/lang-rust typecheck
```

**Commit:** `feat(lang-rust): Rust LanguageAdapter implementation`

---

## Task 3.4: Rust query API implementation

**Files:** [size: M]
- Create: `packages/lang-rust/src/query.ts`

**Context:** Implement `LanguageQueryAPI<Tree, SyntaxNode>` against tree-sitter. Tree-sitter exposes queries via `language.query(scm)` or via direct node traversal. For the MVP query primitives, direct traversal is sufficient and avoids learning tree-sitter's query language up-front. The tree-sitter Rust grammar uses these node types:
- Functions: `function_item` (named), `closure_expression` (anonymous)
- Imports: `use_declaration`
- Calls: `call_expression`
- String literals: `string_literal`, `raw_string_literal`

**Steps:**

1. `packages/lang-rust/src/query.ts`:
   ```typescript
   import type { Tree, SyntaxNode } from 'web-tree-sitter'

   import type {
     LanguageQueryAPI,
     GenericFunction,
     Import,
     Location,
   } from '@opensip-tools/core/languages/adapter.js'

   function walk(node: SyntaxNode, visit: (n: SyntaxNode) => void): void {
     visit(node)
     for (let i = 0; i < node.childCount; i++) {
       const child = node.child(i)
       if (child) walk(child, visit)
     }
   }

   function locationOf(tree: Tree, node: SyntaxNode): Location {
     return {
       file: '',  // tree-sitter doesn't carry the filename; callers should override
       line: node.startPosition.row + 1,
       column: node.startPosition.column,
     }
   }

   export const rustQuery: LanguageQueryAPI<Tree, SyntaxNode> = {
     findFunctions(tree) {
       const out: GenericFunction<SyntaxNode>[] = []
       walk(tree.rootNode, (n) => {
         if (n.type === 'function_item') {
           const nameNode = n.childForFieldName('name')
           out.push({
             name: nameNode?.text ?? null,
             location: locationOf(tree, n),
             node: n,
           })
         } else if (n.type === 'closure_expression') {
           out.push({ name: null, location: locationOf(tree, n), node: n })
         }
       })
       return out
     },
     findImports(tree) {
       const out: Import[] = []
       walk(tree.rootNode, (n) => {
         if (n.type === 'use_declaration') {
           // For MVP: capture the raw text of the use path as the specifier.
           // Named imports are harder to extract — leave empty for now and revisit.
           const path = n.text.replace(/^use\s+/, '').replace(/;$/, '').trim()
           out.push({
             specifier: path,
             names: [],
             location: locationOf(tree, n),
           })
         }
       })
       return out
     },
     findCallsTo(tree, name) {
       const out: SyntaxNode[] = []
       walk(tree.rootNode, (n) => {
         if (n.type === 'call_expression') {
           const fnNode = n.childForFieldName('function')
           if (!fnNode) return
           // Match on the last segment: foo::bar::baz() matches name='baz'
           const text = fnNode.text
           const lastSegment = text.split('::').pop()?.trim()
           if (lastSegment === name) out.push(n)
         }
       })
       return out
     },
     findStringLiterals(tree) {
       const out: { value: string; location: Location }[] = []
       walk(tree.rootNode, (n) => {
         if (n.type === 'string_literal' || n.type === 'raw_string_literal') {
           out.push({ value: n.text, location: locationOf(tree, n) })
         }
       })
       return out
     },
     getLocation(tree, node) {
       return locationOf(tree, node)
     },
     getText(_tree, node) {
       return node.text
     },
   }
   ```

**Wiring:** `rustAdapter.query` from Task 3.3.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-rust build
```

**Commit:** `feat(lang-rust): implement LanguageQueryAPI for Rust`

---

## Task 3.5: Rust string/comment stripping

**Files:** [size: S]
- Create: `packages/lang-rust/src/strip.ts`

**Context:** Rust has `//` and `/* */` comments (block comments nest, unlike C — tree-sitter handles this). String literals come in regular (`"foo"`), raw (`r"foo"`, `r#"foo"#`), byte (`b"foo"`), and byte-raw (`br#"foo"#`) flavors.

For the MVP, the cleanest implementation uses the parse tree itself: walk it, find string and comment nodes, replace those byte ranges with whitespace. This guarantees correctness without re-implementing a Rust lexer in regex.

**Steps:**

1. `packages/lang-rust/src/strip.ts`:
   ```typescript
   import { parseRust } from './parse.js'

   const STRING_NODES = new Set(['string_literal', 'raw_string_literal'])
   const COMMENT_NODES = new Set(['line_comment', 'block_comment'])

   function replaceRanges(content: string, ranges: readonly [number, number][]): string {
     if (ranges.length === 0) return content
     const buf = content.split('')
     for (const [start, end] of ranges) {
       for (let i = start; i < end; i++) {
         if (buf[i] !== '\n') buf[i] = ' '
       }
     }
     return buf.join('')
   }

   function collectRanges(content: string, types: Set<string>): [number, number][] {
     const tree = parseRust(content, '<strip>')
     if (!tree) return []
     const ranges: [number, number][] = []
     const walk = (n: any): void => {
       if (types.has(n.type)) ranges.push([n.startIndex, n.endIndex])
       for (let i = 0; i < n.childCount; i++) {
         const c = n.child(i)
         if (c) walk(c)
       }
     }
     walk(tree.rootNode)
     return ranges
   }

   export function stripStrings(content: string): string {
     return replaceRanges(content, collectRanges(content, STRING_NODES))
   }

   export function stripComments(content: string): string {
     const both = new Set([...STRING_NODES, ...COMMENT_NODES])
     return replaceRanges(content, collectRanges(content, both))
   }
   ```

   **Note:** `stripStrings` and `stripComments` here use the parse tree, which requires `warmup()` to have already run. If called pre-warmup, both return the original content unchanged (graceful degradation). Document this in the file header.

**Wiring:** `rustAdapter.stripStrings` and `.stripComments` (Task 3.3).

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-rust test
```

**Commit:** `feat(lang-rust): strip-strings/comments via parse tree`

---

## Task 3.6: Proof check — `no-unwrap`

**Files:** [size: S]
- Create: `packages/checks-rust/src/checks/no-unwrap.ts`
- Modify: `packages/checks-rust/src/index.ts`

**Context:** A trivial check that flags `.unwrap()` and `.expect()` calls in Rust source. Demonstrates:
1. A check declares `scope.languages: ['rust']` and is dispatched to `.rs` files.
2. The check accesses the Rust parse tree via the framework's parse cache (using the Rust adapter).
3. The check returns violations whose line/column come from tree-sitter positions.

This check uses the native AST (not the query API) because matching `.unwrap()` is a Rust-specific pattern. That's the intended escape hatch for power users.

**Steps:**

1. `packages/checks-rust/src/checks/no-unwrap.ts`:
   ```typescript
   import { defineCheck, type CheckViolation } from '@opensip-tools/core'
   import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'
   import { rustAdapter } from '@opensip-tools/lang-rust'

   const FLAGGED = new Set(['unwrap', 'expect'])

   export const noUnwrap = defineCheck({
     id: 'b1c2d3e4-f5a6-7890-abcd-ef0123456789',
     slug: 'rust-no-unwrap',
     description: 'Disallow .unwrap() / .expect() outside tests — prefer ? or explicit match',
     scope: { languages: ['rust'], concerns: ['backend'] },
     tags: ['quality', 'rust'],
     fileTypes: ['.rs'],
     analyze: (content, filePath) => {
       if (filePath.includes('/tests/') || filePath.endsWith('_test.rs')) return []
       const tree = getParseTree(rustAdapter, filePath, content)
       if (!tree) return []

       const violations: CheckViolation[] = []
       const walk = (n: any): void => {
         if (n.type === 'call_expression') {
           const fn = n.childForFieldName('function')
           if (fn && fn.type === 'field_expression') {
             const fieldName = fn.childForFieldName('field')?.text
             if (fieldName && FLAGGED.has(fieldName)) {
               violations.push({
                 line: n.startPosition.row + 1,
                 column: n.startPosition.column,
                 message: `Avoid .${fieldName}() in production Rust — use ? or explicit match`,
                 severity: 'warning',
                 suggestion: 'Replace with the ? operator or an explicit match on Result/Option',
               })
             }
           }
         }
         for (let i = 0; i < n.childCount; i++) {
           const c = n.child(i)
           if (c) walk(c)
         }
       }
       walk(tree.rootNode)
       return violations
     },
   })
   ```
2. `packages/checks-rust/src/index.ts`:
   ```typescript
   import { noUnwrap } from './checks/no-unwrap.js'

   export const checks = [noUnwrap] as const
   export { noUnwrap }
   ```

**Wiring:** The CLI's plugin loader walks the `'lang'` domain (Phase 1) AND any check packs declared elsewhere. `@opensip-tools/checks-rust` is loaded via the `'fit'` plugin domain — same as `@opensip-tools/checks-builtin`. For the proof-of-concept run we register it explicitly in a CLI fixture script (Task 3.7).

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-rust build
```

**Commit:** `feat(checks-rust): no-unwrap proof check`

---

## Task 3.7: End-to-end CLI run against a Rust fixture

**Files:** [size: S]
- Create: `packages/cli/__fixtures__/multi-lang/sample.rs`
- Create: `packages/cli/__fixtures__/multi-lang/opensip-tools.config.yml`
- Create: `packages/cli/src/__tests__/multi-lang-rust.test.ts`

**Context:** Prove the wiring works end-to-end. The fixture has one `.rs` file with two `unwrap()` calls. The config declares a `rust` target. The integration test:
1. Registers `typescriptAdapter` and `rustAdapter` against `defaultLanguageRegistry`.
2. Awaits `rustAdapter.warmup()`.
3. Registers the `noUnwrap` check against `defaultRegistry`.
4. Invokes the CLI's `fit` command pointed at the fixture.
5. Asserts that the output contains two violations on the expected lines.

**Steps:**

1. `packages/cli/__fixtures__/multi-lang/sample.rs`:
   ```rust
   fn main() {
       let x = std::fs::read_to_string("foo").unwrap();
       let y: i32 = "42".parse().expect("bad input");
       println!("{} {}", x, y);
   }
   ```
2. `packages/cli/__fixtures__/multi-lang/opensip-tools.config.yml`:
   ```yaml
   targets:
     rust-sources:
       description: Rust source files
       languages: [rust]
       concerns: [backend]
       include: ["**/*.rs"]
   ```
3. `packages/cli/src/__tests__/multi-lang-rust.test.ts`:
   - vitest test that imports the registry, registers both adapters, awaits warmup, registers the check, runs the fit pipeline against the fixture path, asserts two violations at expected lines (2 and 3).

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli test
```

**Commit:** `test(cli): end-to-end Rust fitness check against fixture`

---

## Phase 3 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test
```

Manual smoke run from a temp dir containing only `sample.rs` + `opensip-tools.config.yml`:

```bash
mkdir /tmp/rust-smoke && cd /tmp/rust-smoke
cp /Users/sb/Documents/Code/opensip-ai/opensip-tools/packages/cli/__fixtures__/multi-lang/sample.rs .
cp /Users/sb/Documents/Code/opensip-ai/opensip-tools/packages/cli/__fixtures__/multi-lang/opensip-tools.config.yml .
mkdir -p .opensip-tools/lang/node_modules
cd .opensip-tools/lang && pnpm init -y && pnpm add @opensip-tools/lang-rust
# Then run from /tmp/rust-smoke:
opensip-tools fit
```

Expected: report shows `rust-no-unwrap` triggered twice on `sample.rs:2:46` and `sample.rs:3:33`.

If the warmup race condition fires (parse tree is `null` because warmup didn't complete before checks ran), the bootstrap is wrong — Task 3.2's note about CLI-bootstrap `await warmup()` was skipped or in the wrong place.
