# Spec: Plugin-loader primitive consolidation into core

> Status: **PROPOSED** (2026-06-01).
> Surfaced by a `graph` body-twin run: byte-identical `bodyHash` for a
> cluster of plugin-discovery helpers across `@opensip-tools/fitness`
> and `@opensip-tools/simulation`.

## Objective

The two tool engines reimplement node_modules-walking plugin discovery
that the kernel already owns. A real `graph` run reports byte-identical
function bodies in both engines for a cluster of discovery helpers:

| fn | size | fitness | simulation | core today |
|---|---|---|---|---|
| `resolvePackageDir` | ~278B | `plugins/check-package-discovery.ts:151` | `plugins/scenario-package-discovery.ts:151` | — (missing) |
| `hasPackageJson` | ~139B | `…check-package-discovery.ts:163` | `…scenario-package-discovery.ts:163` | — (missing) |
| `safeReaddir` | ~99B | `…check-package-discovery.ts:168` | `…scenario-package-discovery.ts:168` | a **third** copy at `plugins/marker-discovery.ts:148` |
| `onWarn` | ~104B | `cli/fit/check-loader.ts:407`, `plugins/loader.ts:116` | `cli/sim.ts:249` | the **type** is core's (`plugins/recipe-loader.ts:37`) |
| `setPreLoadHook` | ~91B | `cli/fit/check-loader.ts:113` | `cli/sim.ts:88` | — (per-tool state) |
| `getPluginLoadErrors` | ~85B | `cli/fit/check-loader.ts:108` | `cli/sim.ts:71` | — (per-tool state) |
| `addSignal` | ~74B | `framework/result-builder.ts:73` | `framework/result-builder.ts:122` | — (per-tool builder) |

CLAUDE.md is explicit: **core owns the canonical plugin loader**; fitness
and simulation are peers that depend on core. A `safeReaddir` triplicated
across both engines *and core's own `marker-discovery.ts`* is textbook
drift — the engines never reached for the kernel's walker, they grew their
own. This spec stops the drift for the helpers that are genuinely generic
loader plumbing, and explicitly records why the rest are left alone.

**Success:** the generic filesystem-walk primitives have exactly one home
(core); both engines import them; fitness and simulation plugin-loading
behavior is unchanged (existing plugin-loader tests pass untouched as the
oracle); and core stays a strict kernel — no fitness/sim-shaped concept
leaks down.

## Scope

### In scope (move to core)

- **`safeReaddir`** — 3 copies (2 engines + `marker-discovery.ts`)
  collapse to 1 internal core primitive consumed by all three discovery
  sites.
- **`hasPackageJson`** — 2 engine copies collapse to 1 core export.
- **`resolvePackageDir`** — 2 engine copies collapse to 1 core export.
  This is the ancestor-walk that resolves an *explicit* package name to
  its on-disk directory (the Rule-1 path in both discovery files).
- A new **shared scoped-package walker** that subsumes the two
  `autoDiscover{Checks,Scenarios}` bodies. They are not in the
  byte-identical cluster only because each hard-codes its own prefix
  constant (`checks-` vs `scenarios-`) — structurally they are the same
  ancestor-walk. Parameterizing by `prefix` (exactly as
  `marker-discovery.ts` is parameterized by `kind` and `scope-validation.ts`
  by `evt`) removes the duplication at its root rather than only the
  leaf helpers it calls. (See Open Question OQ-2 for the
  conservative-vs-thorough boundary.)

### Out of scope (deferred, with reasons)

- **`onWarn`** — the byte-identical body is the *call-site adapter*
  `(evt, message, extra) => ctx.warn(...)` / `logger.warn(...)`. The
  reusable artifact is the *type* `(evt, message, extra?) => void`, and
  core **already owns it** (`recipe-loader.ts:37`,
  `RegisterRecipesOptions.onWarn`). Each adapter closes over a different
  sink (`ctx.warn` in the loader, `logger.warn` in the CLI sites) so the
  *bodies* cannot be shared without inventing a sink abstraction the
  callers do not need. No move. Optionally export the existing type alias
  for reuse (OQ-1) — non-blocking.
