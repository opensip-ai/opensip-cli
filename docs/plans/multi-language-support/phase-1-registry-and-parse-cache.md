# Phase 1: Registry & language-aware parse cache (hard cutover)

**Goal:** Make the parse cache language-aware (keyed by `(languageId, filePath, contentFingerprint)`), wire a new `'lang'` plugin domain so language packs can be discovered and loaded the same way fitness plugins are, and replace `packages/core/src/framework/parse-cache.ts` with a re-export from the new language-aware cache. No shim, no dual cache — hard cutover.
**Depends on:** Phase 0

Task order: 1.1 (new parse-cache) → 1.2 (replace framework/parse-cache) → 1.3 (plugin domain) → 1.4 (recipe service wiring) → 1.5 (tests).

---

## Task 1.1: Implement language-aware parse cache

**Files:** [size: M]
- Create: `packages/core/src/languages/parse-cache.ts`

**Context:** The existing cache (`packages/core/src/framework/parse-cache.ts:16`) is hardcoded to `ts.createSourceFile` and keys entries by `${filePath}:${fingerprint}`. With multiple languages, the cache must include the language ID in the key, and parsing must delegate to the adapter, not call `ts.createSourceFile` directly.

Preserve the existing fingerprint approach — first 64 non-whitespace chars + length — which already differentiates filtered vs raw content correctly. Preserve the 10-minute auto-clear timer and the `.unref()` so it doesn't keep the process alive.

**Steps:**

1. Create `packages/core/src/languages/parse-cache.ts`:
   ```typescript
   /**
    * Language-aware parse cache.
    *
    * Replaces the TS-hardcoded cache at framework/parse-cache.ts. Keyed by
    * (languageId, filePath, contentFingerprint). Parsing is delegated to the
    * LanguageAdapter resolved from defaultLanguageRegistry.
    */

   import { logger } from '../lib/logger.js'

   import type { LanguageAdapter } from './adapter.js'
   import { defaultLanguageRegistry } from './registry.js'

   const AUTO_CLEAR_MS = 10 * 60 * 1000

   class LanguageParseCache {
     private readonly cache = new Map<string, unknown>()

     getOrParse<TTree>(
       adapter: LanguageAdapter<TTree>,
       filePath: string,
       content: string,
     ): TTree | null {
       const fingerprint = content.slice(0, 64).replace(/\s/g, '') + ':' + content.length
       const key = `${adapter.id}:${filePath}:${fingerprint}`
       const cached = this.cache.get(key) as TTree | undefined
       if (cached !== undefined) return cached

       const tree = adapter.parse(content, filePath)
       if (tree === null) return null
       this.cache.set(key, tree)
       return tree
     }

     clear(): void {
       this.cache.clear()
     }

     get size(): number {
       return this.cache.size
     }
   }

   let activeCache: LanguageParseCache | null = null
   let autoClearTimer: ReturnType<typeof setTimeout> | null = null

   /** Called by FitnessRecipeService.start() before check execution. */
   export function initParseCache(): void {
     activeCache = new LanguageParseCache()
     if (autoClearTimer) clearTimeout(autoClearTimer)
     autoClearTimer = setTimeout(() => {
       if (activeCache) {
         activeCache.clear()
         activeCache = null
       }
     }, AUTO_CLEAR_MS)
     autoClearTimer.unref()
   }

   /** Called by FitnessRecipeService after check execution completes. */
   export function clearParseCache(): void {
     activeCache?.clear()
     activeCache = null
     if (autoClearTimer) {
       clearTimeout(autoClearTimer)
       autoClearTimer = null
     }
   }

   /**
    * Get or parse the file under the given adapter. Falls back to a direct
    * parse if no cache is active (single-check mode).
    */
   export function getParseTree<TTree>(
     adapter: LanguageAdapter<TTree>,
     filePath: string,
     content: string,
   ): TTree | null {
     if (activeCache) {
       return activeCache.getOrParse(adapter, filePath, content)
     }
     return adapter.parse(content, filePath)
   }

   /**
    * Convenience: resolve the adapter for the file via the global registry,
    * then parse. Returns null when no adapter is registered for the extension.
    */
   export function getParseTreeForFile(filePath: string, content: string): unknown | null {
     const adapter = defaultLanguageRegistry.forFile(filePath)
     if (!adapter) {
       logger.debug({
         evt: 'lang.parse.no-adapter',
         module: 'core:languages',
         filePath,
       })
       return null
     }
     return getParseTree(adapter, filePath, content)
   }
   ```

