# Phase 4: Build `RunScope` base in core

**Goal:** Add `packages/core/src/lib/run-scope.ts` exporting `RunScope` per the Phase 0 design. Constructor seams on `LanguageParseCache`, `FileCache`, `Logger`. Default singletons remain as back-compat shims. **No consumers migrated** — Phase 5 threads scope through `ToolCliContext`.

**Depends on:** Phase 1 (`Registry<T>`) is sufficient — this phase does not require Phases 2/3. **PR A bundles Phases 0 + 1 + 4** because they all add to core without touching consumers.

This phase establishes RunScope as a value type with explicit construction. Phase 5 wires it through the CLI; Phase 6 eliminates the side-effect registration paths that today require RunScope to *not* exist.

---

## Task 4.1: Confirm constructor seams exist on every singleton

**Files:**
- Read: `packages/core/src/lib/logger.ts`
- Read: `packages/core/src/languages/parse-cache.ts`
- Read: `packages/fitness/engine/src/framework/file-cache.ts`
- Read: `packages/languages/lang-typescript/src/filter.ts`

**Context:** Per Phase 0 Task 0.4, each singleton needs a constructor that doesn't rely on module-level state. Most already have a class (just used as a singleton); this task confirms and records anything that needs a refactor.

**Steps:**

1. For each file, verify a `new Foo(opts?)` constructor exists that yields a fully-functional instance without reading module globals.
2. Record findings in this task:

   | Singleton | Class exists? | Constructor signature | Action |
   |---|---|---|---|
   | `logger` | yes | `createLogger(opts?: LoggerOptions): Logger` | none — already a factory |
   | `LanguageParseCache` | yes | `new LanguageParseCache()` | none |
   | `FileCache` | yes | `new FileCache()` | drop the 10-min timer or move it to a `start()` method |
   | `lang-typescript filterCache` | no — it's a bare `Map<string, …>` | needs `class FilterCache` | refactor in this task |

3. If any singleton is a bare value (Map, object) rather than a class instance, refactor to a class in this task. The refactor preserves the value's external API; the only change is "module-level constant" → "class instance constructed in `RunScope`."

4. **FileCache 10-minute timer:** the current `setTimeout` in `fitness/engine/src/framework/file-cache.ts` auto-clears the cache after 10 minutes of inactivity. This is a per-instance lifecycle — it should fire from the instance, not from module-level state. Either: leave it in the constructor (each instance has its own timer); or move to an explicit `start()`/`stop()` that RunScope calls on `dispose()`. Pick the latter — explicit lifecycle is consistent with the rest of the design.

**Observability:** None — this task is preparatory.

**Wiring:** Each refactored singleton's public surface stays the same; only its lifecycle clarifies.

**Error cases:** If a singleton can't be cleanly constructed without globals (some side-effect at module-load that's load-bearing), document it — that's a Phase 5 / 6 escalation. None expected.

**Verification:**
```bash
pnpm typecheck
```

**Commit:** Either `refactor(lang-typescript): FilterCache as a class` (if needed) + `refactor(fitness): FileCache explicit start/stop lifecycle`, or nothing if everything is already constructor-clean.

---

## Task 4.2: Write `RunScope` source

**Files:**
- Create: `packages/core/src/lib/run-scope.ts`
- Modify: `packages/core/src/index.ts` (barrel)

**Context:** RunScope is a value type whose constructor takes all its dependencies as inputs. Lazy fields (datastore) are wrapped in thunks. Per Phase 0 Task 0.4 decision (B), `recipeCheckConfig` lives on the scope and is read via context-bound lookup, not `globalThis`.

**Steps:**

