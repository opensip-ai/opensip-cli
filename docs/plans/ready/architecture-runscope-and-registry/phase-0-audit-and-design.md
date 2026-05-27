# Phase 0: Audit & Design

**Goal:** Lock in the design of `Registry<T>`, the closed `DuplicatePolicy` union, and the `RunScope` field set. No production code changes. The output is design decisions recorded in this file's "Decisions" section + a complete inventory of every registry call site and every singleton consumer.

**Depends on:** —

This phase exists to make the API decisions explicit before any code lands. Phase 1 builds the new bases; Phases 2-3 migrate consumers; Phase 4 builds RunScope; Phases 5-6 thread it through. Each of those depends on the API shapes pinned down here. Writing the API in this phase first means PR A (Phase 0 + 1 + 4) is reviewable as one design document with implementation, not "design decisions buried in code."

---

## Task 0.1: Enumerate every registry consumer + duplicate-policy site

**Files:**
- Modify: this file (`phase-0-audit-and-design.md`), the "Inventory" section below.

**Context:** The cross-cutting report lists ten registry classes but doesn't enumerate every *call site* — every `register(...)` and every `clear(...)` / `reset(...)` / `_clearXForTesting()`. Without that list, Phase 3's migration risks missing a consumer or a test reset path. Per the synthesis: "the closed `DuplicatePolicy` union must cover both honestly. Phase 0 must enumerate every existing duplicate-policy site and assign each one a named policy before Phase 1 begins."

**Steps:**

1. `grep -rn "\.register(" packages/ --include='*.ts' | grep -v '__tests__\|.test.ts'` — extract production register-sites.
2. For each registry class (11 sources):

   | Registry | File | Current policy | Mapped policy |
   |---|---|---|---|
   | `ToolRegistry` | `core/src/tools/registry.ts:20` | warn-and-skip | `warn-first-wins` |
   | `LanguageRegistry` | `core/src/languages/registry.ts:15` | warn-and-skip + alias/extension indices | `warn-first-wins` |
   | `RecipeRegistry` | `core/src/recipes/registry.ts:73` | 3-mode flag pair | (composable: see Task 0.2) |
   | `IdNameTagRegistry` | `core/src/lib/id-name-tag-registry.ts:30` | silent-skip on id; throw on name-collision | `silent-skip-id` (rename: was conflated as "silent-skip") |
   | `CheckRegistry` | `fitness/engine/src/framework/registry.ts:25` | silent-skip | `silent-skip` |
   | `FitnessRecipeRegistry` | `fitness/engine/src/recipes/registry.ts` | throw-on-duplicate by default | `throw` |
   | `TargetRegistry` | `fitness/engine/src/targets/target-registry.ts` | — record below — | TBD in Task 0.2 |
   | simulation framework registry | `simulation/engine/src/framework/registry.ts:15` | wraps `IdNameTagRegistry` | inherits |
   | `SimulationRecipeRegistry` | `simulation/engine/src/recipes/registry.ts:26` | **bypasses** parent's policy via direct map writes (LSP violation, lines 32-39) | `throw` + `allow-internal` for built-ins (see Task 0.3) |
   | graph `lang-adapter/registry` | `graph/engine/src/lang-adapter/registry.ts` | — | TBD |
   | graph `rules/registry` | `graph/engine/src/rules/registry.ts` | array push | TBD |
   | `ToolTabRegistry` (dashboard) | `dashboard/src/tool-tab-registry.ts` | — | TBD (separate shape; may stay) |

3. Fill in every TBD by reading the source and committing one of the five policies. **Do not invent a sixth policy.** If a registry doesn't fit cleanly, that's evidence the closed union needs adjustment — fold the requirement into Task 0.2 (the union design) rather than escape-hatching.

4. Record the per-consumer name-collision behaviour. `IdNameTagRegistry` throws on a name collision with a different id (`id-name-tag-registry.ts:45-51`); `RecipeRegistry` does not call that out separately. Phase 1's base must support both shapes — see Task 0.3.

