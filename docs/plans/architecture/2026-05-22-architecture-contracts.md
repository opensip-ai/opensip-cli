---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/contracts"
package: "@opensip-tools/contracts"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/contracts

## Summary

`@opensip-tools/contracts` is layer 2 of the workspace: the type-and-shape
contract between Tools (`fitness`, `simulation`, future `graph`) and the CLI
runner. The package divides cleanly into four modules — `types.ts`
(CLI/result shapes), `exit-codes.ts` (codes + suggestion helper),
`persistence/store.ts` (session JSON I/O), and `persistence/dashboard/*`
(self-contained HTML report generator). The first three are small,
dependency-light, and well-shaped. The dashboard subtree is the package
center of mass — ~2,000 lines spread across ~20 modules that compose into
one inlined HTML page.

The dashboard composition follows a real pattern (each module emits a
JS-string fragment; `generator.ts` concatenates them into a `<script>`
block). That pattern works, but it has two specific weak spots that
showed up repeatedly while reading: (1) the boundary between "data the
generator receives" and "rendering knowledge it has to encode" is
muddied by the positional five-argument signature, and (2) the Code
Paths views are a duplicated template that begs for a single render
helper plus seven small declarative configs. Neither rises to "ceremony"
— both are small, mechanical refactors that would shrink the surface
without adding indirection.

The remaining findings are smaller: `getErrorSuggestion`'s string-match
chain, a duplicated finding shape between `StoredSession` and
`FindingOutput`, the `CliArgs` god-object alias, and a layering concern
where `persistence/store.ts` sits beside the dashboard renderer
under one package barrel.

## Existing patterns (correct usage)

The package already does several things right and these should be
preserved:

- **Discriminated union dispatch (`CommandResult`).** `types.ts:155`
  defines `CommandResult` as a tagged union over a literal `type` field;
  `App.tsx:32` switches on it, the typecheckers narrow each arm. This
  is the one piece of dispatch logic the contracts package owns and it
  is shaped exactly the way it should be — no class hierarchy, no
  visitor, no per-result rendering coupled here.
- **Persistence configuration as explicit setup.** `store.ts` rejects
  any session call made before `configurePersistencePaths()` runs
  (`requireStoreDir` throws). This is a clean substitute for an
  ambient default and makes `opensip-tools uninstall` a precise
  operation, as the file comment notes.
- **Type-only structural duplication of the graph catalog.**
  `code-paths/types.ts` consciously redeclares the catalog shape
  rather than importing from `@opensip-tools/graph`, with a comment
  pointing at §2.4 of the design doc. That is the right call for a
  contracts package — runtime imports here would create a back edge
  from contracts into a tool.
- **Singleton overlay invariant in the dashboard.** The Function Card,
  Help Drawer, and Code Paths views all share the convention of
  `closeFoo()` removing the overlay before `openFoo()` re-creates it.
  Multiple modules respect this without a shared abstraction; that is
  the cheapest way to enforce a singleton and it works.
- **Module-per-view-fragment composition.** `dashboardCodePathsJs()`
  in `code-paths.ts` joins ~18 sibling fragments into one IIFE-style
  blob. This is the right shape for "ship one HTML file with no
  bundler" — each fragment can be unit-tested in isolation against
  its emitted string, and there is exactly one place
  (`code-paths.ts`) that has to know the order.

## Findings

### 1. Dashboard generator's positional five-argument signature is leaky

- **Files / code:** `packages/contracts/src/persistence/dashboard/generator.ts:26-44`; called from `packages/fitness/engine/src/cli/dashboard.ts:152`.
- **Pattern / principle:** SRP / OCP / Builder. The function takes five
  positional parameters — `sessions`, `checkCatalog`, `recipeCatalog`,
  `graphCatalog`, `editorProtocol` — and inlines each one as a separate
  JSON or null branch. Two of the five (`graphCatalog`, `editorProtocol`)
  are conditional (one nullable JSON blob, one nullable JS literal); the
  others are always-present arrays.