1. Write `packages/core/src/lib/run-scope.ts`:

   ```typescript
   import { AsyncLocalStorage } from 'node:async_hooks';

   import { createLogger, type Logger, type LoggerOptions } from './logger.js';
   import { LanguageParseCache } from '../languages/parse-cache.js';
   import { Registry } from './registry.js';
   import type { Tool } from '../tools/types.js';
   import type { LanguageAdapter } from '../languages/adapter.js';

   // ProjectContext stays as it is — defined in cli/project-context.ts and
   // re-exported from core. RunScope holds it but doesn't define it.
   import type { ProjectContext } from './project-context.js';

   /** Opaque slot for per-run recipe configuration (replaces globalThis Symbol). */
   export interface RecipeCheckConfigSlot {
     get<T extends Record<string, unknown>>(slug: string): T | undefined;
     set(slug: string, config: Record<string, unknown>): void;
     setAll(config: Record<string, Record<string, unknown>>): void;
     clear(): void;
   }

   class DefaultRecipeCheckConfigSlot implements RecipeCheckConfigSlot {
     private store: Record<string, Record<string, unknown>> = {};
     get<T extends Record<string, unknown>>(slug: string): T | undefined {
       return this.store[slug] as T | undefined;
     }
     set(slug: string, config: Record<string, unknown>): void {
       this.store[slug] = config;
     }
     setAll(config: Record<string, Record<string, unknown>>): void {
       this.store = { ...config };
     }
     clear(): void {
       this.store = {};
     }
   }

   /** Opaque accessor that lazily opens the datastore on first read. */
   export type DataStoreThunk = () => unknown;  // typed as unknown to keep core tool-agnostic

   export interface RunScopeOptions {
     readonly logger?: Logger;
     readonly parseCache?: LanguageParseCache;
     readonly projectContext?: ProjectContext;
     readonly datastore?: DataStoreThunk;
     readonly tools?: Registry<Tool>;
     readonly languages?: Registry<LanguageAdapter>;
   }

   /**
    * Per-invocation execution scope. Owns the lifecycle of every singleton
    * the codebase previously hung on module-level state.
    *
    * Construct exactly once per CLI invocation (or per host in SaaS mode).
    * Pass via `ToolCliContext.scope` (Phase 5).
    */
   export class RunScope {
     readonly logger: Logger;
     readonly parseCache: LanguageParseCache;
     readonly recipeCheckConfig: RecipeCheckConfigSlot;
     readonly projectContext: ProjectContext | undefined;
     readonly datastore: DataStoreThunk;
     readonly tools: Registry<Tool>;
     readonly languages: Registry<LanguageAdapter>;

     constructor(opts: RunScopeOptions = {}) {
       this.logger = opts.logger ?? createLogger();
       this.parseCache = opts.parseCache ?? new LanguageParseCache();
       this.recipeCheckConfig = new DefaultRecipeCheckConfigSlot();
       this.projectContext = opts.projectContext;
       this.datastore = opts.datastore ?? (() => {
         throw new Error('RunScope.datastore accessed without a configured thunk.');
       });
       this.tools = opts.tools ?? new Registry<Tool>({
         module: 'core:tools',
         duplicatePolicy: 'warn-first-wins',
         evtPrefix: 'tool.registry',
         logger: this.logger,
       });
       this.languages = opts.languages ?? new Registry<LanguageAdapter>({
         module: 'core:languages',
         duplicatePolicy: 'warn-first-wins',
         evtPrefix: 'lang.registry',
         logger: this.logger,
       });
     }

     /** Release per-run resources (timers, file handles, datastore). */
     dispose(): void {
       this.parseCache.clear();
       this.recipeCheckConfig.clear();
       // FileCache lifecycle is owned by the consumer (fitness); not on RunScope directly.
       // datastore close is the consumer's responsibility — RunScope doesn't open it eagerly.
     }
   }

   // ─── AsyncLocalStorage seam ──────────────────────────────────────────
   //
   // The fitness `getCheckConfig(slug)` API today reads from globalThis.
   // Phase 6 swaps that to read from this ALS — without changing any
   // check author's call site. The engine wraps the per-recipe run in
   // `runWithScope(scope, fn)`; checks call `getCheckConfig(slug)` which
   // resolves to `currentScope().recipeCheckConfig.get(slug)`.
   //
   // The "two copies of @opensip-tools/fitness loaded" hazard documented
   // at fitness/engine/src/recipes/check-config.ts:29-46 is solved by:
   //   1. ALS is per-Node-process, so both copies of fitness see the same
   //      AsyncLocalStorage *instance* exported from @opensip-tools/core.
   //   2. The check-config API reads from THAT ALS, not from a
   //      fitness-local module symbol.
   //
   // Phase 6 Task 6.2 verifies this with a two-copies smoke test.

   const scopeStorage = new AsyncLocalStorage<RunScope>();

   /** Run `fn` with `scope` bound as the current scope for everything in its dynamic extent. */
   export function runWithScope<T>(scope: RunScope, fn: () => Promise<T>): Promise<T> {
     return scopeStorage.run(scope, fn);
   }

   /** Read the current scope. Returns undefined when called outside a runWithScope. */
   export function currentScope(): RunScope | undefined {
     return scopeStorage.getStore();
   }
   ```