2. Export from `packages/core/src/languages/index.ts` (extending Phase 0 Task 0.3):
   ```typescript
   export {
     initParseCache,
     clearParseCache,
     getParseTree,
     getParseTreeForFile,
   } from './parse-cache.js'
   ```

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core typecheck
```

**Commit:** `feat(core): language-aware parse cache delegating to LanguageAdapter`

---

## Task 1.2: Replace `framework/parse-cache.ts` (hard cutover)

**Files:** [size: S]
- Modify: `packages/core/src/framework/parse-cache.ts`

**Context:** 15+ checks import `getSharedSourceFile` from `@opensip-tools/core/framework/parse-cache.js`. With the hard cutover approach, this file becomes a thin re-export from the new language-aware cache. The `getSharedSourceFile` function is removed from core entirely — it will be provided by `@opensip-tools/lang-typescript` in Phase 2.

Until Phase 2 lands, the 15+ checks that import `getSharedSourceFile` will have a broken import. This is intentional — Phase 2 follows immediately and fixes all imports in one pass. If you need the build to pass between Phase 1 and Phase 2, keep a temporary `getSharedSourceFile` stub that throws `"Migrate to @opensip-tools/lang-typescript — see Phase 2"`.

**Steps:**

1. Replace `packages/core/src/framework/parse-cache.ts` with:
   ```typescript
   /**
    * Re-export from the language-aware parse cache.
    *
    * getSharedSourceFile has moved to @opensip-tools/lang-typescript.
    * Checks should import from there after Phase 2.
    */
   export {
     initParseCache,
     clearParseCache,
     getParseTree,
     getParseTreeForFile,
   } from '../languages/parse-cache.js'

   // Temporary stub — removed in Phase 2 when lang-typescript provides this.
   // Keeps the build passing between Phase 1 and Phase 2.
   import ts from 'typescript'
   export function getSharedSourceFile(filePath: string, content: string): ts.SourceFile | null {
     try {
       return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
     } catch { return null }
   }
   ```

**Wiring:** `recipes/service.ts` still calls `initParseCache`/`clearParseCache` from this file — those now forward to the language-aware cache.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/checks-builtin build && pnpm test
```

**Commit:** `refactor(core): replace parse-cache with language-aware version (hard cutover)`

---

## Task 1.3: Add `'lang'` plugin domain

**Files:** [size: S]
- Modify: `packages/core/src/plugins/types.ts`
- Modify: `packages/core/src/plugins/discover.ts`
- Modify: `packages/core/src/plugins/loader.ts`

**Context:** `PluginDomain` is currently `'fit' | 'sim' | 'asm'` at `packages/core/src/plugins/types.ts:69`. Adding `'lang'` lets language packs live under `~/.opensip-tools/lang/` or `<project>/.opensip-tools/lang/` and load through the same discovery + loader pipeline.

**Steps:**

1. In `packages/core/src/plugins/types.ts`:
   - Change `PluginDomain` to `'fit' | 'sim' | 'asm' | 'lang'`.
   - Add `LangPluginExports`:
     ```typescript
     import type { LanguageAdapter } from '../languages/adapter.js'

     export interface LangPluginExports {
       readonly adapters?: readonly LanguageAdapter[]
       readonly metadata?: PluginMetadata
     }
     ```
   - Add a `PluginExports` union: `export type PluginExports = FitPluginExports | LangPluginExports`.

2. In `packages/core/src/plugins/discover.ts`: no behavioral change needed — discovery is domain-agnostic.

3. In `packages/core/src/plugins/loader.ts`:
   - Branch on `domain === 'lang'`: cast the module to `LangPluginExports`, iterate `adapters`, call `defaultLanguageRegistry.register(adapter)`.
   - Existing branches untouched.

4. Find the CLI call site that iterates plugin domains and add `'lang'`:
   ```bash
   grep -rn "'fit', 'sim', 'asm'\|'fit','sim','asm'\|PluginDomain\[" packages/cli packages/core
   ```

**Verification:**
```bash
pnpm typecheck && pnpm --filter=@opensip-tools/core test
```

**Commit:** `feat(core): add 'lang' plugin domain for language adapter packs`

---

## Task 1.4: Wire recipe service to language-aware cache

**Files:** [size: XS]
- Modify: `packages/core/src/recipes/service.ts`

**Context:** `recipes/service.ts:266` calls `initParseCache()` and `:167` calls `clearParseCache()`. These imports come from `../framework/parse-cache.js`. Since Task 1.2 made that file a re-export, the calls already forward to the language-aware cache. Update the import to point directly to `../languages/parse-cache.js` for clarity.

**Steps:**

1. In `packages/core/src/recipes/service.ts`, change:
   ```typescript
   import { initParseCache, clearParseCache } from '../framework/parse-cache.js'
   ```
   to:
   ```typescript
   import { initParseCache, clearParseCache } from '../languages/parse-cache.js'
   ```

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core test
```

**Commit:** `refactor(core): point recipe service directly at language-aware parse cache`

---

## Task 1.5: Tests for language-aware parse cache + plugin domain

**Files:** [size: S]
- Create: `packages/core/src/languages/__tests__/parse-cache.test.ts`
- Create: `packages/core/src/plugins/__tests__/lang-domain.test.ts`

**Context:** Two test files cover the new behavior.

**Steps:**

1. `parse-cache.test.ts` covers:
   - `getParseTree` returns the same tree object on a second call (cache hit)
   - Different `adapter.id` produces different cache entries even for the same `filePath` and `content`
   - Different `content` for the same adapter+filePath misses (fingerprint dimension)
   - With no active cache, `getParseTree` still parses (delegates straight to `adapter.parse`)
   - `getParseTreeForFile` returns `null` when no adapter claims the extension
   - `clearParseCache()` zeros the cache

2. `lang-domain.test.ts` covers:
   - Loading a synthetic lang plugin that exports `{ adapters: [fakeRust] }` results in `defaultLanguageRegistry.get('rust')` returning the adapter
   - Loading a lang plugin that exports `{ checks: [...] }` (wrong shape) does NOT register checks under the lang domain

**Verification:**
```bash
pnpm --filter=@opensip-tools/core test
```

**Commit:** `test(core): cover language-aware parse cache and lang plugin domain`

---

## Phase 1 End-to-End Verification

After all five tasks:

```bash
pnpm build && pnpm typecheck && pnpm test
```

Smoke run of the existing fitness checks to confirm nothing broke:

```bash
pnpm fit --list | head
pnpm fit --recipes
```

Both must produce the same output as on `main` before the phase.
