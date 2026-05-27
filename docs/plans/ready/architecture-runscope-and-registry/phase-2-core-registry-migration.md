# Phase 2: Migrate core registries to `Registry<T>`

**Goal:** Reimplement `ToolRegistry`, `LanguageRegistry`, `RecipeRegistry` as thin subclasses (or direct uses) of the new `Registry<T>`. Delete `IdNameTagRegistry`. Every existing consumer of these four classes keeps working with no source change at call sites.

**Depends on:** Phase 1 (the `Registry<T>` base must exist and pass tests).

This phase migrates the *kernel-owned* registries only. Phase 3 migrates tool-owned registries (fitness, simulation, graph, dashboard). Splitting the migration this way keeps each commit isolated to one ownership boundary and keeps `pnpm typecheck` green throughout.

---

## Task 2.1: Migrate `ToolRegistry`

**Files:**
- Modify: `packages/core/src/tools/registry.ts`

**Context:** `ToolRegistry` (current at `core/src/tools/registry.ts:20`) is the simplest of the four. Single-key (by id), warn-first-wins, plus a `registerThirdParty` method that adds `sourcePackage` to the structured warn event. The new base supports both via the `sourcePackage` field on `RegisterCallOptions`.

**Steps:**

1. Rewrite `packages/core/src/tools/registry.ts`:

   ```typescript
   import { Registry, type Registerable } from '../lib/registry.js';
   import type { Tool } from './types.js';

   // Tool already satisfies Registerable via metadata.id and metadata.name.
   // Define a small adapter shape so the registry can index correctly.
   interface RegisterableTool extends Registerable {
     readonly tool: Tool;
   }

   export class ToolRegistry {
     private readonly inner = new Registry<RegisterableTool>({
       module: 'core:tools',
       duplicatePolicy: 'warn-first-wins',
       evtPrefix: 'tool.registry',
     });

     register(tool: Tool, opts: { sourcePackage?: string } = {}): void {
       this.inner.register(
         { id: tool.metadata.id, name: tool.metadata.name, tool, tags: tool.metadata.tags },
         { sourcePackage: opts.sourcePackage },
       );
     }

     /** Back-compat alias. New code uses `register(tool, { sourcePackage })`. */
     registerThirdParty(tool: Tool, opts: { sourcePackage?: string } = {}): void {
       this.register(tool, opts);
     }

     list(): readonly Tool[] { return this.inner.getAll().map(r => r.tool); }
     get(id: string): Tool | undefined { return this.inner.get(id)?.tool; }
     clear(): void { this.inner.clear(); }
   }

   export const defaultToolRegistry = new ToolRegistry();
   ```

2. Verify the existing test (`packages/core/src/tools/__tests__/registry.test.ts`) still passes. The contract is unchanged.

3. Update the JSDoc header to reference `Registry<T>` and `'warn-first-wins'` rather than the prior policy description.

**Observability:** Structured event becomes `evt: 'tool.registry.duplicate'` (was already), now flowing through the base's emitter. The `sourcePackage` field is now correctly populated for first-party registers too if a caller passes it.

**Wiring:** No consumer changes. `defaultToolRegistry` keeps the same export.

**Error cases:** Same as before — duplicates are warn+skip, never throw.

**Verification:**
```bash
pnpm --filter @opensip-tools/core test src/tools/__tests__/registry.test.ts
pnpm --filter @opensip-tools/core build
```

**Commit:** `refactor(core): ToolRegistry on top of Registry<T>`

---

## Task 2.2: Migrate `LanguageRegistry`

**Files:**
- Modify: `packages/core/src/languages/registry.ts`

**Context:** `LanguageRegistry` adds two domain-specific indices (`byExtension`, `aliasIndex`) and a `canonicalize` lookup. Per Phase 0 decision (d): the base must not carry these — they stay in `LanguageRegistry` alongside the inner `Registry<T>`.

**Steps:**

1. Rewrite `packages/core/src/languages/registry.ts` so `LanguageRegistry` *contains* a `Registry<RegisterableLanguageAdapter>` and adds its own `byExtension` / `aliasIndex` Maps. Pattern is identical to Task 2.1's ToolRegistry.

2. The `LanguageAdapter` type already carries `id`, may need a `name` field added (or derive `name` from `id` if missing — check `core/src/languages/adapter.ts`). Phase 0 Task 0.1's enumeration should have flagged this; if `LanguageAdapter` lacks `name`, the migration adds it as required, and downstream lang-* packs add the field. (Small breaking change inside the workspace; no third-party adapters known.)