- **Status:** Working but fragile. The next thing the dashboard wants
  (a 6th input — e.g. an `asm` tool's findings, or a baseline diff for
  the gate) means another positional parameter and another bespoke
  serialization branch.
- **Why it matters:** The signature is the contracts surface a tool
  sees when it asks "render me into the dashboard." Today only fitness
  calls it; once a third tool wants to ship its data into the report,
  the cost of touching this function falls on every caller. The
  positional shape also hides intent — a four-`null` call site is
  legitimate when a tool has no catalog and no editor protocol, and
  there is no good way to write that.
- **Recommendation:** Replace the positional list with a single
  `DashboardInput` options object: `{ sessions, checkCatalog?, recipeCatalog?, graphCatalog?, editorProtocol? }`.
  Inside `generator.ts`, route the optional blocks through a small
  `serializeOptionalBlob(id, value)` helper so the two existing
  patterns (`<script type="application/json">` for JSON, `const X = …`
  for literals) collapse to one. Both moves are mechanical, both
  preserve the public name. This is the migration before adding any
  new tool's data to the report.

### 2. Seven Code Paths views duplicate the same render template

- **Files / code:** `view-hot.ts`, `view-big.ts`, `view-wide.ts`,
  `view-untested.ts` (and partially `view-search.ts`) under
  `packages/contracts/src/persistence/dashboard/code-paths/`. Compare
  the four — they share an identical 30-line skeleton: empty-catalog
  guard → iterate `indexes.byBodyHash` → filter via `passesFilter` →
  push `{ occ, metric }` → sort desc by metric → empty-result guard
  → call `renderFunctionRows(container, occurrences, columns, heading, viewId)`.
- **Pattern / principle:** Template Method / Strategy. Each view has
  exactly two pieces of variability — the per-occurrence metric
  (callers, body length, arity, untested-prod-callers) and the column
  list. Everything else is the same.
- **Status:** Working, ~250 lines of duplication.
- **Why it matters:** Adding the next view (the design doc hints at
  more) is a copy-paste exercise. Worse, they have already drifted —
  `view-untested.ts` reimplements `passesFilter`'s package and kind
  checks inline (lines 38–39) because it wants different scope
  semantics, instead of extending the predicate. That kind of drift
  is exactly what a Template Method prevents.
- **Recommendation:** Add one helper to `function-row.ts` (or a new
  `view-template.ts`):
  ```
  defineRankedView({ id, label, help, columns, metric, predicate? })
  ```
  Each `view-*.ts` becomes a 15-line declarative config:
  `defineRankedView({ id: 'hot', label: 'Hot functions', help: {…},
   columns: [...], metric: (occ, idx) => idx.callers.get(occ.bodyHash)?.length ?? 0 })`.
  `view-coupling.ts`, `view-sccs.ts`, and `view-search.ts` are different
  shapes and stay as bespoke render functions. This is genuine code
  reduction, not pattern ceremony — the abstraction already exists,
  it's just inlined in four places.

### 3. `getErrorSuggestion` is six string-match branches that read the same field

- **Files / code:** `packages/contracts/src/exit-codes.ts:15-74`.
- **Pattern / principle:** OCP / data-driven dispatch (NOT Chain of
  Responsibility). The function is six `if (message.includes(…))` arms,
  each producing the same `ErrorSuggestion` shape with a different
  message + action + exit code. Adding a new error category means
  reading the function, finding the right place in the chain, and
  adding another `if`.
- **Status:** Working, but fragile under growth. The "Check not found"
  arm already encodes a regex group extraction inline, and the
  config-error arm catches three substrings at once
  (`opensip-tools.config.yml`, `YAML`, `config`) which is broad enough
  to misfire — any error message containing the word "config" lands
  there.
