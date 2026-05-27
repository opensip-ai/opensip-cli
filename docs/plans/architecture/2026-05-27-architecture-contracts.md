# Architecture audit — contracts

**Date:** 2026-05-27
**Scope:** packages/contracts
**Auditor:** Claude

## Summary

`@opensip-tools/contracts` is *mostly* a clean contract-types package — the bulk of `types.ts`, `graph-catalog.ts`, `exit-codes.ts`, and `cli-config.ts` is appropriately abstract and well-documented. However, the package has accreted material runtime behavior that does not belong in a "contracts" layer: a full `SessionRepo` data-access class (drizzle queries, transactions, logging), a Drizzle table schema treated as a value re-export, and a UUID/filename-sanitizer pair tucked into a "type-only facade" file. There is also a documented-versus-actual layering mismatch — CLAUDE.md and `index.ts` claim contracts owns the `Tool` contract, but `Tool` / `ToolCliContext` actually live in `@opensip-tools/core`. The boundary between core and contracts is real but inverted in places, and the package's stated purpose drifts noticeably from its content.

## Findings

### F1 — `SessionRepo` is a runtime data-access object living in a "contracts" package

- **Files:** `packages/contracts/src/persistence/session-repo.ts:42-261`, `packages/contracts/src/index.ts:78-80`
- **Principle/Pattern:** Single Responsibility / Layering (Repository pattern misplaced)
- **Status:** Problematic
- **Evidence:** `session-repo.ts:42` declares `class SessionRepo { constructor(private readonly datastore: DataStore) {} ... }` with 5 mutation methods (`save`, `purge`, `clearAll`), drizzle query construction (`session-repo.ts:115-119`), transaction orchestration (`session-repo.ts:47, 218`), structured logging (`session-repo.ts:93-100`), and runtime row-shape validation (`session-repo.ts:201-212`). The package description is `"Shared contract types for OpenSIP Tools"` (`package.json:5`) and `index.ts:1-19` explicitly frames the package as the typed seam between tools and the runner.
- **Why it matters:** A contracts package is by convention a shape/interface package — consumers expect zero side effects and minimal install graph. `SessionRepo` drags in `drizzle-orm`, `@opensip-tools/datastore`, and the global `logger` whenever any tool imports a single `CliOutput` type. It also obscures discovery: a developer hunting for "where session persistence lives" will not search `packages/contracts/`. Finally, the layering claim "contracts depends only on `@opensip-tools/core`" (index.ts:16) is already false because of this — `session-repo.ts:7` imports `@opensip-tools/datastore`.
- **Recommendation:** Move `SessionRepo`, the `persistence/schema/sessions.ts` table definitions, and `SessionListOptions` into a new package — either `@opensip-tools/session-repo` or fold into `@opensip-tools/datastore` as a domain-repo namespace. Keep only the *type* `StoredSession` (already type-only) and `CheckCatalogEntry` / `RecipeCatalogEntry` in contracts. Tools then depend on the new package alongside contracts; contracts goes back to being type-only.

### F2 — `persistence/store.ts` mixes type-only declarations with runtime helpers

- **Files:** `packages/contracts/src/persistence/store.ts:1-77`
- **Principle/Pattern:** SRP / Interface Segregation
- **Status:** Problematic
- **Evidence:** The file's own header says "This module is now a type-only facade" (`store.ts:6`) but then exports `generateSessionId` (`store.ts:70-72`, calls `randomUUID` from `node:crypto`) and `sanitizeForFilename` (`store.ts:74-77`). Both are runtime utilities unrelated to the catalog-entry types declared above them.
- **Why it matters:** Header drift produces grep traps — a future contributor reading the comment will believe the file is safe to import in any context, then be surprised that pulling `StoredSession` also pulls a `crypto` require. Co-locating two pure-runtime helpers with type re-exports inverts the file's documented purpose.
- **Recommendation:** Move `generateSessionId` and `sanitizeForFilename` to the same package that ends up owning `SessionRepo` (per F1) or into `@opensip-tools/core` under `lib/ids.ts` (alongside the existing core `IDs`). Then either remove `store.ts` entirely (move `StoredSession` to `types.ts`) or update the header to match what remains.