3. The duplicate, extension-collision, and alias-collision events keep the same `evt:` shapes (`lang.registry.duplicate`, `lang.registry.extension.collision`, `lang.registry.alias.collision`) — extension/alias collisions are emitted from `LanguageRegistry` directly, not the base.

4. `canonicalize` method stays unchanged.

**Observability:** Three event shapes preserved.

**Wiring:** No consumer changes. `defaultLanguageRegistry` keeps the same export.

**Error cases:** Same as before.

**Verification:**
```bash
pnpm --filter @opensip-tools/core test src/languages/__tests__/registry.test.ts
pnpm --filter @opensip-tools/lang-typescript build
```

**Commit:** `refactor(core): LanguageRegistry on top of Registry<T>, extension/alias indices alongside`

---

## Task 2.3: Migrate `RecipeRegistry`

**Files:**
- Modify: `packages/core/src/recipes/registry.ts`

**Context:** `RecipeRegistry`'s `allowOverwrite + throwOnDuplicate` flag pair is the *primary* user of the new `DuplicatePolicy` union. Per Phase 0 Task 0.3 decision (A), the LSP fix uses `{ internal: true }` per-call, so the recipe registry's default policy becomes `'throw'` — the configured policy is the *default behaviour*, and per-call options modulate it.

**Steps:**

1. Rewrite `packages/core/src/recipes/registry.ts`:

   ```typescript
   import { Registry, type Registerable } from '../lib/registry.js';
   import type { Logger } from '../lib/logger.js';

   export interface RecipeBase extends Registerable {
     readonly displayName: string;
     readonly description: string;
   }

   export interface RecipeRegistryOptions {
     readonly module?: string;
     readonly validationCode?: string;
     readonly logger?: Logger;
   }

   /** Per-call options preserved for back-compat with existing callers. */
   export interface RecipeRegisterOptions {
     readonly allowOverwrite?: boolean;
     readonly throwOnDuplicate?: boolean;
     readonly internal?: boolean;
   }

   export class RecipeRegistry<T extends RecipeBase> {
     protected readonly inner: Registry<T>;

     constructor(options: RecipeRegistryOptions = {}) {
       this.inner = new Registry<T>({
         module: options.module ?? 'core:recipes',
         // Default warn-first-wins matches the prior behaviour for
         // `register(recipe)` calls with no flags.
         duplicatePolicy: 'warn-first-wins',
         evtPrefix: 'recipe.registry',
         validationCode: options.validationCode ?? 'VALIDATION.RECIPE.DUPLICATE',
         logger: options.logger,
       });
     }

     register(recipe: T, opts: RecipeRegisterOptions = {}): void {
       const { allowOverwrite = false, throwOnDuplicate = false, internal = false } = opts;
       if (allowOverwrite && throwOnDuplicate) {
         throw new Error(`RecipeRegistry.register: 'allowOverwrite' and 'throwOnDuplicate' are mutually exclusive`);
       }
       // Per-call policy override via a tiny dispatch helper. Cleaner than
       // passing four flags into the base; the base's policy is a default
       // and per-call we can simulate any of the five for the *one* call.
       if (allowOverwrite) {
         this.inner.register(recipe, { internal: true });  // overwrite ≅ skip-the-guard
         return;
       }
       if (throwOnDuplicate) {
         // Construct a one-shot registry with the strict policy? Too heavy.
         // Instead, check explicitly:
         if (this.inner.has(recipe.id) || this.inner.has(recipe.name)) {
           throw new ValidationError(
             `Recipe '${recipe.name}' (${recipe.id}) already registered`,
             { code: options.validationCode ?? 'VALIDATION.RECIPE.DUPLICATE' },
           );
         }
         this.inner.register(recipe, { internal: true });
         return;
       }
       this.inner.register(recipe, { internal });
     }

     // … delegate accessors to `this.inner` …
   }
   ```

2. **Decision check:** the `allowOverwrite + throwOnDuplicate` flag pair is preserved at the *call surface* during this phase so consumers can be migrated separately in Phase 3. Once Phase 3 lands, the flag pair is removed in favour of the closed union — but the API surface stays the same until then.

3. Tests in `packages/core/src/recipes/__tests__/registry.test.ts` should still pass unchanged.

**Observability:** `recipe.registry.duplicate` event shape preserved.

