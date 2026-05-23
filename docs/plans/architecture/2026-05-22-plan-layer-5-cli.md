---
status: current
last_verified: 2026-05-22
title: "Layer 5 (cli) — remediation plan"
audience: [contributors, architects]
related-audits:
  - ./2026-05-22-architecture-cli.md
related-plans:
  - ./2026-05-22-plan-layer-2-contracts.md
  - ./2026-05-22-plan-layer-3-tools-and-lang.md
---
# Layer 5 (cli) — remediation plan

## Summary

`@opensip-tools/cli` is doing its composition-root job: lower layers carry
no knowledge of CLI internals, the layer-cruiser rule
`core ← contracts ← (lang-*, fitness, simulation, graph) ← cli` is
honoured, and `--help` works without surprise. The package's pain points
are all upstream of that good shape. `index.ts` has grown into a
~540-line god-module that mixes bootstrap, registration, command
mounting, error mapping, and exit-code arbitration in one closure soup
(F1). The `ToolCliContext` boundary that is supposed to seal the CLI
from individual tools leaks twice: through `program: unknown` (which
every tool casts to `Command`) and through `renderLive(viewKey: string,
…)` (which dispatches on tool-specific keys inside the supposedly-generic
CLI) (F2). And the Ink view layer, which should be a pure renderer of
`CommandResult`, in fact reaches into `@opensip-tools/fitness` and
`@opensip-tools/graph` to drive their run loops — making "live view" a
fiction (F3).

The remaining findings are smaller and well-scoped: the error-suggestion
ladder in contracts duplicates a fall-through in `index.ts` and bypasses
the exit-code seam (F4); the subcommand `.action()` blocks repeat the
same render-then-exit dance five times (F5); `clear.ts`/`configure.ts`
bypass Ink with raw ANSI (F6); `App.tsx`'s `toPluginAction` re-validates
a contract that was supposed to be typed (F7); the update-notifier
doc/code drift (F8); regex-driven YAML mutation in `plugin.ts` (F9);
and a subtle ordering bug in the `preAction` hook around `setSilent`
vs config-merged options (F10). None of these are blocking — they are
clean-ups that shrink the CLI's contract surface and make the
dispatcher genuinely tool-agnostic.

## Sequencing rationale

Two cross-layer dependencies drive ordering:

