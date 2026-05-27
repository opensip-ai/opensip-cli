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

### Registry classes (verified from source)

| # | Registry | File | Current policy | Mapped `DuplicatePolicy` | `nameCollisionMode` | Notes |
|---|---|---|---|---|---|---|
| 1 | `ToolRegistry` | `packages/core/src/tools/registry.ts` | warn-and-skip (single id key only) | `warn-first-wins` | `allow` (no name index) | Has `registerThirdParty(tool, { sourcePackage })` — absorbed into `register` per Phase 0 Task 0.2 decision (e). |
| 2 | `LanguageRegistry` | `packages/core/src/languages/registry.ts` | warn-and-skip on id-dup; extension + alias collision warn-and-skip alongside | `warn-first-wins` | `allow` (no name index — adapters do not yet carry `name`) | Adds `byExtension` + `aliasIndex` Maps. Domain-specific; lives in the thin subclass, not on base. Adapter `name` field will be derived from `id` for `Registerable` purposes (`name = id`). |
| 3 | `RecipeRegistry<T>` | `packages/core/src/recipes/registry.ts` | 3-mode via `allowOverwrite + throwOnDuplicate` flag pair | `warn-first-wins` default + per-call modulation; Phase 2 keeps the flag-pair surface for back-compat, Phase 3 removes it | `allow` | Two subclasses both write directly to its `protected byId`/`byName` for built-in seeding — **LSP violation in both FitnessRecipeRegistry AND SimulationRecipeRegistry** (the cross-cutting report listed only simulation). |
| 4 | `IdNameTagRegistry<T>` | `packages/core/src/lib/id-name-tag-registry.ts` | silent-skip on id; **throw** on name-collision (different id, same name) | `silent-skip` | `throw` | Used by simulation scenario registry. **Deleted in Phase 2.4.** |
| 5 | `CheckRegistry` | `packages/fitness/engine/src/framework/registry.ts` | silent-skip on duplicate `namespace:slug` key | `silent-skip` (id = `namespace:slug` or bare slug) | `allow` | Adds `bareSlugIndex` for ambiguous-slug resolution. Domain-specific; lives alongside the base. |
| 6 | `FitnessRecipeRegistry` | `packages/fitness/engine/src/recipes/registry.ts` | throw on duplicate (via parent's `throwOnDuplicate: true`); built-ins seeded by **direct map writes** | `throw` + `{ internal: true }` for built-ins | `allow` | LSP violation in `registerBuiltInRecipes` — same shape as simulation. Built-in seed moves to `registerAll(builtIns, { internal: true })`. |
| 7 | `TargetRegistry` | `packages/fitness/engine/src/targets/target-registry.ts` | silent-skip by name | `silent-skip` | `allow` | Targets keyed by `config.name` (no `id` field today). Migration adds `id = name` shim or treat name as id. |
| 8 | simulation scenario registry | `packages/simulation/engine/src/framework/registry.ts` | inherits `IdNameTagRegistry` | `silent-skip` + `nameCollisionMode: 'throw'` | `throw` | Wrapped in module-level functions (`getScenario`, `getScenariosByTag`, etc.) plus `clearScenarioRegistry()` for tests. |
| 9 | `SimulationRecipeRegistry` | `packages/simulation/engine/src/recipes/registry.ts` | throw on duplicate; built-ins seeded by **direct map writes** (the canonical LSP violation) | `throw` + `{ internal: true }` for built-ins | `allow` | The fix per Phase 0 Task 0.3 decision (A): `registerAll(builtInSimulationRecipes, { internal: true })`. |
| 10 | graph lang-adapter registry | `packages/graph/engine/src/lang-adapter/registry.ts` | **overwrite** (`adapters.set(adapter.id, adapter)` unconditionally per JSDoc: "Re-registering an adapter with the same `id` overwrites; that's intentional so a host application can swap an adapter in tests.") | `overwrite` | `allow` | Module-scope `const adapters = new Map<…>`. Adds `pickAdapter(cwd)` heuristics. `_clearAdaptersForTesting()` for tests. |
| 11 | graph rules registry | `packages/graph/engine/src/rules/registry.ts` | no registry — a `readonly Rule[]` constant array | n/a — not a registry | n/a | Per Phase 3.7, migrate to a real `Registry<Rule>` with `warn-first-wins`. Today there is no register API; consumers read the const array. |
| 12 | `ToolTabRegistry` (dashboard) | `packages/dashboard/src/tool-tab-registry.ts` | append-only `ToolTabDescriptor[]` via `defineToolTab`; no duplicate guard | n/a | n/a | Module-scope `const registry: ToolTabDescriptor[] = []`. Per Phase 3.8: descriptors have `{ id, label, tool, icon, badgeStyle, renderFunctionName }` — *no `name` field*. Two paths: (a) treat `id` as `name` and migrate; (b) leave as-is. **Decision: leave as-is** — it's append-only with no duplicate semantics, registration-order-sensitive (tab-bar order), and migrating buys nothing. Documented in Phase 3.8 commit. |

### Registry consumers (call-site inventory)

Production register-sites (excluding tests):

- `defaultToolRegistry`: `packages/cli/src/index.ts` (`registerFirstPartyTools`, `discoverAndRegisterToolPackages`).
- `defaultLanguageRegistry`: `packages/cli/src/index.ts` (registers TypeScript/Rust/Python/Java/Go/C++ adapters during bootstrap); `packages/core/src/languages/parse-cache.ts`, `packages/core/src/languages/content-filter-dispatch.ts` (read-only).
- `defaultRegistry` (CheckRegistry): `packages/fitness/engine/src/framework/register-helpers.ts`, `packages/fitness/engine/src/plugins/loader.ts`, `packages/fitness/engine/src/cli/fit.ts`. Check packs auto-register via `register-helpers` at module import (side effect).
- `defaultRecipeRegistry` (FitnessRecipeRegistry): `packages/fitness/engine/src/plugins/loader.ts`, `packages/fitness/engine/src/cli/{fit,list-recipes,dashboard}.ts`. Constructor seeds built-ins; test paths call `.reset()`.
- `defaultSimulationRecipeRegistry`: `packages/simulation/engine/src/plugins/loader.ts`, `packages/simulation/engine/src/cli/sim.ts`, `packages/simulation/engine/src/recipes/define-recipe.ts` (auto-registers via import side effect).
- `scenarioRegistry`: `packages/simulation/engine/src/kinds/{load,chaos,invariant,fix-evaluation}/define.ts` — each `defineXScenario` calls `scenarioRegistry.register(scenario)` at the bottom (side effect). `clearScenarioRegistry()` exported for tests.
- graph `registerAdapter`: `packages/graph/engine/src/tool.ts` and `packages/graph/graph-typescript/src/index.ts` (auto-registers TS adapter on module load).

### Module-level mutable state sites (T1)

| # | Site | File | Mutator | Notes |
|---|---|---|---|---|
| 1 | `logger` | `packages/core/src/lib/logger.ts:230-237` | `setLogLevel`, `setSilent`, `setDebugMode`, `setRunId`, `initLogFile` | Class instance, mutable via free helpers. |
| 2 | `LanguageParseCache` | `packages/core/src/languages/parse-cache.ts` | `let activeCache`; `initParseCache()`, `clearParseCache()` | |
| 3 | `defaultLanguageRegistry` | `packages/core/src/languages/registry.ts:141` | module const | |
| 4 | `defaultToolRegistry` | `packages/core/src/tools/registry.ts:78` | module const | |
| 5 | `defaultRegistry` (checks) | `packages/fitness/engine/src/framework/registry.ts:123` | module const + check-pack side-effect imports | |
| 6 | `defaultRecipeRegistry` (fitness) | `packages/fitness/engine/src/recipes/registry.ts:140` | module const + ctor side effects | |
| 7 | `defaultSimulationRecipeRegistry` | `packages/simulation/engine/src/recipes/registry.ts:77` | module const + ctor side effects | |
| 8 | `scenarioRegistry` | `packages/simulation/engine/src/framework/registry.ts:15` | module const + `defineX` import side effects | |
| 9 | graph `adapters` | `packages/graph/engine/src/lang-adapter/registry.ts:20` | module-scope Map + `registerAdapter` | |
| 10 | `fileCache` | `packages/fitness/engine/src/framework/file-cache.ts` | module const + 10-min idle timer | |
| 11 | `lang-typescript filterCache` | `packages/languages/lang-typescript/src/filter.ts:146-147` | module-scope Map + idle timer | |
| 12 | `currentProjectContext`, `datastoreCache` | `packages/cli/src/cli-context.ts:49-50` | `setProjectContextForRun` | |
| 13 | `recipeCheckConfig` via globalThis | `packages/fitness/engine/src/recipes/check-config.ts:47` | `Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')` | |

### Test plumbing exported for module-level resets

- `clearParseCache()` — `packages/core/src/languages/parse-cache.ts`
- `clearScenarioRegistry()` — `packages/simulation/engine/src/framework/registry.ts`
- `_clearAdaptersForTesting()` — `packages/graph/engine/src/lang-adapter/registry.ts`
- `reset()` — `FitnessRecipeRegistry`, `SimulationRecipeRegistry`
- `clear()` on `defaultRegistry` (checks), `defaultToolRegistry`, `defaultLanguageRegistry`
- `defineLoadScenarioWithoutRegistration`, `defineChaosScenarioWithoutRegistration`, `defineInvariantScenarioWithoutRegistration`, `defineFixEvaluationScenarioWithoutRegistration` — paired twins for tests
- (No `clearFilterCache` is exported today — the `filterCache` only has its idle-timer auto-clear. Migration removes the cache entirely.)

---

## Decisions

### D1. `Registry<T>` API + `DuplicatePolicy` union (Task 0.2)

**Closed union**:

```typescript
export type DuplicatePolicy =
  | 'warn-first-wins'   // log warning, keep incumbent      — ToolRegistry, LanguageRegistry, graph rules
  | 'throw'             // throw ValidationError on dup     — FitnessRecipeRegistry, SimulationRecipeRegistry
  | 'overwrite'         // replace incumbent silently       — graph lang-adapter registry
  | 'silent-skip'       // ignore the second registration   — CheckRegistry, TargetRegistry, scenarios
  | 'allow-internal';   // first call bypasses the guard    — reserved; today the per-call `{ internal: true }` flag covers it
```

**Base class** (exact API, locked):

```typescript
export interface Registerable {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
}

export interface RegistryOptions {
  readonly module: string;
  readonly duplicatePolicy: DuplicatePolicy;
  readonly evtPrefix: string;
  readonly validationCode?: string;
  readonly nameCollisionMode?: 'allow' | 'throw';   // default 'allow'
  readonly logger?: Logger;
}

export interface RegisterCallOptions {
  readonly internal?: boolean;       // bypass dup guard this call (built-in seeding)
  readonly sourcePackage?: string;   // included in structured event for third-party warnings
}

export class Registry<T extends Registerable> {
  constructor(opts: RegistryOptions);
  register(item: T, callOpts?: RegisterCallOptions): void;
  registerAll(items: readonly T[], callOpts?: RegisterCallOptions): void;
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

**Decision points (locked):**

- **(a) `nameCollisionMode` is orthogonal to `DuplicatePolicy`.** `IdNameTagRegistry` is silent-skip-on-id + throw-on-name-collision-with-different-id. Default `'allow'` preserves the most common contract; `'throw'` opts into the strict mode the scenario registry uses.
- **(b) `{ internal: true }` bypasses the duplicate guard for one call**, regardless of the configured policy. Used for built-in seeding. The `'allow-internal'` policy stays in the union as a forward seam (e.g. for a "register builtins without flag" mode), but **all current consumers use per-call `{ internal: true }` against a strict default**, not the `'allow-internal'` policy itself. We keep the policy in the union to avoid having to grow the union later.
- **(c) `evtPrefix` is required.** Drift-free observability: every emitted event uses `evt: '<prefix>.duplicate' | '<prefix>.registered' | '<prefix>.collision'`.
- **(d) Domain-specific indices live in subclasses or alongside, not on the base.** `LanguageRegistry`'s `byExtension`/`aliasIndex`, `CheckRegistry`'s `bareSlugIndex`, `TargetRegistry`'s scope-matching helpers, simulation's kind-filtering — all live outside the base.
- **(e) `ToolRegistry.registerThirdParty` collapses to `register(tool, { sourcePackage })`.** The `sourcePackage` is a per-call structured-log field. We keep `registerThirdParty` as a `@deprecated` alias for one minor release; new code uses `register`.

**Worked example (Tool registry):**

```typescript
// packages/core/src/tools/registry.ts
const inner = new Registry<{ id: string; name: string; tags?: readonly string[]; tool: Tool }>({
  module: 'core:tools',
  duplicatePolicy: 'warn-first-wins',
  evtPrefix: 'tool.registry',
});

inner.register(
  { id: tool.metadata.id, name: tool.metadata.name, tool, tags: tool.metadata.tags },
  { sourcePackage: '@third-party/some-tool' },
);
// On duplicate id:
//   logger.warn({
//     evt: 'tool.registry.duplicate',
//     module: 'core:tools',
//     id: 'fit',
//     name: 'fitness',
//     sourcePackage: '@third-party/some-tool',
//     msg: 'fit already registered — keeping incumbent',
//   });
```

### D2. `LanguageAdapter` `name` field (deferred decision)

`LanguageAdapter` currently has no `name` field — only `id`. To satisfy `Registerable`, the inner `Registry<>` value-type wraps the adapter with `{ id, name: id, tool: adapter }` (the `name` field shadows `id` for `Registerable` purposes). **We do not change `LanguageAdapter`** — the wrap-and-forward pattern matches `ToolRegistry`'s approach.

### D3. `SimulationRecipeRegistry` LSP fix (Task 0.3) — Decision A

`{ internal: true }` per-call. Built-in registration:

```typescript
this.registerAll(builtInSimulationRecipes, { internal: true });
```

Subsequent user registration through `register()` (no `internal` flag) follows the configured `'throw'` policy and rejects collisions.

**The same fix applies to `FitnessRecipeRegistry`** — its `registerBuiltInRecipes` writes directly to `byId`/`byName` Maps too (`packages/fitness/engine/src/recipes/registry.ts:71-74`). The cross-cutting report missed this; we caught it in Phase 0 Task 0.1's audit. **Both subclasses are fixed in Phase 3 (Tasks 3.2 and 3.4).**

The temp `protected byId`/`byName` shim in `core/recipes/registry.ts` from Phase 2 Task 2.3 must therefore remain until BOTH Tasks 3.2 and 3.4 land.

### D4. `RunScope` field set + per-singleton seams (Task 0.4)

**Fields:**

```typescript
export class RunScope {
  readonly logger: Logger;
  readonly parseCache: LanguageParseCache;
  readonly recipeCheckConfig: RecipeCheckConfigSlot;
  readonly projectContext: ProjectContext | undefined;
  readonly datastore: () => unknown;   // thunk; typed unknown to keep core tool-agnostic
  readonly tools: Registry<…>;          // Tool registry (wrapped via internal Registerable shape)
  readonly languages: Registry<…>;      // Language adapter registry (wrapped likewise)
  // Per-tool registries (checks, scenarios, fitness recipes, sim recipes,
  // graph adapters/rules) live on each Tool's own scope-accessor, not on
  // RunScope, to keep RunScope tool-agnostic.

  dispose(): void;  // parseCache.clear() + recipeCheckConfig.clear()
}
```

**Per-singleton seam plan:**

| Singleton | Seam | Action |
|---|---|---|
| `logger` | `createLogger(opts?)` factory in Phase 4 | already a class — no refactor |
| `LanguageParseCache` | already a `class` | survive as `scope.parseCache`; defaults preserved |
| `FileCache` | already a `class`; constructor sets up 10-min timer | leave timer in constructor for now — `FileCache` lifetime is NOT on `RunScope` (per Phase 4 Task 4.1 note: "FileCache lifecycle is owned by the consumer (fitness); not on RunScope directly.") |
| `currentProjectContext`, `datastoreCache` | `scope.projectContext` / `scope.datastore()` | replaced in Phase 5; the thunk preserves lazy-open |
| `recipeCheckConfig` via `Symbol.for(globalThis)` | `scope.recipeCheckConfig` (a `RecipeCheckConfigSlot`) | replaced in Phase 6 Task 6.2 via `currentScope()` ALS lookup |
| `lang-typescript filterCache` | folded into `scope.parseCache` (Phase 6 Task 6.4) | refactor `FilterCache` to a class or extend `LanguageParseCache` |
| `scenarioRegistry` | per-RunScope registry; `defineX` no longer registers | Phase 6 Task 6.1 |
| `defaultToolRegistry`, `defaultLanguageRegistry` | back-compat shims; removed in Phase 5 Task 5.4 | survive Phase 4; gone by end of Phase 5 |

### D5. `getCheckConfig` lookup mechanism — Decision B

AsyncLocalStorage (`AsyncLocalStorage<RunScope>` exported from `@opensip-tools/core`). The fitness engine wraps each per-recipe run in `runWithScope(scope, fn)`. Checks call `getCheckConfig(slug)` whose internal implementation reads `currentScope()?.recipeCheckConfig.get(slug)` — the existing `defineCheck` / `getCheckConfig(slug)` author surface is unchanged.

**Two-copies-of-fitness hazard:** both copies of `@opensip-tools/fitness` import the same `AsyncLocalStorage` instance from `@opensip-tools/core`, so the slot identity is module-bound to *core*, not to fitness. Phase 6 Task 6.2 ships a smoke test.

### D6. Out-of-scope (deliberately deferred)

- `ToolTabRegistry` (dashboard) — kept as-is. Append-only, registration-order-sensitive, no `name` field, no duplicate semantics. Phase 3.8 ships as documentation only.
- `lang-typescript filterCache` constructor seam — fold into `LanguageParseCache` adds a `filteredContent: Map<string, string>` field (Phase 6 Task 6.4). No standalone `FilterCache` class.
- `FileCache` lifecycle is NOT on RunScope. The 10-min timer stays for now; Phase 4 Task 4.1's "explicit start/stop" suggestion is deferred — `FileCache` is per-fitness, not per-RunScope, and a follow-up plan can address it without blocking T1.

### D7. Tool-specific RunScope subscopes use module augmentation (post-Phase 7 follow-up)

The flat-vs-grouped question for adding tool-specific registries to `RunScope` (e.g., simulation scenarios, graph adapters) is settled in favor of **grouped + TypeScript module augmentation**.

**Layout:**

- **Kernel concerns stay flat** at the top level of `RunScope` in `core/lib/run-scope.ts`: `logger`, `parseCache`, `recipeCheckConfig`, `projectContext`, `datastore`, `tools`, `languages`, `runId` (added by deferred Item 2).
- **Tool-specific concerns nest under the tool's name**: `scope.simulation.{scenarios, recipes}`, `scope.graph.{adapters, rules}`, future `scope.fitness.{checks, targets, recipes}` if those move to RunScope.
- **Each tool's namespace is added via TypeScript module augmentation** in the tool's own `types.ts`:

  ```typescript
  // packages/simulation/engine/src/types.ts
  declare module '@opensip-tools/core' {
    interface RunScope {
      readonly simulation?: {
        readonly scenarios: Registry<RunnableScenario>;
        readonly recipes: RecipeRegistry<SimulationRecipe>;
      };
    }
  }
  ```

  Core's `run-scope.ts` declares only the kernel fields. Each tool extends the interface from its own package — same pattern as express's `Request` augmentation.

**Why grouped:** preserves the layering rule (`core ← contracts ← {lang-*, fitness, simulation, graph}`). A flat layout (`scope.scenarios: Registry<RunnableScenario>` at the top level of `RunScope`) would force core to either (a) import simulation-shaped types — breaking the layer rule — or (b) type those fields as `unknown` and re-cast everywhere, which is the cross-cutting **T3** anti-pattern the audit flagged.

**Why module augmentation over an opaque slot:**

- Type safety preserved — `scope.simulation.scenarios` has the right type at use sites, no `unknown` cast.
- Scales gracefully — a fourth tool (e.g. future `audit`) declares its own augmentation without editing core.
- Mirrors the plugin discovery contract — packages declare `opensipTools.kind: 'sim-pack'` / `'graph-adapter'`; the RunScope namespace alignment reinforces that.

**Accepted tradeoffs:**

- Tool subscopes are optional (`scope.simulation?: { ... }`) because not every run loads every tool. A graph-only run carries no `scope.simulation`. Consumers null-check or assert.
- "Where does `scope.simulation` come from?" is mildly mysterious to readers unfamiliar with module augmentation. Mitigated by a comment in `core/lib/run-scope.ts` pointing at the augmentation pattern + JSDoc on each tool's augmentation in its `types.ts`.

**Impact on deferred items:**

- **Deferred Item 1** (`scenarioRegistry` + graph `lang-adapter` → RunScope) implements `scope.simulation = { scenarios, recipes }` and `scope.graph = { adapters, rules }` per this pattern.
- **Deferred Item 2** (`runId` → RunScope) is kernel-level (every invocation has one) — stays flat at `scope.runId`.