**Wiring:** No consumer changes in this phase. `protected` `byId` / `byName` Maps no longer exist on the base — but `SimulationRecipeRegistry` still references them. **That is the trigger for Task 3.4 in Phase 3.** Until then, `SimulationRecipeRegistry` will fail to compile, so this task must land in the *same PR* as Task 3.4.

   To keep the per-task discipline clean: in Task 2.3 itself, add a temporary `protected readonly byId: Map<string, T>` getter on `RecipeRegistry` that just returns `this.inner.getAll()` keyed lookup — preserving the compile contract — and mark it with `@deprecated` JSDoc pointing at Phase 3 Task 3.4 for the removal.

**Error cases:** Same as before.

**Verification:**
```bash
pnpm --filter @opensip-tools/core test src/recipes/__tests__/registry.test.ts
pnpm --filter @opensip-tools/fitness build       # FitnessRecipeRegistry compiles
pnpm --filter @opensip-tools/simulation build   # SimulationRecipeRegistry compiles (via temp shim)
```

**Commit:** `refactor(core): RecipeRegistry on top of Registry<T>, temp shim for SimulationRecipeRegistry`

---

## Task 2.4: Delete `IdNameTagRegistry` and migrate its consumers

**Files:**
- Delete: `packages/core/src/lib/id-name-tag-registry.ts`
- Modify: `packages/core/src/index.ts` (remove the export)
- Modify: `packages/simulation/engine/src/framework/registry.ts` (consumer)
- Modify: `packages/core/src/lib/__tests__/id-name-tag-registry.test.ts` → rename or fold into `registry.test.ts`

**Context:** `IdNameTagRegistry` exists in two consumers:
1. The simulation framework registry wraps it for `RunnableScenario`.
2. (Possibly) test utilities — Task 0.1's grep will confirm.

The `IdNameTagRegistry` shape is `nameCollisionMode: 'throw'` + `duplicatePolicy: 'silent-skip'`. The new `Registry<T>` covers this exactly with those two option values.

**Steps:**

1. Inventory consumers — `grep -rn "IdNameTagRegistry" packages/`.
2. For each, replace `new IdNameTagRegistry('module-name')` with:

   ```typescript
   new Registry<MyItem>({
     module: 'simulation:scenarios',
     duplicatePolicy: 'silent-skip',
     evtPrefix: 'scenario.registry',
     nameCollisionMode: 'throw',
     validationCode: 'VALIDATION.REGISTRY.NAME_COLLISION',
   })
   ```

3. Delete `packages/core/src/lib/id-name-tag-registry.ts`.
4. Delete the export from `packages/core/src/index.ts`.
5. Move the existing test cases from `id-name-tag-registry.test.ts` into `registry.test.ts` as additional `describe` blocks ("with nameCollisionMode: 'throw'", "with silent-skip duplicate policy"). Delete the standalone file.

**Observability:** Events become `evt: 'scenario.registry.*'` (new prefix per the new wiring). Old `evt: 'idnametag.*'` events did not exist — `IdNameTagRegistry` only emitted via thrown errors. So this is a *new* observability surface; no change in event names that existed before.

**Wiring:** Each `IdNameTagRegistry` consumer now imports `Registry` from `@opensip-tools/core` directly.

**Error cases:** `nameCollisionMode: 'throw'` preserves the prior throw-on-name-collision contract.

**Verification:**
```bash
pnpm --filter @opensip-tools/simulation build
pnpm --filter @opensip-tools/simulation test
pnpm typecheck                              # no other consumers leak the import
grep -rn "IdNameTagRegistry" packages/      # should return zero matches
```

**Commit:** `refactor(core): delete IdNameTagRegistry, consumers use Registry<T> directly`

---

## End-of-phase verification

```bash
pnpm typecheck && pnpm test && pnpm lint
grep -rn "IdNameTagRegistry" packages/      # zero matches
```

Acceptance:

- [ ] `ToolRegistry`, `LanguageRegistry`, `RecipeRegistry` are now thin wrappers around `Registry<T>` (or contain one).
- [ ] `IdNameTagRegistry` is deleted.
- [ ] All four registries' existing consumers compile and test without changes to their call sites.
- [ ] `core` test suite ≥ 95% coverage on `registry.ts` (preserved from Phase 1).
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` all green.
- [ ] `SimulationRecipeRegistry`'s direct map writes still work via the temporary `protected byId`/`byName` shim (gets removed in Phase 3 Task 3.4).