- **Why it matters:** This function is the bridge between the kernel's
  thrown errors and the CLI's exit-code contract (surface #2 in the
  contract-surfaces doc). Today's drift is small; a third-party tool
  package throwing a custom error has no clean way to plug into the
  dispatch.
- **Recommendation:** Replace the if-chain with a small declarative
  table:
  ```ts
  const SUGGESTION_RULES: { match: (msg: string) => string | null; suggest: (capture: string | null) => ErrorSuggestion }[] = [...]
  ```
  Each rule is a `{ match, suggest }` pair; `getErrorSuggestion` walks
  the table and returns the first hit. Same behavior, same exports,
  but adding a new rule is one tuple. Do **not** dress this up as a
  Chain of Responsibility class — a flat array is the right shape and
  keeps the function readable. (A future Tool-supplied suggestion
  hook is a separate, larger conversation; the table makes that hook
  easy to add later by appending tool-supplied rules to the array.)

### 4. `StoredSession` duplicates `FindingOutput` with a weaker type

- **Files / code:** `packages/contracts/src/persistence/store.ts:25-57`
  vs `packages/contracts/src/types.ts:112-128, 176-210`.
- **Pattern / principle:** DRY / single source of truth. `StoredSession`
  inlines an anonymous shape that mirrors `CheckOutput` and
  `FindingOutput` from `types.ts`, except the inlined `severity` is
  typed as `string` (line 47) where `FindingOutput.severity` is
  `'error' | 'warning'`. The `FitDoneResult.findings` shape on line
  176-210 is a third near-clone with yet another inlined finding type.
- **Status:** Three drift-prone copies of the same shape. The
  divergence (`severity: string` in `StoredSession`) is silently
  load-bearing — `clearSessionsOlderThan` reads files written before
  the union was introduced and has to tolerate any string.