1. **F2 + F3 require a Layer 1 contract change.** Both findings hinge
   on what `Tool.renderLive` looks like. Today `renderLive(viewKey:
   string, args: unknown)` lives on `ToolCliContext` (defined in
   `@opensip-tools/core`) and dispatches on string keys inside the
   CLI. Per the consistency pass
   (`./2026-05-22-plan-consistency-pass.md`) Conflict 2, the contract
   change is owned by **Layer 1 Phase 8** ("Tool.renderLive contract
   refresh"). The recommended option is option (2) — replace
   `renderLive(viewKey, args)` with
   `ToolCliContext.registerLiveView(key, renderer)`. Phase 2 here
   cannot land before Layer 1 Phase 8.
2. **F4 overlaps Layer 2 finding #3.** The contracts audit calls out the
   same `getErrorSuggestion` ladder. The Layer 2 plan is rewriting it
   into a strategy-table (or typed-error) shape. Phase 3 here is the
   CLI-side half: route the catch handler through `setExitCode`, throw
   typed errors from CLI commands, and remove the duplicated
   substring-match logic from `index.ts`'s `parseAsync().catch(...)`.
   The CLI plan must consume whatever shape Layer 2 picks rather than
   invent its own.

Phase 1 (decompose `index.ts`) is independent of either dependency and
is the structural foundation everything else builds on — splitting
`bootstrap.ts`/`cli-context.ts`/`cli-commands.ts` first makes Phases
2–8 each touch a smaller, more obvious file. Phases 4–8 are
self-contained and can be parallelized once Phase 1 lands; the order
below is by priority, not strict dependency.

There is also a Layer 2 dashboard split (Layer 2 may extract the
dashboard into `@opensip-tools/dashboard`). That work touches
`packages/cli/src/open-dashboard.ts`'s import surface but does not
change its behaviour — captured in Phase 8 as a coordination item.

## Phase 1 — Decompose `index.ts` into composition-root + extracted modules

**Closes:** F1
**Priority:** P0 — structural foundation; every later phase touches a
smaller, more obvious file once this lands.
**Depends on:** nothing.

**Goal:** `packages/cli/src/index.ts` shrinks to ~60 lines that read
top-to-bottom as the composition wiring. Each step the audit calls
out — language adapter registration, tool registration, ToolCliContext
construction, CLI-owned command mounting, the catch handler — moves to
its own file, takes injected dependencies, and is unit-testable in
isolation.

**Extractions (concrete file plan):**

- `packages/cli/src/bootstrap/register-language-adapters.ts` — pure
  function that takes a `LanguageRegistry` and registers the six
  bundled adapters (TypeScript, Rust, Python, Java, Go, C/C++).
  Replaces the module-load side effect block at `index.ts:60–73`.
- `packages/cli/src/bootstrap/register-tools.ts` — registers
  `fitnessTool`, `simulationTool`, and `graphTool` into a
  `ToolRegistry`. Replaces the loops at `index.ts:273–326` and the
  `discoverToolPackages()` call.
- `packages/cli/src/bootstrap/index.ts` — barrel re-export +
  `bootstrapCli({ langRegistry, toolRegistry })` orchestrator that
  composes the two above. The composition is the *only* thing
  `index.ts` calls.
- `packages/cli/src/cli-context.ts` — `buildToolCliContext({ program,
  render, renderLive, setExitCode, … })` factory. Removes the inline
  closure at `index.ts:213–268`. Drop the dead `void exitCode` capture
  ("for future debug logging") — either materialize it as a real debug
  log or delete it.
- `packages/cli/src/commands/index.ts` (or `cli-commands.ts`) —
  `registerCliCommands(program, ctx)` body extracted from
  `index.ts:336–491`. The function already exists; it just needs to
  live in its own file.
- `packages/cli/src/error-handler.ts` — the `parseAsync().catch(...)`
  block at `index.ts:511–531` becomes `handleParseError(error,
  setExitCode)`. Currently sets `process.exitCode` directly; the
  extraction is also the place to route through `setExitCode`. (Phase
  3 finishes the substantive change; this phase is the move.)

**Tests added (must exist before extractions are merged):**

- `bootstrap.test.ts` — given an in-memory `ToolRegistry`, calling
  `bootstrapCli({...})` registers fitness/simulation/graph in the
  documented order and discovers third-party tools from a fake
  `node_modules` fixture. Closes the audit's "no integration test for
  the bootstrap order" gap.
- `cli-context.test.ts` — `buildToolCliContext({...})` returns a
  context whose `setExitCode` mutates the captured exit code and whose
  `render`/`renderLive` delegate to the injected functions.
- `commands.test.ts` — registering CLI-owned commands against a fresh
  `Command` instance produces the expected subcommand names.

**Done when:**

- `index.ts` is under 80 lines, contains no inline `.action()` bodies,
  no inline ToolCliContext closure, no module-level for-of registration
  loops.
- All extracted modules have unit tests.
- `pnpm typecheck && pnpm test && pnpm lint` clean.

## Phase 2 — Fix Tool contract leaks (depends on Layer 3 plan)

**Closes:** F2 (and the audit's note about `App.tsx`'s `toPluginAction`
re-validation in F7's prelude — partially)
**Priority:** P0 — highest-leverage architectural finding. The
"adding a tool requires zero CLI edits" claim is currently false
because of the `viewKey === 'fit' / viewKey === 'graph'` switch.
**Depends on:** Layer 1 plan Phase 8 ("Tool.renderLive contract
refresh"). Per the consistency pass
(`./2026-05-22-plan-consistency-pass.md`) Conflict 2, the contract
change lives in `@opensip-tools/core` (where `ToolCliContext` is
defined), not in Layer 3. This phase cannot land before Layer 1
Phase 8.

**Goal:** Adding a fourth tool with a live view must require zero
edits to `packages/cli/src/index.ts`. The `program: unknown` cast goes
away or becomes a typed re-export. The `renderLive(viewKey: string,
…)` switch goes away.

**Coordination (resolved by consistency pass):** Layer 1 Phase 8
selects option (2) below as the canonical shape. The audit's three
options are recorded here for context:

1. **Lowest friction.** Keep `program: unknown` but ship a
   `commander/v13` peer-dep contract on every tool package and add
   a typed re-export in `@opensip-tools/contracts`
   (`export type CliProgram = Command`). Tools import that, get a real
   type, and the cast disappears. Leaves the `viewKey` switch as-is —
   only addresses the type half of the leak.
2. **Medium.** Replace `renderLive(viewKey, args)` with a registration
   API: `ToolCliContext.registerLiveView(key, render)`. Each tool
   contributes its own view at `register(cli)` time. The CLI no
   longer hard-codes `'fit'` / `'graph'`.
3. **Highest.** Invert the seam: `Tool.renderLive(args): ReactNode`
   and the CLI just hands stdout to whatever the tool returns. Cleanest
   long-term shape; largest diff because every tool adopts.

Layer 1 Phase 8 picks option (2). The CLI plan implements the
CLI-side adoption: removes the `viewKey` switch, replaces it with
the registry lookup, calls `cli.registerLiveView('fit', ...)` for
fitness and `'graph'` for graph from each tool's `register()`
function. (Tool-side `register()` updates land alongside Layer 5
Phase 3 / Layer 3 controller relocation.)

**Implementation (assuming option 2):**

- `packages/core/src/tools/types.ts` — owned by **Layer 1 Phase 8**.
  Defines `registerLiveView(key, renderer)`, the `LiveViewRenderer`
  type, and `UnknownLiveViewError`. This phase consumes those.
- `packages/cli/src/cli-context.ts` (from Phase 1) — implement the
  registry as a `Map<string, LiveViewRenderer>`. `renderLive` calls
  through it, throwing `UnknownLiveViewError` if the key is missing
  rather than silently falling through to `renderApp` (closes the
  audit's "tool that mistypes its `viewKey` gets a static render" gap).
- Each tool's `register(cli)` calls
  `cli.registerLiveView('fit', renderFitLive)` /
  `'graph', renderGraphLive` etc. The CLI's `index.ts` and
  `cli-context.ts` no longer mention `'fit'` or `'graph'` by name.
- `packages/contracts/src/index.ts` — owned by **Layer 2 Phase 5**
  (per consistency pass Conflict 3). Adds the `CliProgram` re-export.
  Tools update their casts: `cli.program as CliProgram`.

**Done when:**

- `grep -r "viewKey === " packages/cli/src/` returns no hits.
- `grep -r "as Command" packages/{fitness,simulation,graph}/` returns
  no hits (tools import `CliProgram` instead).
- A test in `cli-context.test.ts` registers a fake tool, calls
  `renderLive('fake-view', {})`, and confirms the registered renderer
  is invoked.

## Phase 3 — Move tool controllers out of `cli/ui/components` (depends on Layer 3 plan)

**Closes:** F3
**Priority:** P1 — second-highest architectural finding. Currently
`cli/ui/` de facto depends on `@opensip-tools/fitness` and
`@opensip-tools/graph` because the components import them; the
dependency-cruiser layer rule has to be lenient or fitness becomes a
peer of CLI rather than a layer below.
**Depends on:** Phase 2 (the new live-view contract). Layer 3 plan
must accept ownership of the controller halves.

**Goal:** `packages/cli/src/ui/` imports only `@opensip-tools/contracts`
types. The state machine over `loading → running → done → error` and
the "kick off `executeFit` / `runGraph`, post to cloud, build report
lines" controller logic moves to the tool packages.

**Concrete moves:**

- `packages/fitness/engine/src/cli/fit-runner.ts` (new) — owns the
  state machine and `executeFit` / `reportToCloud` orchestration.
  Exposes a progress event stream (`onProgress` already exists; just
  surface it). Mounted by fitness via `cli.registerLiveView('fit',
  renderFitLive)` from Phase 2.
- `packages/graph/engine/src/cli/graph-runner.ts` (new) — owns
  `runGraph` orchestration and `buildUnifiedReportLines`. The
  `GRAPH_STAGES` import currently in `GraphView.tsx:15–22` moves into
  this file.
- `packages/cli/src/ui/components/FitView.tsx` becomes a pure
  renderer that takes a `FitProgressEvent` stream and a final
  `CommandResult` and renders them. No `executeFit`, no
  `reportToCloud`, no state machine.
- `packages/cli/src/ui/components/GraphView.tsx` becomes a pure
  renderer of stage-progress events. No `GRAPH_STAGES` import, no
  `runGraph`, no `buildUnifiedReportLines`.
- After this lands: `cli/ui` imports only contract types. The
  documented exception in `.dependency-cruiser.cjs` for the view layer
  can be removed or tightened.

**Done when:**

- `grep -r "from '@opensip-tools/fitness'" packages/cli/src/ui/`
  returns no hits.
- `grep -r "from '@opensip-tools/graph'" packages/cli/src/ui/`
  returns no hits.
- Both tools register their live views via the Phase 2 API.
- A view-layer test renders `FitView` against a synthetic progress
  stream without importing fitness.

## Phase 4 — Strengthen error mapping (coordinate with Layer 2 plan)

**Closes:** F4
**Priority:** P1 — currently `process.exitCode` is set both via
`ToolCliContext.setExitCode` (the contract path) and directly in
`index.ts`'s catch handler (the bypass). One write path, please.
**Depends on:** Layer 2 plan finding #3 (`getErrorSuggestion`) — that
plan is rewriting the substring-match ladder into either a typed-error
hierarchy or a strategy table. The CLI-side change must consume
whatever shape Layer 2 picks.

**Goal:** Tools and the dispatcher agree on a single exit-code write
path. Suggestions are produced from typed errors (or from a
strategy-table) rather than from `Error.message.includes(...)`. The
duplicated catch logic in `index.ts` goes away.

**Coordination with Layer 2:**

- Layer 2 plan owns the contract change (typed `OpenSipError`
  hierarchy: `CheckNotFoundError`, `RecipeNotFoundError`,
  `ConfigError`, `ReportError`, `MissingChecksError`, etc.; or
  strategy-table replacement of `getErrorSuggestion`).
- This plan owns the CLI-side adoption: throw the typed errors from
  CLI-owned commands (`init`, `sessions`, `configure`, `plugin`,
  `completion`, `uninstall`) where applicable, and route the catch
  handler through `setExitCode`.

**Implementation:**

- `packages/cli/src/error-handler.ts` (extracted in Phase 1) — the
  `parseAsync().catch(...)` body becomes:
  - Match on `instanceof` against the typed errors from contracts
    (Layer 2's hierarchy).
  - For unknown errors, fall back to the existing
    `getErrorSuggestion` (which Layer 2 has tightened).
  - Always call `setExitCode(code)` — never write `process.exitCode`
    directly. The Phase 1 extraction takes `setExitCode` as a
    parameter so this is mechanical.
- CLI commands that currently rely on substring messaging (e.g. the
  `init` action's `ambiguousLanguageError` special case at
  `index.ts:346–378`) throw a typed `AmbiguousLanguageError` instead.

**Done when:**

- `grep -rn "process.exitCode" packages/cli/src/` returns at most one
  hit (inside `cli-context.ts`'s `setExitCode` implementation).
- The catch handler matches on `instanceof`; substring matching is
  fallback only.
- A test asserts that throwing `CheckNotFoundError` from a tool's
  command surfaces the right exit code and the right suggestion.

## Phase 5 — Subcommand action adapter and consistent `--json` handling

**Closes:** F5
**Priority:** P2 — quality-of-life and consistency. Reduces the
boilerplate every new CLI-owned subcommand has to remember.
**Depends on:** Phase 1 (the `cli-commands.ts` extraction); Phase 4
(uses `setExitCode` consistently).

**Goal:** Every CLI-owned subcommand follows the same pattern — execute
a function, render its result, set exit code, honour `--json`. Today
`init` honours `--json` correctly, `sessions list` ignores it
(renders through Ink even with `--json`), `sessions purge` writes its
own ANSI banner, and `plugin add/remove/list/sync` each repeat the
render-then-exit dance verbatim.

**Implementation:**

- `packages/cli/src/commands/mount-result-command.ts` (new) — the
  helper from the audit's recommendation:
  ```
  type CommandHandler<T> = (opts: T) => CommandResult | Promise<CommandResult>;
  function mountResultCommand<T>(cmd: Command, handler: CommandHandler<T>): void
  ```
  Centralizes JSON short-circuit, Ink render, and exit-code setting
  through the Phase 1 `setExitCode`.
- Refactor `init`, `sessions list`, `plugin list/add/remove/sync` to
  use `mountResultCommand`. `sessions purge` becomes a `mountResultCommand`
  user once Phase 6 returns its result instead of writing inline.

**Done when:**

- `init`, `sessions list`, `plugin *` action bodies are 1–3 lines
  each.
- All result-producing commands honour `--json` consistently
  (`sessions list --json` no longer routes through Ink).
- A test exercises `mountResultCommand` with a synthetic handler and
  confirms JSON output bypasses Ink.

## Phase 6 — Single rendering pipeline (eliminate raw-ANSI bypasses)

**Closes:** F6
**Priority:** P2 — UX consistency.
**Depends on:** Phase 5 (`mountResultCommand`) so `clear` and
`configure` plug in cleanly.

**Goal:** No CLI command writes ANSI escape codes directly. The Ink
renderer is the single output pipeline; raw I/O is reserved for
prompts (where Ink's `useInput` raw-mode requirement is genuinely
incompatible).

**Concrete changes:**

- `packages/cli/src/commands/clear.ts` — `executeClear` returns its
  `ClearResult` without writing. The banner moves into `App.tsx`'s
  existing `case 'clear-done':` branch (currently dead). The ANSI
  helpers at `clear.ts:36–46` go away. `readline` stays for the
  prompt.
- `packages/cli/src/commands/configure.ts` — same shape: prompts via
  `readline`, but banners and result lines render via the Ink
  renderer through `mountResultCommand`. The `console.log` calls at
  `configure.ts:75–95` go away.
- The `theme.ts` colour controls (and `NO_COLOR=1`) now apply
  uniformly; users no longer get coloured banners despite
  `NO_COLOR=1`.

**Done when:**

- `grep -rn "\\x1b\\[" packages/cli/src/commands/` returns no hits.
- `grep -rn "console.log" packages/cli/src/commands/` returns no hits
  outside debug paths.
- The dead `case 'clear-done':` branch in `App.tsx` is now exercised
  by a test.

## Phase 7 — Discriminated `PluginResult` (delete `toPluginAction` casts)

**Closes:** F7
**Priority:** P2 — type-safety win.
**Depends on:** nothing (independent of other phases).

**Goal:** `PluginResult` becomes a discriminated union; the
`(result.plugins as { … }[])` casts in `App.tsx`'s `toPluginAction` go
away; the silent `'add'` vs `'install'` discriminator mismatch
surfaces at compile time.

**Implementation:**

- `packages/contracts/src/types.ts:291–295` — replace the open
  dictionary with the union shape from the audit's recommendation:
  ```
  export type PluginResult =
    | { type: 'plugin'; action: 'list';   plugins: PluginInfo[]; totalCount: number }
    | { type: 'plugin'; action: 'add';    packageName: string; success: boolean; error?: string }
    | { type: 'plugin'; action: 'remove'; packageName: string; success: boolean; error?: string }
    | { type: 'plugin'; action: 'sync';   synced: SyncEntry[]; errors?: string[]; success: boolean };
  ```
- `packages/cli/src/commands/plugin.ts` — producers return the
  discriminated shape; the `'install'` action label is unified to
  `'add'` (or vice versa — pick one and align).
- `packages/cli/src/ui/App.tsx:206–230` — `toPluginAction` becomes a
  one-line switch with no casts. The component-side `PluginAction`
  type is the contract directly (or imports from contracts).

**Done when:**

- `grep -rn "as { " packages/cli/src/ui/App.tsx` returns no hits in
  `toPluginAction`.
- `pnpm typecheck` catches a producer/consumer action-label mismatch
  if introduced.

## Phase 8 — Smaller cleanups and coordination items

**Closes:** F8, F9, F10; coordination of dashboard split with Layer 2.
**Priority:** P2 — independent quick wins.
**Depends on:** Layer 2 plan for the dashboard split portion.

**F8 — update notifier doc/code drift.** Decide:

- (a) Call `maybeNotify(...)` *before* the welcome short-circuit so
  bare `opensip-tools` invocations also surface updates, **or**
- (b) Leave the code as-is and update
  `docs/architecture/01-cli-dispatch.md:107–110` to say "the update
  notifier fires on every command, but not on bare `opensip-tools`."

Recommend (b) — don't nag on zero-arg runs is the better UX. Doc-only
change.

**F9 — YAML AST mutation in `plugin.ts`.** Replace the regex-driven
edits in `addToConfigPluginList` / `removeFromConfigPluginList`
(`packages/cli/src/commands/plugin.ts:85–196`) with the `yaml`
package's Document API (already a dep, used by `configure.ts`).
Round-trips comments and ordering correctly. Add a precondition
check: if the parsed document doesn't have the expected shape, fail
closed with a clear error rather than appending a duplicate
`plugins:` block.

**F10 — `preAction` ordering.** In
`packages/cli/src/index.ts:217–241`, move `loadCliDefaults` +
`mergeConfigDefaults` ahead of `setSilent` / `setDebugMode`. Read
`opts.verbose` and `opts.debug` from the *merged* opts when deciding
silent/debug state. Removes the implicit dependency on
"`setDebugMode(true)` happens to override silent in the logger." After
Phase 1 this lives in `bootstrap/` rather than `index.ts`.

**Dashboard import update (coordinate with Layer 2 plan).** If Layer 2
extracts the dashboard into `@opensip-tools/dashboard`, update
`packages/cli/src/open-dashboard.ts`'s import to point at the new
package. Behaviour unchanged. Done as a one-line PR once Layer 2's
extraction lands.

**Subcommand-list drift test (audit non-finding worth closing).** Add a
test that asserts `SUBCOMMANDS` in `commands/completion.ts` matches
`defaultToolRegistry.list()` plus the CLI-owned commands at build
time. The audit dismissed the static completion list as a non-finding
but flagged drift as the failure mode; this test closes that loop.

**Done when:**

- F8 doc drift resolved either by code or doc change.
- `plugin.ts` YAML edits go through the `yaml` Document API.
- `preAction` order is `loadConfig → merge → derive silent/debug`.
- Subcommand-list drift test exists and passes.
- `open-dashboard.ts` import matches whatever Layer 2 ships.

## Deferred

- **Make `--report-to` auto-open external dashboards.** Audit
  non-finding, feature request. Out of scope for this remediation
  pass.
- **Make the welcome screen dynamic from the tool registry.** Audit
  non-finding (progressive disclosure is a deliberate UX call). Worth
  revisiting if a fourth first-party tool ships.
- **DI-container for the tool registry.** Audit non-finding —
  third-party tools register as a side effect of import; a DI shape
  would break the discovery story. Re-examine only if singleton
  semantics cause a concrete bug.
- **Lazy tool loading for faster startup.** Audit non-finding —
  `--help` discovery requires every tool's `commands[]` up front. The
  ~30ms bootstrap cost is acceptable. Revisit only if tool count
  grows substantially.
- **Module-load side effects for language adapter registration.** Audit
  non-finding — adapters MUST be in place before any check evaluates
  a file. Phase 1 moves the *implementation* into `bootstrap/`, but
  the call site stays at module-load.
