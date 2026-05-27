# Architecture audit — core

**Date:** 2026-05-27
**Scope:** packages/core
**Auditor:** Claude

## Summary

`@opensip-tools/core` is generally a healthy kernel: layering is enforced, third-party imports are zero, and the public surface is intentional. The standout architectural debt is **registry-pattern fragmentation** — four near-parallel registries (`ToolRegistry`, `LanguageRegistry`, `RecipeRegistry`, `IdNameTagRegistry`) re-implement variants of "Map + duplicate policy + structured warning," each with slightly different semantics. Secondary themes: a few abstractions in `tools/types.ts` are deliberately loosened to `unknown` to avoid a layer-up dependency, which is the right trade-off but pushes type-safety responsibility onto every consumer; mutable global singletons (logger, parse cache, default registries) are pragmatic but leak process-wide state into a kernel that otherwise reads as pure; and `Signal` lives in `core` despite being a tool-output shape that's a stretch for "kernel."

## Findings

### F1 — Four parallel registries with diverging duplicate policies

- **Files:** `src/tools/registry.ts`, `src/languages/registry.ts`, `src/recipes/registry.ts`, `src/lib/id-name-tag-registry.ts`
- **Principle/Pattern:** DRY / Strategy (missing) / GoF: Registry (multiple, inconsistent variants)
- **Status:** Problematic
- **Evidence:**
  - `ToolRegistry` (tools/registry.ts:28-40): first-writer-wins, warn, never throws.
  - `LanguageRegistry` (languages/registry.ts:25-38): first-writer-wins, warn, plus secondary alias/extension indices with their own collision policies (lines 40-91).
  - `RecipeRegistry` (recipes/registry.ts:92-138): first-writer-wins-by-default, but accepts both `allowOverwrite` and `throwOnDuplicate` options that are mutually exclusive (line 94) — a 3-mode policy strategy embedded in flags.
  - `IdNameTagRegistry` (lib/id-name-tag-registry.ts:39-55): silent skip on id-dup; **throws** ValidationError on name-collision. Different again.
- **Why it matters:** Every new registry-like consumer must re-decide which of four templates to copy. The "first writer wins, log a `<x>.registry.duplicate` warning" boilerplate is duplicated four times, and the divergence (throw vs. warn vs. silent) is documented but not encoded — a callsite reading `register(x)` cannot tell from the signature whether it might throw. New tools (audit, lint, bench) will paste a fifth variant.
- **Recommendation:** Extract one generic `Registry<T extends Identifiable>` base (or a `DuplicatePolicy` Strategy: `'warn-first-wins' | 'throw' | 'overwrite'`) that owns the Map, the warn/throw branch, and the structured-event emission. Have `ToolRegistry`, `LanguageRegistry`, etc. extend it and add only their domain-specific indices (extension, alias, tag). `IdNameTagRegistry` and `RecipeRegistry` already represent two attempted generalisations and the comments at `id-name-tag-registry.ts:5-12` acknowledge the duplication — finish the consolidation instead of having two "common ancestors."

### F2 — `Tool.register(cli)` contract carries `unknown` for the most important fields

- **Files:** `src/tools/types.ts:99-183`
- **Principle/Pattern:** ISP (Interface Segregation) / leaky abstraction
- **Status:** Problematic (deliberate but worth revisiting)
- **Evidence:**
  ```ts
  readonly program: unknown;       // line 104 — Commander program
  readonly datastore: unknown;     // line 182 — DataStore from @opensip-tools/datastore
  readonly render: (result: unknown) => Promise<void>;  // line 122
  readonly renderLive: (key: string, args: unknown) => Promise<void>;  // line 146
  ```
  The doc comments instruct every tool to runtime-cast: `"Tools cast to DataStore from @opensip-tools/datastore at use time"` (line 180). `LiveViewRenderer = (args: unknown) => Promise<void>` (line 65) likewise pushes typing into a tool-local cast.