**Observability:** none — read-only audit.

**Wiring:** Read-only. The output is just the table above filled in.

**Error cases:** If grep finds an unanticipated 12th registry class, document it here and add it to the table. If a consumer turns out to fit none of the five policies, that's a Task 0.2 escalation, not a Task 0.1 entry.

**Verification:**
```bash
grep -rn "extends\s\+\(IdNameTagRegistry\|RecipeRegistry\)" packages/ --include='*.ts'
grep -rn "new\s\+\(IdNameTagRegistry\|RecipeRegistry\|ToolRegistry\|LanguageRegistry\|CheckRegistry\|TargetRegistry\)" packages/
```

**Commit:** None — audit output recorded inline in this file under "Inventory" below.

---

## Task 0.2: Design `Registry<T>` API + `DuplicatePolicy` union

**Files:**
- Modify: this file, the "Decisions" section.

**Context:** Five duplicate policies in production today. The closed union must cover all five without nullable-flag pairs (the `allowOverwrite + throwOnDuplicate` design in `core/recipes/registry.ts:92-104` has a runtime guard that exists *because* the type system can't reject the contradiction — that pattern is what we're paying down).

**Steps:**

1. Draft the closed union:

   ```typescript
   export type DuplicatePolicy =
     | 'warn-first-wins'   // log warning, keep incumbent      — ToolRegistry, LanguageRegistry
     | 'throw'             // throw ValidationError on dup     — FitnessRecipeRegistry, SimulationRecipeRegistry
     | 'overwrite'         // replace incumbent silently       — current allowOverwrite: true
     | 'silent-skip'       // ignore the second registration   — CheckRegistry
     | 'allow-internal';   // first call bypasses the guard    — built-in registration (see Task 0.3)
   ```

2. Draft the base class API:

   ```typescript
   export interface Registerable {
     readonly id: string;
     readonly name: string;
     readonly tags?: readonly string[];
   }

   export interface RegistryOptions {
     readonly module: string;                     // e.g. 'core:tools', 'fitness:checks'
     readonly duplicatePolicy: DuplicatePolicy;
     readonly evtPrefix: string;                  // e.g. 'tool.registry', 'lang.registry'
     readonly validationCode?: string;            // used when policy === 'throw'
     readonly nameCollisionMode?: 'allow' | 'throw'; // default 'allow'; IdNameTagRegistry's behaviour is 'throw'
     readonly logger?: Logger;                    // explicit dependency (Task 0.4)
   }

   export class Registry<T extends Registerable> {
     constructor(opts: RegistryOptions): Registry<T>;
     register(item: T, opts?: { internal?: boolean }): void;
     registerAll(items: readonly T[], opts?: { internal?: boolean }): void;
     get(idOrName: string): T | undefined;
     getById(id: string): T | undefined;
     getByName(name: string): T | undefined;
     has(idOrName: string): boolean;
     getAll(): readonly T[];
     getByTag(tag: string): readonly T[];
     remove(id: string): boolean;
     clear(): void;
     readonly size: number;
   }
   ```

3. Decision points to lock in (record each with a one-line rationale):

   - **a)** `nameCollisionMode` is a separate axis from `DuplicatePolicy` because `IdNameTagRegistry` *silently-skips* same-id but *throws* on name-collision — it's two policies, not one. Default `'allow'` matches `RecipeRegistry`'s current behaviour.
   - **b)** `internal: true` is a per-call opt-in that lets `Registry.register(item, { internal: true })` bypass the duplicate guard when `duplicatePolicy === 'allow-internal'`. Other policies ignore the flag. This is the seam `SimulationRecipeRegistry` needs (see Task 0.3) — no protected-map-write LSP violation.
   - **c)** `evtPrefix` is required, not optional. Drift-free observability (the cross-cutting T9 finding) — every registration / duplicate event emits with a uniform shape: `evt: '<prefix>.duplicate' | '<prefix>.registered' | '<prefix>.collision'`.
   - **d)** `LanguageRegistry`'s `extension` and `alias` indices are *not* on the base — they live in a thin subclass that adds those two indices alongside. The base must not carry domain-specific fields. (Open-Closed.)
   - **e)** `ToolRegistry`'s `registerThirdParty(tool, { sourcePackage })` becomes `registry.register(tool, { sourcePackage })` — the source-package string becomes a per-call structured-log field. No second method.

