# Phase 1: Registry & language-aware parse cache

**Goal:** Make the parse cache language-aware (keyed by `(languageId, filePath, contentFingerprint)`), wire a new `'lang'` plugin domain so language packs can be discovered and loaded the same way fitness plugins are, and keep `packages/core/src/framework/parse-cache.ts` as a thin compat shim so the 15+ checks importing it via `@opensip-tools/core/framework/parse-cache.js` keep working unchanged.
**Depends on:** Phase 0

Task order: 1.1 (new parse-cache) → 1.2 (compat shim) → 1.3 (plugin domain) → 1.4 (recipe service wiring) → 1.5 (tests).

---

## Task 1.1: Implement language-aware parse cache

**Files:** [size: M]
- Create: `packages/core/src/languages/parse-cache.ts`

**Context:** The existing cache (`packages/core/src/framework/parse-cache.ts:16`) is hardcoded to `ts.createSourceFile` and keys entries by `${filePath}:${fingerprint}`. With multiple languages, two adapters could legitimately produce different trees for the same file path (rare — but `.h` could be C or C++; ambiguous files exist). The cache must include the language ID in the key, and parsing must delegate to the adapter, not call `ts.createSourceFile` directly.

Preserve the existing fingerprint approach from `parse-cache.ts:24` — first 64 non-whitespace chars + length — which already differentiates filtered vs raw content correctly. Preserve the 10-minute auto-clear timer (`parse-cache.ts:62`) and the `.unref()` so it doesn't keep the process alive.

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

   const AUTO_CLEAR_MS = 10 * 60 * 1000  // matches previous behavior

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
    *
    * Generic over TTree so call sites that already know the language (e.g.
    * lang-typescript callers passing the TS adapter) get back ts.SourceFile
    * rather than unknown.
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

2. Export the new public API from `packages/core/src/languages/index.ts` (extending Phase 0 Task 0.3):
   ```typescript
   export {
     initParseCache,
     clearParseCache,
     getParseTree,
     getParseTreeForFile,
   } from './parse-cache.js'
   ```

**Wiring:** No existing caller has been switched yet — old `framework/parse-cache.ts` still owns lifecycle. Task 1.2 converts old to a shim and Task 1.4 switches `recipes/service.ts` to call the new lifecycle.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core typecheck
```

**Commit:** `feat(core): language-aware parse cache delegating to LanguageAdapter`

---

## Task 1.2: Turn `framework/parse-cache.ts` into a compat shim

**Files:** [size: S]
- Modify: `packages/core/src/framework/parse-cache.ts`

**Context:** 15+ checks import `getSharedSourceFile` from `@opensip-tools/core/framework/parse-cache.js` (e.g. `packages/checks-builtin/src/checks/architecture/di-static-inject-usage.ts:12`). We don't break those imports. Instead, the old file delegates to the new cache, **but** until Phase 2 lands the `@opensip-tools/lang-typescript` package, there's no registered TS adapter to delegate to. So the shim has a two-phase lifecycle:

- **During Phase 1** (this phase): old file keeps its own private `ts.createSourceFile` fallback. The new `initParseCache`/`clearParseCache` from `languages/parse-cache.ts` are also called (in addition to the old ones) so both caches initialize together.
- **After Phase 2**: the shim's `getSharedSourceFile` calls into the new cache with the TS adapter resolved from the registry. The old private cache is removed.

For now, complete the Phase-1 shape: forward `initParseCache` and `clearParseCache` to the new module, keep the old cache as fallback.

**Steps:**

1. Rewrite `packages/core/src/framework/parse-cache.ts` to:
   ```typescript
   /**
    * Compat shim for framework/parse-cache.ts.
    *
    * Until Phase 2 lands @opensip-tools/lang-typescript, this file retains a
    * TS-direct fallback so existing check imports keep working. The new
    * language-aware cache (core/src/languages/parse-cache.ts) is also
    * initialized alongside via re-exported init/clear functions.
    *
    * Phase 2 will reduce this file to a pure re-export.
    */

   import ts from 'typescript'

   import {
     initParseCache as initLanguageParseCache,
     clearParseCache as clearLanguageParseCache,
   } from '../languages/parse-cache.js'

   class TsParseCache {
     private cache = new Map<string, ts.SourceFile>()
     getOrParse(filePath: string, content: string): ts.SourceFile | null {
       const fingerprint = content.slice(0, 64).replace(/\s/g, '') + ':' + content.length
       const cacheKey = `${filePath}:${fingerprint}`
       const cached = this.cache.get(cacheKey)
       if (cached) return cached
       try {
         const sourceFile = ts.createSourceFile(
           filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
         )
         this.cache.set(cacheKey, sourceFile)
         return sourceFile
       } catch {
         return null
       }
     }
     clear(): void { this.cache.clear() }
     get size(): number { return this.cache.size }
   }

   let activeTs: TsParseCache | null = null
   let autoClearTimer: ReturnType<typeof setTimeout> | null = null

   export function initParseCache(): void {
     activeTs = new TsParseCache()
     if (autoClearTimer) clearTimeout(autoClearTimer)
     autoClearTimer = setTimeout(() => {
       activeTs?.clear()
       activeTs = null
     }, 10 * 60 * 1000)
     autoClearTimer.unref()
     initLanguageParseCache()
   }

   export function clearParseCache(): void {
     activeTs?.clear()
     activeTs = null
     if (autoClearTimer) { clearTimeout(autoClearTimer); autoClearTimer = null }
     clearLanguageParseCache()
   }

   export function getSharedSourceFile(filePath: string, content: string): ts.SourceFile | null {
     if (activeTs) return activeTs.getOrParse(filePath, content)
     try {
       return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
     } catch { return null }
   }
   ```

**Wiring:** The 15+ check files importing `getSharedSourceFile` from this path see no change. `recipes/service.ts:266` and `:167` still call `initParseCache`/`clearParseCache` from this file (Task 1.4 will eventually replace those calls).

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/checks-builtin build && pnpm --filter=@opensip-tools/checks-builtin test
```