- **Why it matters:** The whole point of the Tool contract is to decouple tools from CLI / datastore; the typing here achieves decoupling at the cost of safety. Every tool implementation re-asserts these casts, and a Commander or DataStore breaking change won't surface at the contract; it surfaces at every cast site simultaneously. The justification in the docs ("don't pin every tool to a specific Commander major version") is real, but the same effect is achievable with a generic parameter or a narrow structural type.
- **Recommendation:** Make `ToolCliContext` generic in the program/datastore types: `interface ToolCliContext<TProgram = unknown, TDataStore = unknown>`. Tools that want safety declare `Tool<Command, DataStore>`; tools that want to stay loose use the defaults. Alternatively, define minimal structural interfaces in `core` (e.g. `interface MinimalCommanderProgram { command(name: string): MinimalCommanderProgram; ... }`) that capture only the methods the contract requires. Either move pushes the loosening from "always" to "opt-in."

### F3 — Mutable process-wide singletons reach into the kernel

- **Files:** `src/lib/logger.ts:230-256`, `src/languages/parse-cache.ts:108-157`, `src/languages/registry.ts:141`, `src/tools/registry.ts:78`
- **Principle/Pattern:** SRP / anti-pattern: Service Locator / Singleton over-use
- **Status:** Problematic
- **Evidence:** `logger` is a `LoggerImpl()` constructed at module load (line 230) and mutated by free functions (`setLogLevel`, `setDebugMode`, etc.). Every registry in core imports it directly (`tools/registry.ts:16`, `languages/registry.ts:3`, `recipes/registry.ts:30`). `defaultLanguageRegistry`, `defaultToolRegistry`, the parse-cache `activeCache` (parse-cache.ts:108) follow the same pattern. The author acknowledges the pain — `LoggerImpl` is "advanced / discouraged for general use" (line 56) and tests are told to `new LoggerImpl()` — but production code has no DI seam.
- **Why it matters:** The kernel reads as pure-ish (each module re-imports `logger`), but the runtime behaviour is "Configuration happens via free-function side effects on a module-load singleton." Tests have to remember to reset state; embedded/SaaS usage (per the global preferences in CLAUDE.md, "all features must work in both embedded and SaaS modes") cannot run two opensip-tools sessions in the same process with different log levels. Service Locator is a known smell precisely because it hides dependencies — `ToolRegistry.register` reads as a pure setter but writes to a global log singleton.
- **Recommendation:** Two-step path:
  1. Pass `Logger` explicitly into the registries' constructors (`new ToolRegistry({ logger })`), falling back to the singleton when omitted. Today's call sites don't change; tests/embedders get an opt-in seam.
  2. Same for `LanguageParseCache` (it's already half-way there — the `LanguageParseCache` class is constructible; the module-level `activeCache` is the wart). Have `getParseTree` accept an optional `cache?: LanguageParseCache` parameter so callers can scope.
  The "process-wide" registries (`defaultToolRegistry`, `defaultLanguageRegistry`) can stay as convenience exports.

### F4 — `Signal` and `createSignal` live in `core` despite being a tool-output shape

- **Files:** `src/types/signal.ts`, `src/types/index.ts`, re-exported from `src/index.ts:2-3`
- **Principle/Pattern:** "Kernel-shape" boundary (per CLAUDE.md: "Nothing fitness-shaped, graph-shaped, or CLI-shaped belongs in core")
- **Status:** Problematic (borderline)
- **Evidence:** `Signal` (signal.ts:9-29) carries `severity: 'critical' | 'high' | 'medium' | 'low'`, `category: 'security' | 'quality' | ...`, `ruleId`, `fixAction`, `fixConfidence`, `fingerprint` — these are the canonical fields of a fitness/graph **finding**. The file's own header (line 2): _"Signal type — compatible with OpenSIP's signal format. Used by the check framework internally."_ Consumers are fitness, simulation, and graph (e.g. `graph/engine/src/gate.ts:14`); not used by anything that is itself kernel-shaped.
- **Why it matters:** This is exactly the "domain-shaped code in the kernel" the CLAUDE.md guidance warns against. Today every Tool depends on Signal because Signal is in core — but conceptually, Signal is the cross-tool result format, which is what `@opensip-tools/contracts` exists for (it already houses `FindingOutput`, `CliOutput`, etc.). Putting Signal in core means a future Tool that doesn't emit findings (e.g. `bench`, `audit` with structured-report-only) still pulls in the type, and core becomes the union of "things any tool happens to need" rather than a true kernel.
- **Recommendation:** Move `Signal` and `createSignal` to `@opensip-tools/contracts`. The layer rule is `core ← contracts ← tools`, so tools that need Signal import from contracts instead. Update the doc comment to match — "the cross-tool finding shape" is a contract, not a kernel primitive. If a kernel primitive really is needed (the `randomUUID` slice id at line 55 is core-ish), keep it as a separate private helper.

### F5 — `RecipeRegistry` flag combinatorics: `allowOverwrite` and `throwOnDuplicate` are an in-band Strategy

- **Files:** `src/recipes/registry.ts:42-138`
- **Principle/Pattern:** OCP (option-flags-as-strategy) / replace conditional with Strategy
- **Status:** Problematic
- **Evidence:** `register(recipe, options)` accepts `allowOverwrite` and `throwOnDuplicate`; the body has to runtime-guard mutual exclusion (line 94-104) and branch four ways (overwrite, throw, warn-first-wins, plain insert). The class doc lists "warn-and-skip-vs-throw-vs-overwrite" as three modes, but they reach the call site as two boolean flags.
- **Why it matters:** Booleans don't compose. The mutual-exclusion guard exists precisely because the type system can't catch `{ allowOverwrite: true, throwOnDuplicate: true }`. A new mode ("overwrite-with-warning") would require a third flag and another runtime guard.
- **Recommendation:** Replace the two booleans with a closed `DuplicatePolicy = 'warn-first-wins' | 'throw' | 'overwrite'` discriminated union (or a Strategy interface if behaviour beyond the duplicate decision varies). The registry constructor sets the default; per-call override is `{ policy: 'overwrite' }`. Same shape would be reusable for the consolidation in F1.

### F6 — `IdNameTagRegistry` and `RecipeRegistry` are sibling implementations of the same idea

- **Files:** `src/lib/id-name-tag-registry.ts`, `src/recipes/registry.ts`
- **Principle/Pattern:** DRY / Refused Bequest (sibling generalisations)
- **Status:** Problematic
- **Evidence:** The header of `id-name-tag-registry.ts:5-12` describes itself as the "smaller common ancestor" of `LanguageRegistry`, `ToolRegistry`, and the simulation scenario registry. `recipes/registry.ts:6-26` describes itself as the **other** common ancestor for fitness + simulation **recipe** registries. They both store `id + name`, both expose `byId`/`byName` Maps, both implement tag filtering, both expose `loadRecipe` / `get`. The differences (`displayName + description` requirement; multi-mode duplicate policy) are not load-bearing — they're metadata you could push to `T`'s shape and to a `DuplicatePolicy` option.
- **Why it matters:** Two near-identical generics where one would do. The README of each acknowledges the other; neither has subsumed it. A new consumer must decide which "common ancestor" to subclass — exactly the choice the abstraction was supposed to eliminate.
- **Recommendation:** Pick one. Promote `RecipeRegistry<T extends { id; name; tags? }>` (drop the displayName/description requirement — they belong to the type parameter T) and delete `IdNameTagRegistry`, or vice versa. The duplicate-policy work from F5 dovetails with this consolidation.

### F7 — `parse-cache.ts` mixes a per-instance Cache and a hidden module-level state machine

- **Files:** `src/languages/parse-cache.ts:108-157`
- **Principle/Pattern:** SRP, hidden state
- **Status:** Problematic
- **Evidence:** `initParseCache()` (line 111) replaces a module-level `activeCache`. `getParseTree()` (line 131) checks `if (activeCache)` and falls back to a raw `adapter.parse` when no cache is active. The class itself is well-formed; the module-level `let activeCache: LanguageParseCache | null = null` (line 108) is a stateful flag that production code mutates implicitly.
- **Why it matters:** Two access paths (`new LanguageParseCache()` vs. free functions) means tests and tools that legitimately want isolation must remember to **not** call `initParseCache()`. The `getParseTreeForFile` (line 146) has no way to use a non-default cache. Same shape as the logger singleton (F3), same class of problem.
- **Recommendation:** Have `getParseTree` accept the cache as a parameter (defaulting to the module singleton); have `getParseTreeForFile` likewise. The module-level state stays as a default but is no longer the only path. Eventually fold parse-cache lifecycle management into `ToolCliContext` so each CLI invocation owns its cache.

### F8 — `plugins/types.ts` `PluginExports` union is a sentinel for "open-bag" typing

- **Files:** `src/plugins/types.ts:33-38`
- **Principle/Pattern:** ISP / honest types
- **Status:** Problematic
- **Evidence:**
  ```ts
  export type PluginExports = LangPluginExports | Record<string, unknown>
  ```
  The `Record<string, unknown>` arm makes the union meaningless — anything assigns to it. The comment (line 35-37) acknowledges this is intentional: "kept open so tool-specific exports (e.g. fitness's FitPluginExports) can be assigned through structural compatibility."
- **Why it matters:** The type is a documentation artefact, not a constraint — every consumer immediately narrows via `if ('recipes' in mod)`. A reviewer reading `PluginExports` cannot tell what a plugin actually exports; the dynamic check is the real contract.
- **Recommendation:** Drop the alias. Where you would have typed `PluginExports`, type the parameter as `Record<string, unknown>` directly and let domain-specific loaders narrow (which they already do). The type alias is currently doing nothing the parameter type doesn't, and it implies a constraint that doesn't exist.

### F9 — `loadPlugin` returns an opaque `RegisterCounts` record where a typed result would be safer

- **Files:** `src/plugins/loader.ts:57-63`, `src/plugins/loader.ts:113-153`
- **Principle/Pattern:** Stable interface, OCP
- **Status:** Problematic
- **Evidence:**
  ```ts
  export interface RegisterCounts {
    readonly checksRegistered?: number
    readonly recipesRegistered?: number
    readonly adaptersRegistered?: number
    readonly scenariosRegistered?: number
  }
  ```
  Four optional fields, one per domain known today (fit, sim, lang). The `loadAllPlugins` rollup (lines 205-208) hard-codes the same four counters. Adding a fifth domain (graph rules?) requires touching the kernel.
- **Why it matters:** Counts are domain-specific; the kernel shouldn't know them. The "scenarios" / "checks" naming leaks the existence of fitness and simulation into a "generic plugin loader" abstraction.
- **Recommendation:** Replace with a generic counter map: `RegisterCounts = Readonly<Record<string, number>>`. The domain-specific roll-up moves up to the tool — each tool's plugin-loading site knows its own counters. The "totalChecks" / "totalRecipes" rollup either becomes per-tool or becomes a generic `totals: Record<string, number>` aggregator.

### F10 — Logger `info`/`debug`/`warn`/`error` accept both `(string, data)` and `({ ...obj })` overloads

- **Files:** `src/lib/logger.ts:35-40, 136-150`
- **Principle/Pattern:** ISP / honest interfaces
- **Status:** Problematic (mild)
- **Evidence:** Every level accepts `msgOrObj: string | Record<string, unknown>`. The `formatEntry` body (line 153) branches on `typeof`. Every callsite in core uses the object form (`logger.warn({ evt, module, ... })`), but the string overload remains.
- **Why it matters:** Two ways to do the same thing. The structured-log discipline ("`evt: '...'` field on every record") is convention, not type — a careless caller could `logger.warn('something happened')` and bypass the structured log without diagnostic. The overload also forces every implementation to runtime-branch.
- **Recommendation:** Drop the string-first overload. Force `logger.warn({ msg, ...fields })` everywhere; if the `msg` field is the only thing a caller wants, that's a 2-character cost. The type then enforces what the convention currently encodes only in code review.

### F11 — `ToolErrorOptions` is an open-ended record with no schema

- **Files:** `src/lib/errors.ts:27-30`
- **Principle/Pattern:** Honest types
- **Status:** Problematic (mild)
- **Evidence:**
  ```ts
  export interface ToolErrorOptions extends ErrorOptions {
    code?: string;
    [key: string]: unknown;   // line 29 — open bag
  }
  ```
  The index signature lets callers pass anything (`{ operation: 'resolve', loader: 'project-config' }` at config-resolution.ts:76) — none of these reach any code path. They're documentation parameters.
- **Why it matters:** A `loader: 'project-config'` field that never reaches `ToolError`'s state suggests these fields are meaningful; they're not. Either capture them on the error (so logging can surface them) or remove the open bag.
- **Recommendation:** Promote known fields (`operation`, `loader`, `domain`) to explicit optional properties on `ToolErrorOptions` and store them on the error instance. Drop the index signature, or rename it `metadata: Record<string, unknown>` so it's clear what callers are doing.

### F12 — `LanguageQueryAPI` is defined for cross-language abstraction but only one adapter implements it

- **Files:** `src/languages/adapter.ts:7-14, 43`
- **Principle/Pattern:** YAGNI / premature generalisation
- **Status:** Missing opportunity (de-scope) — currently zero-cost but possibly misleading
- **Evidence:** `LanguageQueryAPI<TTree, TNode>` defines six cross-language primitives (findFunctions, findImports, findCallsTo, findStringLiterals, getLocation, getText). Only `lang-typescript` (`packages/languages/lang-typescript/src/query.ts:16`) implements it; the MVP text-tree adapters in lang-go/java/python/rust/cpp don't. The `query?:` on `LanguageAdapter` (line 43) acknowledges optionality.
- **Why it matters:** Abstractions designed for use are different from those designed for symmetry. The query API has the surface of "all adapters can be queried" — but in practice, anything that wants to use it has to either runtime-check or narrow to lang-typescript, and the latter defeats the abstraction. New language packs face an "implement six methods or implement none" choice with no incentive to pick the former.
- **Recommendation:** Either commit (port the query layer to one more adapter — pick Python or Rust — to validate the abstraction across two parsers; the second implementation always reveals the leaks in the first) or pare it back to two methods that **every** adapter can implement cheaply over `MinimalTextTree`. The middle position (one consumer, six methods, all optional) doesn't compose.

## Strengths

- **Layering is clean and self-enforcing.** No imports from `@opensip-tools/contracts`, `@opensip-tools/cli`, or any tool package were found in core (`grep` returned nothing). The dependency-cruiser story isn't just theoretical here.
- **`strip-utils.ts` is a strong example of "extract the truly shared part."** The justification in the header (lines 1-49) makes the right argument: the helpers are language-agnostic by construction, they live upstream of every language pack, and they'd be needed by future adapters. This is the model the registries (F1) should follow.
- **`Tool` contract `commands[]` + `register()` split is well-judged.** Pulling metadata out of the Commander wiring lets `--help` enumerate tools without touching argv parsing (tools/types.ts:25-30 makes the case explicit). The trade-off is documented and load-bearing.
- **Marker-based plugin discovery (`marker-discovery.ts`)** has the right factoring: a single walker (`discoverPackagesByMarker`) with domain-typed thin wrappers (`tool-package-discovery.ts`). The walker doesn't know about fitness or simulation, and the wrappers don't reimplement node_modules traversal.
- **Plugin discovery security checks are diligent.** `discover.ts:172-209` validates plugin names, performs `realpath` containment checks, and rejects symlink-escape patterns. The reasoning is articulated in the comments.
- **`UnknownLiveViewError` (tools/types.ts:73-85)** is a good example of a typed throw at the contract layer — explicit failure mode rather than silent fallback, with the doc explaining exactly why.
- **`config-resolution.ts:97-103` error message is operator-friendly:** it enumerates every path attempted, so users don't need `--debug` to diagnose. Same quality of care appears in `resolveProjectContext`'s strict-`--config` propagation.
- **Test surface is broad.** Almost every source file has a sibling `__tests__/` directory; coverage of registries, plugin discovery, path resolution, project context, retry, and ID parsing is visible.

## Notes

- I did not audit the `__tests__/` files for test-design problems — focus was production code.
- `signal.ts` lives under `src/types/` while `errors.ts`, `logger.ts`, `paths.ts`, etc. live under `src/lib/`. Minor: the boundary between `types/` and `lib/` is unclear (errors are types too; signal is more "domain primitive" than "type"). Not a finding, but worth a layout pass.
- The `paths.ts` `PluginsPathDomain = PathDomain | 'asm' | 'lang'` (line 90) reads like a temporary widening — see also the comment at lines 81-89. F8 / F9 (PluginExports / RegisterCounts) and this `PluginsPathDomain` widening together suggest a "tool domain registry" might want to be a first-class concept, where each tool registers its `(domain id, path roots, counter names)` and the kernel doesn't enumerate them.
- `IdNameTagRegistry`'s ValidationError on name collision (lib/id-name-tag-registry.ts:46-50) is the only registry in core that throws on duplicate; `Result<T, E>` exists in this same package (errors.ts:102-104) and would let the caller decide. Worth aligning with F5/F6.