2. Add barrel re-exports to `packages/core/src/index.ts`:

   ```typescript
   export {
     RunScope,
     runWithScope,
     currentScope,
     type RunScopeOptions,
     type RecipeCheckConfigSlot,
     type DataStoreThunk,
   } from './lib/run-scope.js';
   ```

3. **Do NOT remove `defaultToolRegistry` / `defaultLanguageRegistry`** in this phase. They survive as back-compat shims for one minor release. Phase 5 transitions consumers; the removal is a follow-up.

**Observability:** `RunScope` itself emits no events; the logger / registries it owns emit their own.

**Wiring:** New file + barrel re-export. Other packages can `import { RunScope, runWithScope } from '@opensip-tools/core'`. No other package has been changed.

**Error cases:** `scope.datastore()` throws when called on a scope that wasn't configured with a thunk — that's a programming error caught early. `currentScope()` returns `undefined` outside a `runWithScope` block; callers that require a scope should throw with a clear message.

**Verification:**
```bash
pnpm --filter @opensip-tools/core build
pnpm --filter @opensip-tools/core typecheck
```

**Commit:** `feat(core): RunScope value type + AsyncLocalStorage seam`

---

## Task 4.3: Write `RunScope` test suite

**Files:**
- Create: `packages/core/src/lib/__tests__/run-scope.test.ts`

**Context:** Tests cover the construction contract, the dispose lifecycle, the ALS scope-binding, and the two-copies-of-fitness scenario.

**Steps:**

1. Test cases:

   ```typescript
   describe('RunScope — construction', () => {
     // - Default constructor produces a usable scope (logger, parseCache, etc. exist)
     // - Explicit logger/parseCache/projectContext passed in are stored verbatim
     // - tools/languages registries are constructed with the right policy and prefix
   });
   describe('RunScope — dispose', () => {
     // - dispose() clears parseCache and recipeCheckConfig
     // - dispose() does not throw on a never-used scope
     // - calling dispose() twice is safe (idempotent)
   });
   describe('runWithScope / currentScope', () => {
     // - currentScope() returns the bound scope inside the callback
     // - currentScope() returns undefined outside
     // - Nested runWithScope: inner overrides; outer restored after
     // - Two concurrent runWithScope chains in Promise.all do not leak (ALS guarantee)
   });
   describe('RecipeCheckConfigSlot', () => {
     // - get/set/setAll/clear round-trip
     // - get returns undefined for missing slug
     // - setAll replaces the whole map
   });
   ```

2. The "two concurrent runWithScope chains" test is the SaaS-mode invariant in miniature: two `runWithScope(scopeA, ...)` and `runWithScope(scopeB, ...)` calls in `Promise.all` must read their own `scope.recipeCheckConfig`, not interfere.

**Observability:** None.

**Wiring:** Test-only.

**Error cases:** Each `runWithScope` test that nests scopes asserts both inner and outer behave correctly; the test verifies ALS isolation under concurrency.

**Verification:**
```bash
pnpm --filter @opensip-tools/core test src/lib/__tests__/run-scope.test.ts
```

**Commit:** `test(core): RunScope construction + dispose + ALS isolation`

---

## End-of-phase verification

```bash
pnpm --filter @opensip-tools/core build
pnpm --filter @opensip-tools/core test
pnpm typecheck
pnpm lint
```

Acceptance:

- [ ] `packages/core/src/lib/run-scope.ts` exists and is exported.
- [ ] Every singleton listed in Phase 0 Task 0.4 has a working constructor seam (Task 4.1).
- [ ] The `RecipeCheckConfigSlot` interface + default implementation work.
- [ ] AsyncLocalStorage scope binding survives concurrent `runWithScope` chains (verified by test).
- [ ] No consumer has been modified — `defaultToolRegistry`, `defaultLanguageRegistry`, `fileCache`, `logger` all still work for current callers.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` all green.