### F3 — Drizzle table objects re-exported from the contracts barrel are runtime values, not types

- **Files:** `packages/contracts/src/index.ts:80`, `packages/contracts/src/persistence/schema/sessions.ts:4-54`
- **Principle/Pattern:** Layering / Stable Abstractions Principle
- **Status:** Problematic
- **Evidence:** `index.ts:80` does `export { sessions, sessionChecks, sessionFindings } from './persistence/schema/sessions.js';` — these are `sqliteTable(...)` runtime values, not types. Tests reach in via the relative path (`__tests__/session-repo.test.ts:4`), but no production code outside `session-repo.ts` itself appears to consume them (`grep` confirms only the schema file and the repo use them).
- **Why it matters:** The barrel signals that these are part of the "contract surface," which they are not — they are persistence-layer implementation details. If `SessionRepo` moves (F1), these will move with it; exposing them at the public API ossifies their location.
- **Recommendation:** Drop the `sessions/sessionChecks/sessionFindings` export from `index.ts`. They are an implementation detail of whatever package ends up owning `SessionRepo`. The test can keep using the relative import.

### F4 — `CliDefaults` loader violates the stated "contracts depends only on core" invariant cleanly but invites confusion

- **Files:** `packages/contracts/src/cli-config.ts:1-108`, `packages/contracts/src/index.ts:16-18`
- **Principle/Pattern:** SRP / Cohesion
- **Status:** Problematic (mild)
- **Evidence:** `cli-config.ts:31` imports `readYamlFile, resolveProjectConfigPath` from core; the file does YAML reading, plain-object guards (`isPlainObject` at `cli-config.ts:55`), string-array coercion (`asStringArray` at `cli-config.ts:60`), and projection (`projectCliDefaults` at `cli-config.ts:67`). The file's own preamble (`cli-config.ts:13-23`) admits it lives here as a "tool-agnostic seam" because no tool owns it. That is a reasonable argument, but the file is still *behavior* in a package whose name is "contracts."
- **Why it matters:** This is the strongest single signal that "contracts" has become an "everything-the-CLI-needs-that-no-tool-owns" bucket. The rationale comment is defensive precisely because the placement is anomalous. Both criteria the comment cites (`cli:` is tool-agnostic; fitness would otherwise become a load-bearing dep of plain CLI bootstrap) point to "this belongs in `@opensip-tools/core`," not "this belongs in contracts" — `readYamlFile` and `resolveProjectConfigPath` already live in core, so the kernel already has the dependency footprint.
- **Why it matters more:** The `isPlainObject` and `asStringArray` guards are also duplicated in spirit across the codebase (see `cli-config.ts:55-64`). Promoting them to core would let other YAML-loading sites share them.
- **Recommendation:** Move `loadCliDefaults`, `isPlainObject`, `asStringArray`, and `projectCliDefaults` to `@opensip-tools/core` (e.g. `core/src/lib/cli-defaults.ts`). Keep the `CliDefaults` type in contracts (or move both — either is consistent). The current placement is defensible but inconsistent with the rest of the package's intent.

### F5 — Documented "Tool contract lives in contracts" is false; it lives in core