**Commit:** `refactor(core): forward parse-cache init/clear to language-aware cache`

---

## Task 1.3: Add `'lang'` plugin domain

**Files:** [size: S]
- Modify: `packages/core/src/plugins/types.ts`
- Modify: `packages/core/src/plugins/discover.ts`
- Modify: `packages/core/src/plugins/loader.ts`

**Context:** `PluginDomain` is currently `'fit' | 'sim' | 'asm'` at `packages/core/src/plugins/types.ts:69`. Adding `'lang'` lets language packs live under `~/.opensip-tools/lang/` or `<project>/.opensip-tools/lang/` and load through the same discovery + loader pipeline. The plugin exports contract (`FitPluginExports`) needs a parallel `LangPluginExports` shape — a language pack exports `{ adapters: readonly LanguageAdapter[] }` instead of checks/recipes.

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

2. In `packages/core/src/plugins/discover.ts`: no behavioral change needed — discovery is domain-agnostic; the `'lang'` value passes through `getPluginDir`/`resolvePluginDir`.

3. In `packages/core/src/plugins/loader.ts`: read the file (it's not shown in earlier excerpts but exists alongside `discover.ts`) and:
   - Branch on `domain === 'lang'`: cast the module to `LangPluginExports`, iterate `adapters`, call `defaultLanguageRegistry.register(adapter)`.
   - Existing branches (`'fit'`, etc.) untouched.
   - Update `LoadedPlugin` shape if needed — add an `adaptersRegistered?: number` field. Existing fields (`checksRegistered`, `recipesRegistered`) stay; they're 0 for lang plugins.

**Wiring:** The CLI's plugin-loading entry point (in `packages/cli/src/`) already iterates domains. Adding `'lang'` to the domains it walks happens here too — find the call site that walks `'fit' | 'sim' | 'asm'` and add `'lang'`. This is one of the spots where you should grep:

```bash
grep -rn "'fit', 'sim', 'asm'\|'fit','sim','asm'\|PluginDomain\[" packages/cli packages/core
```

**Verification:**
```bash
pnpm typecheck && pnpm --filter=@opensip-tools/core test
```

**Commit:** `feat(core): add 'lang' plugin domain for language adapter packs`

---

## Task 1.4: Wire recipe service to initialize both caches

**Files:** [size: XS]
- Modify: `packages/core/src/recipes/service.ts`

**Context:** `recipes/service.ts:266` calls `void initParseCache()` and `:167` calls `void clearParseCache()`. These come from `../framework/parse-cache.js` (line 16). The Task 1.2 shim already forwards both calls to the language-aware cache, so technically no change is required here. But to keep call sites honest about which cache they're managing, this task is a documentation-only edit: add a one-line comment at each call site noting that the call also initializes the language-aware cache via the shim, and add a TODO referencing Phase 2 (after which the call can switch to the languages module directly).

**Steps:**

1. At `packages/core/src/recipes/service.ts:266`, add above the existing line:
   ```typescript
   // Also initializes the language-aware cache; the framework/parse-cache.ts shim forwards.
   // TODO(phase-2): switch to importing initParseCache from '../languages/parse-cache.js' after the TS adapter ships.
   ```
2. Same shape at `:167` for `clearParseCache`.

**Wiring:** No behavioral change.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core test
```

**Commit:** `chore(core): document parse-cache shim forwarding in recipe service`

---

## Task 1.5: Tests for language-aware parse cache + plugin domain

**Files:** [size: S]
- Create: `packages/core/src/languages/__tests__/parse-cache.test.ts`
- Create: `packages/core/src/plugins/__tests__/lang-domain.test.ts`

**Context:** Two test files cover the new behavior. Parse-cache tests verify the keying scheme — different adapters get different cache entries even for the same file path. Plugin-domain tests verify `'lang'` flows through discovery and loading without breaking the existing three domains.

**Steps:**

1. `parse-cache.test.ts` covers:
   - `getParseTree` returns the same tree object on a second call (cache hit)
   - Different `adapter.id` produces different cache entries even for the same `filePath` and `content`
   - Different `content` for the same adapter+filePath misses (fingerprint dimension)
   - With no active cache, `getParseTree` still parses (delegates straight to `adapter.parse`)
   - `getParseTreeForFile` returns `null` when no adapter claims the extension
   - `clearParseCache()` zeros the cache
2. `lang-domain.test.ts` covers:
   - Discovery walks `~/.opensip-tools/lang/` and `.opensip-tools/lang/` when present (use a temp dir fixture; mirror existing plugin tests under `packages/core/src/plugins/__tests__/`)
   - Loading a synthetic lang plugin that exports `{ adapters: [fakeRust] }` results in `defaultLanguageRegistry.get('rust')` returning the adapter
   - Loading a lang plugin that exports `{ checks: [...] }` (i.e. wrong shape) does NOT register checks under the lang domain — produces a load error captured in `LoadedPlugin.error`

**Wiring:** None.

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

Smoke run of the existing fitness checks (to confirm the shim does not break the 15+ checks importing `getSharedSourceFile`):

```bash
pnpm fit --list | head
pnpm fit --recipes
```

Both must produce the same output as on `main` before the phase. If any AST-based check (e.g. `di-static-inject-usage`) now fails to load or runs differently, the shim is broken.