- **`setPreLoadHook` / `getPluginLoadErrors`** — these read/write
  per-tool **lifecycle singletons** (`preLoadHook`, `pluginLoadErrors`)
  that live in `check-loader.ts` / `sim.ts`. The bodies are trivially
  identical (a one-line setter and a one-line getter) but the *state*
  they touch is per-tool and per-process, and the CLAUDE.md scope rule
  is that this kind of per-invocation lifecycle state belongs on the tool
  (and ultimately `RunScope`), not in the kernel. Promoting a generic
  "plugin-error register" to core would pull tool lifecycle state down a
  layer for a 2-line saving — net-negative against "core stays a strict
  kernel." A separate `RunScope`-based refactor of these singletons is the
  right vehicle if we want to dedupe them; it is out of scope here.
- **`addSignal`** — not loader plumbing at all. It is a `ResultBuilder`
  method (`result-builder.ts`) that pushes onto a private `_signals`
  array. The two copies look identical because both are
  `this._signals.push(signal); return this`, but they are methods on
  two different builders producing two different tool result shapes.
  This is fluent-builder boilerplate, not duplicated discovery logic, and
  belongs to each tool's framework. No move.
- **Behavioral change** of any kind — recipe handling, single-core guard,
  marker discovery, warning text, log events. Pure relocation only.
- **New package** — everything lands in the existing `@opensip-tools/core`
  `plugins/` directory. No workspace package is added.

## Technical Context

### Existing architecture

Core already hosts the canonical loader and several **already-hoisted**
shared discovery primitives — this consolidation extends a pattern that
is in active use, it does not invent one:

- `packages/core/src/plugins/loader.ts` — generic `loadPlugin` /
  `loadAllPlugins` (`RegisterExportsFn` callback). Both engines delegate
  here (`fitness/engine/src/plugins/loader.ts:205-223`,
  `simulation/engine/src/plugins/loader.ts:135-137`).
- `packages/core/src/plugins/marker-discovery.ts` — generic
  `discoverPackagesByMarker({ projectDir, kind })` ancestor-walk,
  parameterized by `MarkerKind`. Contains the **third** `safeReaddir`
  copy (`:148`).
- `packages/core/src/plugins/package-entry.ts` — `resolvePackageEntryPoint`,
  already shared by both engines' `read*PackageMetadata` and core's
  `tool-package-discovery.ts`.