- **Files:** `packages/contracts/src/index.ts:1-19`, CLAUDE.md (Repository Structure), `packages/core/src/tools/types.ts:185-210`
- **Principle/Pattern:** Documentation / contract clarity
- **Status:** Problematic
- **Evidence:** CLAUDE.md says contracts holds "the `Tool` contract" and `contracts/src/index.ts:8` summarises the package as "the typed seam between Tools and the runner." But `Tool`, `ToolMetadata`, `ToolCommandDescriptor`, `ToolCliContext`, `ToolPluginExports`, and `LiveViewRenderer` are all defined in `packages/core/src/tools/types.ts:32-219` and re-exported from `@opensip-tools/core`. Contracts only re-exports a `CliProgram` type alias (`index.ts:119`).
- **Why it matters:** The boundary between core and contracts is unclear in the codebase's own self-description. A new contributor reading CLAUDE.md will hunt the `Tool` interface in contracts, fail to find it, and either duplicate it or ask. The actual placement (Tool in core) is reasonable — `Tool` references `Logger`, `ProjectContext`, and `ToolError`, all of which live in core. The docs need to follow the code.
- **Recommendation:** Either (a) move `Tool`/`ToolCliContext` to contracts (probably wrong — would force core→contracts→core cycle via `ProjectContext`/`Logger`), or (b) update CLAUDE.md and `index.ts:1-19` to acknowledge that the Tool contract lives in core and contracts owns only the `CliOutput`/`CommandResult` and ancillary types. Option (b) is the correct call; the package is best framed as "CLI surface contracts" (exit codes, structured result shapes, session DTOs, dashboard catalog shapes) rather than "the Tool↔runner contract." A one-paragraph rename of the package mission is enough.

### F6 — `CliArgs` god-object retained alongside the per-command interfaces it was supposed to replace

- **Files:** `packages/contracts/src/types.ts:65-108`
- **Principle/Pattern:** Interface Segregation Principle
- **Status:** Problematic (already flagged in code, not yet acted on)
- **Evidence:** `types.ts:65-78` marks `CliArgs` `@deprecated` with the comment "Do not extend this interface for new flags. Add new flags to the per-command options interface instead." But `CliArgs` is still publicly exported (`index.ts:22-27`) and the comment says "remaining call sites use `*OptsToCliArgs` adapter functions." `FitOptions` (`types.ts:8-28`), `InitOptions` (`types.ts:31-52`), and `ToolOptions` (`types.ts:55-63`) each carry a strict subset; `CliArgs` carries their union (`json`, `cwd`, `recipe`, `check`, `tags`, `kind`, `gateSave`, `gateCompare`, `findings`, ...).
- **Why it matters:** Each command currently accepts a structurally over-wide options bag and adapter functions paper over the gap. This is a classic ISP violation — handlers receive fields they cannot use (e.g. `sim` does not care about `gateSave`). The adapter functions are a code smell that will accumulate as long as `CliArgs` exists.
- **Recommendation:** Treat removal of `CliArgs` as an explicit work item. Step 1: stop exporting from the barrel (downgrade to internal). Step 2: replace each `*OptsToCliArgs` adapter call site with a direct pass of the per-command options. Step 3: delete the type. The work is mechanical — every call site is visible by `grep CliArgs`.

### F7 — Strategy / Rules table in `exit-codes.ts` is correct and well-applied

- **Files:** `packages/contracts/src/exit-codes.ts:23-187`
- **Principle/Pattern:** Strategy (table-driven rule resolution)
- **Status:** Correct
- **Evidence:** `SUGGESTION_RULES` (`exit-codes.ts:57`) is a flat readonly array of `{ match, suggest }` rule tuples walked first-match-wins by `getErrorSuggestion` (`exit-codes.ts:179`). The header comment (`exit-codes.ts:48-50`) explicitly warns "Do NOT replace this with a Chain-of-Responsibility class — a flat array is the contract here." Rule ordering is load-bearing (recipe-not-found before check-not-found, `exit-codes.ts:58-75`) and called out in comments.
- **Why it matters:** This is a textbook example of choosing data over polymorphism when the polymorphism would not pay for itself — five identical-shape rules, no shared state, no inheritance. The comment guarding against over-engineering is the right call. Worth preserving as the reference pattern when similar rule tables come up elsewhere in the repo.
- **Recommendation:** No action. Continue extending the rule table as needed. If the table grows past ~20 rules, revisit — but not before.

### F8 — Parallel error-suggestion strategy in CLI duplicates the rule-walking shape

