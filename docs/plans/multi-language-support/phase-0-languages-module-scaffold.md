# Phase 0: Languages module scaffold

**Goal:** Create the `packages/core/src/languages/` module with empty interfaces, generic types, and a registry skeleton. No production code calls it yet — this phase establishes the shape so Phase 1+ can wire it in.
**Depends on:** —

Tasks within this phase can run in any order — they all create new files with no cross-references until the registry test (Task 0.4).

---

## Task 0.1: Define `LanguageAdapter` and `LanguageQueryAPI` interfaces

**Files:** [size: S]
- Create: `packages/core/src/languages/adapter.ts`
- Create: `packages/core/src/languages/generic-types.ts`

**Context:** The framework today exposes parse trees as `ts.SourceFile`. We need a parser-agnostic contract that every language pack will implement. Generic types like `Import` and `Location` exist nowhere yet; they're load-bearing for the query API that cross-language checks will use, so they ship as part of this phase.

`LanguageAdapter` carries two type parameters: `TTree` (the language's native parse tree shape, opaque to core) and `TNode` (the language's native AST node, opaque). Core code never inspects them — only passes them back to the adapter or returns them to checks.

**Steps:**

1. Create `packages/core/src/languages/generic-types.ts` with:
   ```typescript
   /** Shared types used by the cross-language query API. */

   export interface Location {
     readonly file: string
     readonly line: number      // 1-based
     readonly column: number    // 0-based
   }

   export interface Import {
     /** The import specifier as written in source (e.g. './foo', 'std::fs', '"fmt"') */
     readonly specifier: string
     /** Imported names where the language supports named imports; empty otherwise */
     readonly names: readonly string[]
     readonly location: Location
   }

   export interface GenericFunction<TNode> {
     readonly name: string | null  // null for anonymous / lambdas
     readonly location: Location
     /** The native AST node, opaque to core */
     readonly node: TNode
   }
   ```

2. Create `packages/core/src/languages/adapter.ts`:
   ```typescript
   import type { GenericFunction, Import, Location } from './generic-types.js'

   /**
    * Minimal cross-language query primitives. Each adapter implements
    * whichever of these it can support efficiently. Checks that want more
    * than the query API offers must escape to the adapter's native AST.
    */
   export interface LanguageQueryAPI<TTree, TNode> {
     findFunctions(tree: TTree): readonly GenericFunction<TNode>[]
     findImports(tree: TTree): readonly Import[]
     findCallsTo(tree: TTree, name: string): readonly TNode[]
     findStringLiterals(tree: TTree): readonly { readonly value: string; readonly location: Location }[]
     getLocation(tree: TTree, node: TNode): Location
     getText(tree: TTree, node: TNode): string
   }

   /**
    * A LanguageAdapter is the contract that every language pack implements.
    * `TTree`/`TNode` are opaque to core — passed through to checks.
    *
    * Adapters declare which file extensions they own. The registry uses
    * those to dispatch a given file to the right adapter.
    */
   export interface LanguageAdapter<TTree = unknown, TNode = unknown> {
     /** Stable identifier matched against `scope.languages` in checks and `languages:` in targets. */
     readonly id: string
     /** Lowercase extensions including the leading dot, e.g. ['.rs'] or ['.ts', '.tsx']. */
     readonly fileExtensions: readonly string[]
     /** Optional aliases — e.g. ['rs'] for Rust. Matched against legacy scope strings. */
     readonly aliases?: readonly string[]

     /** Parse a file's text into the adapter's native tree. Returns null on parse failure. */
     parse(content: string, filePath: string): TTree | null

     /**
      * Replace string literal content with whitespace of equal length, preserving
      * line/column positions. Used by checks with `contentFilter: 'strip-strings'`.
      */
     stripStrings(content: string): string

     /**
      * Replace both string literals AND comments with whitespace of equal length.
      * Used by checks with `contentFilter: 'strip-strings-and-comments'`.
      */
     stripComments(content: string): string

     /** Optional generic query layer for cross-language checks. */
     readonly query?: LanguageQueryAPI<TTree, TNode>
   }
   ```