4. Write a 10-line worked example in this file: a `Tool` registry using the base, showing the duplicate event payload shape.

**Observability:** Decisions recorded in this file's "Decisions" section.

**Wiring:** None yet.

**Error cases:** If decision (b) (`internal` flag on `allow-internal` policy) turns out to also be needed by a non-`allow-internal` policy, escalate — that means the design is wrong. Currently only built-in seeding needs it.

**Verification:** None — decisions are reviewed by reading.

**Commit:** None — design lives inline.

---

## Task 0.3: Settle the `SimulationRecipeRegistry` LSP fix

**Files:**
- Modify: this file, "Decisions" section.

**Context:** `simulation/engine/src/recipes/registry.ts:32-39` writes directly to its parent's `protected byId` / `byName` Maps because the parent's three-mode policy doesn't have a clean "register built-ins without the duplicate guard" mode. Phase 3 will rewrite this — but the rewrite must produce exactly the same observable behaviour:

- Built-in recipes are registered without the duplicate guard firing (preserving registration order).
- User-supplied recipes register through the normal `register()` path, throwing on duplicate id or name.
- `reset()` clears + re-registers built-ins.

**Steps:**

1. Pick the seam. Two viable options:
   - **(A)** `duplicatePolicy: 'throw'` + per-call `{ internal: true }` for built-ins. The base must define what `internal: true` means for the `'throw'` policy: "bypass the throw, register as if first writer." This generalises to `allow-internal` as a stand-alone policy meaning "default-internal" but at this site we keep the strict default-throw and override per-call for built-ins only.
   - **(B)** A protected `registerInternal()` method on the base that always bypasses the policy. Cleaner for the LSP angle; less flexible because a registry author has to opt in to writing the call site, but that's also a feature.

   **Decision: (A).** Keeps the surface to one `register()` method. The base treats `{ internal: true }` as "bypass policy this once" regardless of the configured policy — so a `'warn-first-wins'` registry author can also use it if they have a built-in seed step, without needing a second method.

2. Confirm that built-in *id collision* with a user-supplied recipe still throws. The contract is: built-ins register first via `{ internal: true }`; if a user recipe later tries to register the same id, the `'throw'` policy fires. Verified by writing the test scenario into Phase 7's verification plan.

3. The `built-in-recipes.ts` array stays. The constructor in `SimulationRecipeRegistry` calls `super.registerAll(builtInSimulationRecipes, { internal: true })` instead of writing to maps directly. (Built-in registration in a constructor is still a smell — see Task 0.4 — but the constructor-does-IO fix is independent of the LSP fix.)

**Observability:** Decision recorded inline.

**Verification:** None.

**Commit:** None.

---

## Task 0.4: Design `RunScope` field set + caches' constructor seams

**Files:**
- Modify: this file, "Decisions" section.

**Context:** T1 — process-wide mutable singletons. The synthesis lists nine sites. Phase 4 builds a `RunScope` that owns this state per-invocation; this task pins down which fields are on it and how each existing singleton gets a constructor seam.

**Steps:**

1. Enumerate the RunScope fields:

   ```typescript
   export interface RunScope {
     readonly logger: Logger;
     readonly parseCache: LanguageParseCache;
     readonly fileCache: FileCache;
     readonly recipeCheckConfig: RecipeCheckConfigSlot;
     readonly projectContext: ProjectContext | undefined;
     readonly datastore: () => DataStore;             // thunk for lazy open
     readonly registries: {
       readonly tools: Registry<Tool>;
       readonly languages: LanguageRegistry;          // thin subclass
       // Per-tool registries (checks, scenarios, fitness recipes, sim recipes,
       // graph adapters, graph rules) live on each Tool's own scope-accessor,
       // not directly on RunScope, to keep RunScope tool-agnostic.
     };
   }
   ```