- **Why it matters:** When the JSON output schema (contract surface
  #3) gains a field, three places have to change in lockstep. The
  test files I scanned (`store.test.ts`, etc.) pin specific shapes,
  so the drift is currently caught — but only by accident.
- **Recommendation:** Consolidate to one canonical `Finding` and
  `CheckResult` declared once in `types.ts`, then have `StoredSession`
  import them. Where backward-compat for old session files matters
  (the loose `severity: string`), introduce one explicit
  `LegacyStoredSession` type and a small `migrate` step rather than
  letting the loose typing bleed into the active type. This also
  removes the third copy in `FitDoneResult.findings` — that field
  can become `findings?: { checks: CheckOutput[] }` with the same
  semantic meaning.

### 5. Dashboard renderer in a "contracts" package is a layering smell

- **Files / code:** Entire `packages/contracts/src/persistence/dashboard/`
  subtree (~2,000 LOC, 28 files); barreled out of `index.ts:69-80`.
- **Pattern / principle:** SRP at the package level / Modular Monolith
  (per `docs/architecture/10-mental-model/03-modular-monolith.md`).
  The package is named `contracts` and the `index.ts` header says it
  contains "shared contract types." Yet ~80% of its lines render an
  HTML page. The dashboard generator itself is not a contract; it is
  a presentation layer that *consumes* the `StoredSession` and
  `GraphCatalog` contracts.
- **Status:** Working — fitness's `cli/dashboard.ts` is the single
  caller, dependency-cruiser is satisfied because contracts is layer
  2. But the package's purpose has drifted from what its name says.
- **Why it matters:** Three downstream consequences: (a) any tool
  that wants to skip the dashboard still pulls 2,000 LOC of HTML
  string templates into its dependency closure (contracts is the
  layer fitness, simulation, and a future graph all depend on);
  (b) the package can't be the "thin contracts" target the
  contract-surfaces doc implies; (c) third-party tool authors who
  depend on `@opensip-tools/contracts` for `Tool`-result shapes get
  the dashboard as transitive bag-on-the-side.
- **Recommendation:** Carve the renderer out into its own package —
  `@opensip-tools/dashboard` — that depends on `contracts`. The split
  is mechanical: move `persistence/dashboard/**` and the
  `GraphCatalog`/`StoredSession` *type* re-exports stay in contracts;
  the runtime `generateDashboardHtml` export moves. Fitness's
  `cli/dashboard.ts` updates one import. Persistence (`store.ts`)
  is still a contract-shaped concern — JSON I/O of the well-known
  session shape — and stays. This is the highest-leverage finding in
  this audit; it cleans the package's purpose, shrinks the
  third-party dependency closure, and unlocks finding #1 (the
  generator's signature can break compatibly inside a young package).

### 6. `CliArgs` is a god-object alias keeping legacy callers alive

- **Files / code:** `packages/contracts/src/types.ts:67-97`. Used by
  `simulation/engine/src/tool.ts:25` (`toolOptsToCliArgs`),
  `fitness/engine/src/tool.ts:67` (`fitOptsToCliArgs`),
  `cli/src/commands/init.ts:497` (`executeInit`).
- **Pattern / principle:** ISP / Stamp Coupling. `CliArgs` is the
  superset of every flag any command takes — `gateSave`, `kind`,
  `tags`, `recipe`, `apiKey`, `quiet`, `open`, etc. Each Tool's real
  per-command options live in a focused interface (`FitOptions`,
  `ToolOptions`, `InitOptions`). The Tool implementations then write
  a `*OptsToCliArgs(opts) → CliArgs` adapter to feed the legacy
  function signature.
- **Status:** Working, but the doc-comment on the type is honest about
  what it is: "Backwards-compatible alias — commands that previously
  accepted CliArgs can accept this union instead."
- **Why it matters:** Every Tool author who wants to add a new flag
  has to know whether to extend `CliArgs` (and risk colliding with
  another tool's flag of the same name), `FitOptions`, or both. Two
  tools with a `--kind` flag of different meanings would silently
  overlap in `CliArgs.kind`.
- **Recommendation:** Plan a deprecation: extract per-command
  interfaces (already done — `FitOptions`, `ToolOptions`,
  `InitOptions`), make the inner functions accept the focused type,
  and let `CliArgs` shrink to just the cross-cutting fields (`cwd`,
  `json`, `verbose`, `debug`). Don't rip it out — the `*OptsToCliArgs`
  adapters in the Tool packages are doing real work today — but flag
  it as a slow-burn refactor in the package CHANGELOG so future PRs
  stop adding fields to `CliArgs`. (This finding is largely a
  documentation/policy fix, not a code change.)

### 7. `panelOrchestratorJs` mixes Code Paths setup with Overview navigation

- **Files / code:**
  `packages/contracts/src/persistence/dashboard/code-paths.ts:63-216`
  (`panelOrchestratorJs`); cooperative call from
  `overview.ts:33-50` invokes `openCodePathsSession` by string-name
  guard.
- **Pattern / principle:** SRP. `panelOrchestratorJs` does five
  things: panel construction, subtab switching, filter chip rendering
  delegation, view rendering loop, and `openCodePathsSession` (a
  cross-tab navigation helper exposed by name to `overview.ts`).
  The first four belong to Code Paths; the fifth is a navigation
  protocol that other tabs need.
- **Status:** Working via `typeof openCodePathsSession === 'function'`
  guard at the call site. Both files have to know the global name.
- **Why it matters:** A tool ship-extending the dashboard (per
  finding #5's hypothetical) has no defined way to register a
  "click my row" handler — it has to add a global function and
  teach `overview.ts` about it. This is a coupling channel the
  contracts package owns by accident.
- **Recommendation:** Promote the cross-tab handoff to a tiny
  registry: `const tabActivators = { graph: openCodePathsSession,
  fit: …, sim: … };` declared in `shared.ts` with one
  `activateTabForSession(s)` helper. Each tool's panel module
  registers its activator into the table; `overview.ts` calls
  `activateTabForSession(s)` instead of name-checking. Ten lines
  of code, removes one global handshake. Aligns with finding #1
  if the renderer ships externalized.

### 8. The barrel re-exports a heavy module behind a lightweight name

- **Files / code:** `packages/contracts/src/index.ts:69-80`.
- **Pattern / principle:** Façade / barrel hygiene. The barrel groups
  exports by section (CLI options, results, exit codes, persistence,
  dashboard) and the top of the file says `contracts depends only on
  @opensip-tools/core`. That's true at the package level, but the
  dashboard re-exports pull ~2,000 LOC of JS-string templates into
  every tree-shake-incomplete consumer.
- **Status:** Tree-shaking modern bundlers should DCE the unused
  paths. ESM + the `package.json` `exports` field will help. But
  `dist/index.d.ts` always includes the dashboard types, and Node
  environments without aggressive tree-shaking pay the parse cost.
- **Why it matters:** Tertiary to finding #5 — once `dashboard`
  splits out, the barrel naturally slims down.
- **Recommendation:** No standalone change. Resolves with finding
  #5. If the split is rejected, consider a `@opensip-tools/contracts/dashboard`
  subpath export so tools that don't need the dashboard can avoid
  importing it transitively. The CLAUDE.md notes subpath exports
  are "strongly discouraged," so finding #5's package split is the
  preferred path.

## Non-findings considered and dismissed

- **"Use a class hierarchy for `CommandResult`."** Tempting on first
  read — every result type has a `type` discriminant; classes would
  let each result render itself. Rejected: discriminated unions are
  cheaper, narrower, and keep the dispatch in `App.tsx` where it
  belongs (next to the rendering knowledge). The current shape is
  the right shape. The single-direction flow `CommandResult →
  switch (result.type)` in `App.tsx:32` is exactly how a tagged
  union should be consumed.
- **"Make the dashboard a real React/Preact app."** Out of scope. The
  "self-contained HTML, no bundler" constraint is intentional — the
  generator emits a single file the user can email, attach to a PR,
  or open offline. A framework would force a build step and break
  that property. The vanilla-DOM approach is the correct trade-off
  even though it costs the duplication called out in finding #2.
- **"Replace `getErrorSuggestion` with a Chain of Responsibility class."**
  Mentioned in the audit prompt as a possibility. Rejected as ceremony
  — a flat declarative table (finding #3) is the right shape. CoR
  buys you nothing here that an array of `{ match, suggest }` tuples
  doesn't, and costs you a class hierarchy.
- **"Extract a `Renderer` Strategy interface for the seven views."**
  Already effectively present — each view's `render(container, catalog,
  indexes, filterState)` signature is a Strategy in everything but name.
  The duplication called out in finding #2 is in the *body* of the
  Strategy implementations (the rank-and-render skeleton), not in the
  Strategy abstraction itself. A `defineRankedView` helper is
  sufficient; a formal interface would not improve anything.
- **"Inline-script CSP risk in the dashboard generator."** The generator
  already uses `escapeForScriptContext` to neutralize `<` and `>` in
  serialized JSON (`generator.ts:22`). The whole document is a single
  HTML file the user opens locally; CSP is the consumer's choice,
  not a contract concern.
- **"Persistence module should hide its file-format details."** It
  already does — `saveSession` and `loadSessions` are the only path
  in/out, the `MAX_SESSIONS` cap is internal, the timestamp filename
  format is internal. The contracts surfaces doc explicitly says
  session record format is *not* a contract. The current encapsulation
  is correct.
- **"`CliOutput.tool` literal `'fit' | 'sim' | 'graph'` is a closed
  set that hardcodes tool identity into contracts."** True but
  intentional — the contracts surface doc treats `tool` as a stable
  enum and a third tool joining the union is a minor-version bump.
  Opening it to `string` would weaken the JSON-output contract for
  no callsite gain.