3. Add `// @fitness-ignore-file file-length-limits -- interface module by design` only if your linter complains about file length (it shouldn't at this size).

**Wiring:** Nothing consumes these types yet. Phase 1 imports them in `registry.ts` and `parse-cache.ts`. Phase 2's `lang-typescript` package implements `LanguageAdapter<ts.SourceFile, ts.Node>`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core typecheck && pnpm build
```

**Commit:** `feat(core): scaffold LanguageAdapter + LanguageQueryAPI interfaces`

---

## Task 0.2: Implement `LanguageRegistry` skeleton

**Files:** [size: S]
- Create: `packages/core/src/languages/registry.ts`

**Context:** Mirror the shape of `CheckRegistry` in `packages/core/src/framework/registry.ts:15`. The registry has no namespacing dimension (unlike `CheckRegistry`) because language IDs are globally unique. Lookup by ID, by file path (via extension), and a `list()` for diagnostics.

**Steps:**

1. Create `packages/core/src/languages/registry.ts`:
   ```typescript
   import { extname } from 'node:path'

   import { logger } from '../lib/logger.js'

   import type { LanguageAdapter } from './adapter.js'

   /**
    * Registry of language adapters. Mirrors the shape of CheckRegistry
    * (packages/core/src/framework/registry.ts) and TargetRegistry
    * (packages/core/src/targets/target-registry.ts).
    *
    * Language IDs are globally unique — no namespace dimension.
    */
   export class LanguageRegistry {
     private readonly byId = new Map<string, LanguageAdapter>()
     private readonly byExtension = new Map<string, LanguageAdapter>()

     register(adapter: LanguageAdapter): void {
       if (this.byId.has(adapter.id)) {
         logger.debug({
           evt: 'lang.registry.duplicate',
           module: 'core:languages',
           id: adapter.id,
         })
         return
       }
       this.byId.set(adapter.id, adapter)
       for (const ext of adapter.fileExtensions) {
         const normalized = ext.toLowerCase()
         const existing = this.byExtension.get(normalized)
         if (existing && existing.id !== adapter.id) {
           logger.warn({
             evt: 'lang.registry.extension.collision',
             module: 'core:languages',
             extension: normalized,
             incumbent: existing.id,
             challenger: adapter.id,
             msg: `Extension ${normalized} already claimed by ${existing.id} — keeping incumbent`,
           })
           continue
         }
         this.byExtension.set(normalized, adapter)
       }
     }

     get(id: string): LanguageAdapter | undefined {
       return this.byId.get(id)
     }

     forFile(filePath: string): LanguageAdapter | undefined {
       const ext = extname(filePath).toLowerCase()
       if (!ext) return undefined
       return this.byExtension.get(ext)
     }

     list(): readonly LanguageAdapter[] {
       return [...this.byId.values()]
     }

     has(id: string): boolean {
       return this.byId.has(id)
     }

     get size(): number {
       return this.byId.size
     }

     clear(): void {
       this.byId.clear()
       this.byExtension.clear()
     }
   }

   /** Default global registry — language packs register here on load. */
   export const defaultLanguageRegistry = new LanguageRegistry()
   ```

**Wiring:** Nothing imports the registry yet. Phase 1 wires plugin loading to call `defaultLanguageRegistry.register(adapter)`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core typecheck
```

**Commit:** `feat(core): scaffold LanguageRegistry`

---

## Task 0.3: Barrel export and core index integration

**Files:** [size: XS]
- Create: `packages/core/src/languages/index.ts`
- Modify: `packages/core/src/index.ts`

**Context:** Other packages need a clean import path. Mirror how `targets` is exposed: a barrel `index.ts` in the subdirectory and a top-level re-export from `packages/core/src/index.ts`.

**Steps:**

1. Create `packages/core/src/languages/index.ts`:
   ```typescript
   export type { LanguageAdapter, LanguageQueryAPI } from './adapter.js'
   export type { GenericFunction, Import, Location } from './generic-types.js'
   export { LanguageRegistry, defaultLanguageRegistry } from './registry.js'
   ```

2. In `packages/core/src/index.ts`, add a re-export line near the existing `targets` re-export:
   ```typescript
   export * from './languages/index.js'
   ```

3. In `packages/core/package.json`, add a subpath export entry (mirroring the existing `./targets` entry):
   ```json
   "./languages": "./dist/languages/index.js",
   "./languages/*": "./dist/languages/*"
   ```

**Wiring:** Downstream packages now import as `import { LanguageRegistry, defaultLanguageRegistry } from '@opensip-tools/core'` or `from '@opensip-tools/core/languages'`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core typecheck
```

**Commit:** `feat(core): expose languages module via barrel + subpath export`

---

## Task 0.4: Registry unit tests

**Files:** [size: S]
- Create: `packages/core/src/languages/__tests__/registry.test.ts`

**Context:** Establish behavioral baselines for `LanguageRegistry` so Phase 1's parse-cache refactor cannot silently break dispatch.

**Steps:**

1. Create `packages/core/src/languages/__tests__/registry.test.ts` with vitest tests covering:
   - `register` + `get` round-trip by ID
   - `forFile('foo.rs')` returns the adapter that declared `.rs`
   - `forFile('foo.unknown')` returns `undefined`
   - Extension comparison is case-insensitive (`.RS` matches the same adapter as `.rs`)
   - Registering a duplicate `id` is a no-op (silent)
   - Two adapters claiming the same extension — incumbent wins; second registration is logged but its other extensions still register
   - `clear()` resets both `byId` and `byExtension`
2. Use a minimal fake adapter — no real parser:
   ```typescript
   const fakeRust: LanguageAdapter = {
     id: 'rust',
     fileExtensions: ['.rs'],
     parse: () => null,
     stripStrings: (s) => s,
     stripComments: (s) => s,
   }
   ```

**Wiring:** None — tests stand alone.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core test
```

**Commit:** `test(core): cover LanguageRegistry dispatch and collision behavior`

---

## Phase 0 End-to-End Verification

After all four tasks:

```bash
pnpm --filter=@opensip-tools/core build
pnpm --filter=@opensip-tools/core typecheck
pnpm --filter=@opensip-tools/core test
```

Expected: clean build; `languages/registry.test.ts` passes; no other package's tests change behavior; no callers of the new module exist yet.

Smoke import check (from repo root):

```bash
node -e "const c = require('./packages/core/dist/index.js'); console.log('registry:', typeof c.LanguageRegistry, 'default:', typeof c.defaultLanguageRegistry);"
```

Expected output: `registry: function default: object`.