- **Files:** `packages/contracts/src/exit-codes.ts:57-174`, `packages/cli/src/error-handler.ts:43-91`
- **Principle/Pattern:** Strategy (split implementation across layers — DRY)
- **Status:** Problematic (mild)
- **Evidence:** `error-handler.ts:43-82` defines a second rule table (`TYPED_ERROR_RULES`) with the same `{ predicate, build }` shape, walked first-match-wins by `suggestionFromTypedError` (`error-handler.ts:84-91`). `handleParseError` (`error-handler.ts:107-108`) tries the typed-error rules first, then falls back to the message-based rules in contracts.
- **Why it matters:** Two strategy tables that solve the same problem (error → `ErrorSuggestion`) using different match keys (instanceof vs. substring) live in different packages and can drift. A `NotFoundError` thrown with the message "Recipe not found: x" routes correctly through the typed rules in CLI but would route to `CHECK_NOT_FOUND` if only the contracts table ran. The ordering means current behavior is correct, but the split is fragile — anyone adding a typed error must also remember to consider whether the contracts substring rule will still misfire on the message.
- **Recommendation:** Move `TYPED_ERROR_RULES` into contracts alongside `SUGGESTION_RULES` and have `getErrorSuggestion` accept both error-class and message inputs (or split into `getTypedErrorSuggestion(err: ToolError)` + `getMessageErrorSuggestion(err: unknown)`, both in contracts). The CLI then composes them; no behavior change.

### F9 — `GraphCatalog` type-duplication-by-design is the right call

- **Files:** `packages/contracts/src/graph-catalog.ts:1-91`
- **Principle/Pattern:** Stable Abstractions / Dependency Inversion
- **Status:** Correct
- **Evidence:** `graph-catalog.ts:1-10` says "MUST NOT import from `@opensip-tools/graph`. The shape is intentionally duplicated as readonly structural types." Producer (`@opensip-tools/graph`) and consumer (`@opensip-tools/dashboard`) both depend on contracts; contracts owns the JSON-on-disk shape independent of either. The file is rigorously type-only (no runtime exports).
- **Why it matters:** This is exactly what a contracts layer is for: a shared shape neither producer nor consumer owns. The "MUST NOT import" comment is load-bearing — without it, contracts would acquire a dep on graph, inverting the layering.
- **Recommendation:** No action. Use this as the template for any future producer/consumer-spanning shape.

### F10 — `CommandResult` discriminated union is well-modelled but the per-variant types are scattered

- **Files:** `packages/contracts/src/types.ts:172-413`
- **Principle/Pattern:** Discriminated union / Open-Closed via type discrimination
- **Status:** Correct (architecture); Missing opportunity (organization)
- **Evidence:** `CommandResult` (`types.ts:172-186`) is a clean discriminated union on `type`. Each variant (`FitDoneResult`, `SimDoneResult`, `ListChecksResult`, ...) is exported separately. `App.tsx` is documented to switch on `result.type`. The shape is open for extension (new tools add a variant) without modifying the union.
- **Why it matters (positive):** This is the right pattern for the CLI-result seam. Adding `audit-done` for a future `audit` tool is one new interface + one new branch in the union, with compile-time exhaustiveness through TypeScript's narrowing.
- **Why it matters (opportunity):** All 14 result variants live in a single 413-line `types.ts` mixed with `FitOptions`, `CliArgs`, `CliOutput`, and unrelated I/O shapes. A new contributor wanting to find `PluginResult` has to scroll. Splitting `types.ts` into `cli-options.ts`, `cli-output.ts`, and `command-results/<command>.ts` per discriminator would let each variant live next to its companion data shapes (e.g. `PluginInfo`/`SyncEntry` next to `PluginResult`).
- **Recommendation:** Split `types.ts`. Keep the barrel re-exports stable. Low risk, high readability win.

### F11 — `PluginInfo` is documented as deliberately mirroring (not aliasing) core's `DiscoveredPlugin`