- `packages/core/src/plugins/scope-validation.ts` — `resolveScopes`,
  **already hoisted into core** and consumed by both engines' discovery.
  Its header ("Hoisted into core so every tool's discovery surface
  enforces the same invariant") and its `evt`-parameterization are the
  direct precedent for this spec's shared-walker design.

The drift lives in the two near-byte-identical discovery files:

- `packages/fitness/engine/src/plugins/check-package-discovery.ts`
  (228 lines) — `discoverCheckPackages` + `autoDiscoverChecks` (`:123`)
  + the three private helpers (`:151`, `:163`, `:168`).
- `packages/simulation/engine/src/plugins/scenario-package-discovery.ts`
  (229 lines) — `discoverScenarioPackages` + `autoDiscoverScenarios`
  (`:123`) + the same three private helpers at the **same line numbers**.

A `diff` of the two files differs only in: the domain noun
(check/scenario), the prefix constant (`checks-`/`scenarios-`), the
`evt` strings, the exported type names, and one extra sentence of
JSDoc. The discovery *algorithm* — ancestor-walk node_modules under each
resolved scope, match prefix, dedupe, require `package.json` — is
identical.

### Key dependencies

- `@opensip-tools/core` barrel (`plugins/index.ts`) is the publication
  point; new exports are appended there.
- Both engines already import `resolveScopes`, `resolvePackageEntryPoint`,
  `logger`, `readYamlFile` from the core barrel — adding 2-3 more named
  imports is zero new dependency surface.
- Existing oracle tests:
  `core/src/plugins/__tests__/marker-discovery.test.ts`,
  `fitness/engine/src/plugins/__tests__/check-package-discovery.test.ts`,
  `simulation/engine/src/plugins/__tests__/scenario-package-discovery.test.ts`.

### Constraints

- **Layer rule (dependency-cruiser):** core must not import from
  contracts/cli/fitness/simulation/lang-*/checks-*. The moved helpers are
  pure `node:fs`/`node:path` — they add no upward import. Verified clean.
- **Kernel discipline (CLAUDE.md):** only generic, tool-agnostic plumbing
  may land in core. The In-scope set is filesystem/node_modules
  traversal with zero fitness/sim vocabulary; the deferred set is exactly
  the items that carry per-tool meaning. This boundary *is* the spec.
- **No public API regression:** `discoverCheckPackages`,
  `discoverScenarioPackages`, `read*PackagePreferences`,
  `read*PackageMetadata`, `Discovered*Package`, and the `*DiscoveryOptions`
  types stay exported from their current engine modules with identical
  signatures. Only the private helper *bodies* are replaced by core calls.
- **`@fitness-ignore` directives ride along:** `safeReaddir`'s
  `error-handling-quality` inline ignore must move with it into core so
  the dogfood gate stays green (core already carries the identical ignore
  on its own `safeReaddir` copy at `marker-discovery.ts:152`).

## Design Decisions

| # | Decision | Choice | Alternatives considered |
|---|---|---|---|
| D1 | Where do the fs primitives live | New `packages/core/src/plugins/node-modules-walk.ts` exporting `safeReaddir`, `hasPackageJson`, `resolvePackageDir`. `marker-discovery.ts` drops its private `safeReaddir` and imports the shared one. | (a) Co-locate in `package-entry.ts` — rejected: that file is about entry-point resolution, not directory traversal; mixing concerns. (b) Leave `marker-discovery`'s copy and only dedupe the two engines — rejected: leaves a known third copy, i.e. partial fix, violates "fix as found." |
| D2 | Dedupe `autoDiscover{Checks,Scenarios}` too, or only the leaf helpers | Add a shared `discoverScopedPackages({ projectDir, scopes, prefix })` to core that performs the ancestor-walk + prefix-match + dedupe, returning `{ name, packageDir }[]`. Both engines' `autoDiscover*` collapse to a one-line call. | (a) Only move the 3 leaf helpers, leave the two `autoDiscover*` walk bodies — rejected: the walk body is the larger duplicate; leaving it re-grows the leaf helpers' callers and the drift returns. (b) Fold scoped discovery into `discoverPackagesByMarker` — rejected: marker discovery keys on `package.json` `opensipTools.kind`, scoped discovery keys on a *name prefix*; different predicates, conflating them muddies both. Keep them as two sibling walkers sharing the leaf helpers. |
| D3 | Generic walker shape | Parameterize by `prefix: string` and an `evt`-style not needed (the scoped walker emits no warnings itself; the not-resolved warning stays in the engine's Rule-1 path). Mirror `marker-discovery`'s return type `{ name, packageDir }[]`. | A `predicate: (entry) => boolean` callback — rejected as over-general: every caller wants prefix-match; a string prefix is the honest contract and keeps the signature self-documenting (same judgment `scope-validation` made with a fixed `evt` param vs a logger callback). |
| D4 | `onWarn` | No move. Optionally re-export the existing `(evt, message, extra?) => void` type from the barrel for callers that want to name it (OQ-1). | Promote a shared `onWarn` factory bound to a sink — rejected: callers bind different sinks; a factory adds indirection for a 1-line closure. |
| D5 | `setPreLoadHook` / `getPluginLoadErrors` | No move; documented as per-tool lifecycle state pending a `RunScope`-based refactor. | Promote a generic `PluginLoadErrorRegister` to core — rejected: pulls tool/per-invocation lifecycle state into the kernel for a 2-line saving; inverts the scope-ownership rule in CLAUDE.md. |
| D6 | `addSignal` | No move; it is `ResultBuilder` method boilerplate, per-tool, not loader plumbing. | Extract a shared `BuilderBase` — rejected: out of this spec's theme (loader consolidation) and the two builders produce different result contracts; a separate spec if desired. |
| D7 | Public surface of core | Additive only: new exports `safeReaddir`(internal — not barrel-exported unless a test needs it), `hasPackageJson`, `resolvePackageDir`, `discoverScopedPackages` + its option/result types. No existing core export changes signature. | — |

## Success Criteria (testable)

- [ ] `resolvePackageDir`, `hasPackageJson`, `safeReaddir` exist in exactly
      **one** location (core); a `graph` body-twin run reports **0**
      cross-package byte-identical bodies for these three names (down from
      2-3 copies each). `marker-discovery.ts` no longer defines its own
      `safeReaddir`.
- [ ] `check-package-discovery.ts` and `scenario-package-discovery.ts`
      define **no** private `autoDiscover*`, `resolvePackageDir`,
      `hasPackageJson`, or `safeReaddir`; each calls
      `discoverScopedPackages` for the Rule-3 path and
      `resolvePackageDir` for the Rule-1 path, imported from the core
      barrel.
- [ ] **Behavior unchanged — existing tests are the oracle, edited only
      for moved-symbol imports, not assertions:**
      `check-package-discovery.test.ts`,
      `scenario-package-discovery.test.ts`, and
      `marker-discovery.test.ts` pass; their resolution-rule assertions
      (explicit list wins, opt-out, scope walk, dedupe, missing
      package.json skipped, not-installed warning) are byte-identical to
      pre-change.
- [ ] The public signatures of `discoverCheckPackages`,
      `discoverScenarioPackages`, `read*PackagePreferences`,
      `read*PackageMetadata` and their exported types are unchanged
      (verified by the engines' barrels and consumer call sites compiling
      without edit).
- [ ] Core stays kernel-appropriate: the new file imports only
      `node:fs` / `node:path` / `../lib/logger.js`; dependency-cruiser
      and the type-aware layer gate report **0** new violations.
- [ ] Deferred items remain in place and are *not* moved:
      `onWarn` adapters, `setPreLoadHook`/`getPluginLoadErrors`
      singletons, and `addSignal` builder methods are untouched (the spec
      records why; a reviewer can confirm no kernel leakage).
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green; `pnpm fit`
      finding count not regressed (the `error-handling-quality` ignore
      rode along with `safeReaddir`).

## Boundaries

- This is a **relocation + parameterization** of generic discovery
  plumbing. No discovery semantics, warning text, or log-event names
  change.
- Only the **In-scope** helpers move. The deferred set (`onWarn`,
  `setPreLoadHook`, `getPluginLoadErrors`, `addSignal`) is explicitly
  left where it is; touching it is a different spec.
- No `RunScope` refactor, no result-builder refactor, no `onWarn`-sink
  abstraction.

## Open Questions

- **OQ-1:** Export the existing `(evt, message, extra?) => void` type
  (today inlined as `RegisterRecipesOptions.onWarn`) as a named barrel
  type (e.g. `PluginWarn`) for the engine adapters to annotate against?
  *Proposed:* yes if cheap, but non-blocking — it documents intent
  without moving any body. Decide during implementation; default to
  skipping if it adds churn.
- **OQ-2:** Should `discoverScopedPackages` (D2) also absorb the
  *Rule-1/Rule-2/Rule-3 dispatch* (the `discoverCheckPackages` /
  `discoverScenarioPackages` outer functions), leaving the engines with
  only their `evt` strings and prefix constant? *Proposed:* **no** for
  this pass — the outer functions own domain-specific warning events
  (`plugin.check_package.not_resolved` vs `plugin.scenario_package.…`)
  and the explicit-list semantics are the tool's contract surface. Move
  the *walk*, keep the *policy* per-tool. Revisit only if a third tool
  appears and the dispatch itself starts triplicating.
- **OQ-3:** Should the deferred `setPreLoadHook`/`getPluginLoadErrors`
  singleton dedup be filed as a follow-up `RunScope` spec now, or left
  until a third tool needs the same lifecycle? *Proposed:* note it in
  `docs/internal/` as a known follow-up; do not block this consolidation.

## Applicable Conventions

- **Layering** (CLAUDE.md): core is a strict kernel; fitness/sim depend
  on core, never the reverse. Enforced by dependency-cruiser + the
  type-aware layer gate.
- **Imports:** workspace via the package barrel (`@opensip-tools/core`),
  internal relative with `.js`, `import type` for type-only.
- **Precedent:** follow `scope-validation.ts`'s hoist pattern (shared
  discovery primitive in core, parameterized for per-tool specifics) and
  `marker-discovery.ts`'s walker shape (`{ name, packageDir }[]` return,
  ancestor-walk dedupe).
- **Dogfood gate:** `@fitness-ignore` directives travel with the code
  they annotate; `pnpm fit:ci` must not surface net-new alerts.
- **Tests:** Vitest, `*.test.ts` next to source; reuse the existing
  discovery tests as the behavior oracle.