2. For each singleton, decide the constructor seam:

   | Singleton | File | Seam |
   |---|---|---|
   | `logger` | `core/src/lib/logger.ts:231` | already a class instance; expose `createLogger(opts)` factory in Phase 4. |
   | `LanguageParseCache` | `core/src/languages/parse-cache.ts:108` | already `class LanguageParseCache`; current module-level `activeCache: LanguageParseCache | null` becomes RunScope-owned. |
   | `FileCache` | `fitness/engine/src/framework/file-cache.ts:210` | `class FileCache` already exists; drop `export const fileCache` once consumers thread `scope.fileCache`. |
   | `currentProjectContext`, `datastoreCache` | `cli/src/cli-context.ts:49-50` | replaced by `scope.projectContext` / `scope.datastore()`. The lazy-open is preserved via the thunk shape. |
   | `recipeCheckConfig` via `Symbol.for(globalThis)` | `fitness/engine/src/recipes/check-config.ts:47` | replaced by `scope.recipeCheckConfig`. The "two copies of fitness loaded" hazard (documented at `check-config.ts:29-46`) is solved by passing `scope` explicitly into checks via the existing `analyze` context — no globalThis slot needed. |
   | `lang-typescript filterCache` | `languages/lang-typescript/src/filter.ts:145` | folded into `scope.parseCache` (their lifetimes are identical — both keyed on file path + content hash, both cleared at end-of-run). |
   | `scenarioRegistry` | `simulation/engine/src/framework/registry.ts:15` | becomes per-RunScope; `defineX` no longer registers (Phase 6). |
   | `defaultToolRegistry`, `defaultLanguageRegistry` | `core/src/{tools,languages}/registry.ts` | survive as back-compat shims; new code uses `scope.registries.tools` / `.languages`. Removed in a follow-up minor. |

3. **Hard decision: how do checks read their config?** Checks today call `getCheckConfig(slug)` which reads `globalThis`. Two options:
   - **(A)** Pass `scope` into the check's `analyze` function as an extra parameter. Breaking for every check author.
   - **(B)** Pass `scope` into the engine's per-recipe orchestration, the engine sets `scope.recipeCheckConfig` for the duration of the run, and `getCheckConfig` reads from a *context-bound* local rather than globalThis. The `getCheckConfig` API stays — only its internal implementation changes from `globalThis` to `AsyncLocalStorage`-style scope lookup.

   **Decision: (B).** Preserves the existing `defineCheck` / `getCheckConfig(slug)` surface. The two-copies-of-fitness hazard from `check-config.ts:29-46` is addressed by making the scope-bound lookup share-by-import-resolution: even if two copies of `@opensip-tools/fitness` exist, both resolve to the same `AsyncLocalStorage` reference because the engine passes `scope` through. Phase 6 verifies this with a two-copies smoke test.

**Observability:** Decision recorded inline.

**Verification:** None.

**Commit:** None.

---

## End-of-phase verification

Phase 0 is complete when:

- [ ] The Task 0.1 table has no TBDs. Every existing registry has a named policy from the closed union (or is documented as not fitting, with a Phase 0 escalation).
- [ ] The Task 0.2 `Registry<T>` API + `DuplicatePolicy` union signatures are written out in this file's "Decisions" section.
- [ ] The Task 0.3 LSP fix decision is recorded (option A: `{ internal: true }` per-call).
- [ ] The Task 0.4 RunScope field list + per-singleton seam plan is recorded.
- [ ] No production code has been modified.

The "Decisions" section below becomes the spec PR A implements.

---

## Inventory

*(Task 0.1 fills this in during Phase 0 execution.)*

## Decisions

*(Tasks 0.2 – 0.4 fill this in during Phase 0 execution.)*