- **Files:** `packages/contracts/src/types.ts:363-374`, `packages/core/src/plugins/discover.ts:34`
- **Principle/Pattern:** Adapter / Anti-Corruption Layer
- **Status:** Correct
- **Evidence:** `types.ts:363-369` comments: "Mirrors the `DiscoveredPlugin` shape from core, but kept here as a separate contract type so the CLI ↔ plugin-result boundary is stable independently of core's internal representation."
- **Why it matters:** Re-using core's internal shape on the CLI's output surface would couple the CLI JSON output to internal refactors. Keeping a hand-rolled mirror is the right call — a textbook anti-corruption layer between an internal abstraction and a published one.
- **Recommendation:** No action. Worth mentioning in any "how to add a result type" doc as an example of when *not* to reuse a core type directly.

### F12 — `PreExistingFile` and `InitResult`'s nested option-result shapes belong with the init command

- **Files:** `packages/contracts/src/types.ts:268-332`, `packages/cli/src/commands/init.ts:64`
- **Principle/Pattern:** Cohesion / Locality
- **Status:** Problematic (mild)
- **Evidence:** `PreExistingFile` (`types.ts:268-271`) and all the init-specific nested objects (`insideExistingProject`, `partialStateError`, `ambiguousLanguageError`, `state` literal union, language list literal union) are init-command implementation details surfaced via `InitResult`. Only `cli/src/commands/init.ts` consumes them.
- **Why it matters:** A future move of init out of the CLI core (e.g. to its own `@opensip-tools/init-tool` package) would have to either (a) take `PreExistingFile` with it and remove it from contracts, or (b) leave a type-mirror in contracts for a command nobody else in the repo cares about. The current setup leaks the init command's internal classification taxonomy into the cross-package contract surface.
- **Recommendation:** Treat `InitResult` itself as the contract (since `CommandResult` needs the variant). But move `PreExistingFile`, `insideExistingProject`, `partialStateError`, `ambiguousLanguageError`, and the `state` literal union into the cli/init module and reference them by `import type`. The barrel stops exporting `PreExistingFile`. If `init` moves to its own package later, the types go with it.

## Strengths

- `graph-catalog.ts` is the cleanest example in the repo of a true contract type — strictly type-only, documented constraint that producer/consumer never depend on each other, full readonly modifiers.
- `EXIT_CODES` + `SUGGESTION_RULES` (`exit-codes.ts`) is a textbook table-driven Strategy: rule ordering is documented and load-bearing, first-match-wins is explicit, the "do not refactor into a class" comment shows good restraint.
- The `CommandResult` discriminated union is correctly modelled with stable `type` literals and is genuinely open for extension — new tools add variants without modifying existing code.
- `CliProgram = Command` type alias (`index.ts:119`) with the optional-peer-dep + `import type` mechanism (`index.ts:103-118`) is a clean way to surface a contract type without forcing the install graph — the package.json + comment combination is worth referencing as a pattern.
- `loadCliDefaults` (despite F4 placement concern) is *implemented* well: defensive, no-throw, narrow type-guards, projection-instead-of-mutation. The internal code is good even if the location is wrong.
- The 2026-05-25 audit comment in `session-repo.ts:196-212` and the matching `hydration guards` tests (`session-repo.test.ts:194-215`) show good operational hygiene — silent corruption was promoted to an explicit throw, and regression tests were added.

## Notes

- This audit treats CLAUDE.md's stated purpose for the contracts package as the reference point. Several findings (F1, F2, F4, F5) are essentially the same observation through different lenses: "contracts has accreted runtime code and the boundary with core is no longer crisp." The structural fix is consistent across them: extract `SessionRepo` and helpers, keep contracts type-only, update CLAUDE.md.
- `package.json` already declares `drizzle-orm` and `@opensip-tools/datastore` as real (non-peer) dependencies (`package.json:28-30`). Removing `SessionRepo` (per F1) would let contracts shed both deps and become a true zero-runtime-cost type package.
- No Gang-of-Four pattern is being misused inside contracts; the issues are layering, cohesion, and SRP, not pattern misapplication. The `getErrorSuggestion` Strategy table is the only conscious pattern and it is applied correctly.
- The `--gate-save` / `--gate-compare` flags live on `FitOptions` (`types.ts:24-27`) and are duplicated on `CliArgs` (`types.ts:100-102`). Removing `CliArgs` (F6) cleans this up automatically.
