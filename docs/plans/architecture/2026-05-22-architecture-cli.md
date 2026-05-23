---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/cli"
package: "@opensip-tools/cli"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/cli

## Summary

`@opensip-tools/cli` is the composition root for the `opensip-tools` binary.
It registers language adapters and tools, walks `node_modules` for
third-party tools, mounts CLI-owned commands (`init`, `configure`,
`sessions`, `plugin`, `completion`, `uninstall`), wraps the Ink renderer,
and runs Commander. The package's architectural intent — be a generic
dispatcher that knows nothing about `fit`/`sim`/`graph` — is largely
honoured: `index.ts` contains zero `fitness`-shaped logic in its CLI
wiring path, and adding a new tool requires no edit here.

The composition-root pattern is correctly applied. Several real seams
exist (Tool registry, ToolCliContext, language registry) and they
genuinely allow extension. The audit-worthy weaknesses cluster around
three themes:

1. `index.ts` does too many things at the top level — it is half kernel
   bootstrap, half service container, half "package.json reader" — and
   most of those things are not testable in isolation because they run
   as module-load side effects.
2. The `ToolCliContext` boundary leaks Commander coupling through
   `program: unknown`, and the `viewKey: string` switch in `renderLive`
   re-introduces a tool-aware registry inside the supposedly-generic
   CLI.
3. The Ink view layer mixes "render a `CommandResult`" (data → view) with
   "drive a fit/graph run" (controller). `FitView` and `GraphView` import
   `@opensip-tools/fitness` and `@opensip-tools/graph` directly — i.e.
   the CLI's generic UI layer holds first-party tool dependencies.

None of these are blocking; the design works. They are recommended
clean-ups that shrink the contract surface and make the dispatcher
genuinely tool-agnostic.

## Existing patterns (correct usage)

- **Composition root.** `index.ts` is the only file that wires every
  package together. Lower layers (core, contracts, lang-*) carry no
  knowledge of CLI internals. Module-load side effects are scoped to
  this one file.
- **Registry pattern (Singleton-ish).** `defaultLanguageRegistry` and
  `defaultToolRegistry` (in core) act as process-wide registries.
  Last-writer-wins semantics on the tool registry is the documented
  override mechanism for third-party tools (see
  `docs/architecture/10-mental-model/02-tool-plugin-model.md`).
- **Inversion of control via `ToolCliContext`.** Tools depend on the
  context interface (in core) rather than on `@opensip-tools/cli`. This
  inverts the dependency arrow correctly — fitness/simulation/graph do
  not import the CLI package, the CLI imports them.
- **Pure decision functions.** `decideOpen()` in `open-dashboard.ts` is
  a textbook pure decision function, separated from `launchBrowser()`
  which performs the I/O. This is exactly the right shape for a
  side-effecting helper.
- **Static welcome / static completion scripts.** `welcome.ts` and
  `commands/completion.ts` are pure string builders with thin
  printer wrappers. Both are independently unit-testable.
- **Layer enforcement.** `.dependency-cruiser.cjs` enforces
  `core ← contracts ← (lang-*, fitness, simulation) ← cli` and the
  package builds clean against it. The CLI is correctly the only
  package allowed to depend on every tool.
- **`uninstall.ts` testability.** The command takes injected `prompt`,
  `write`, `rootDir`, and `cwd` overrides. This is a small, deliberate
  example of using parameter injection rather than reaching for module
  state, and it should be the model for the other commands.

---

## Findings

### F1 — `index.ts` is a god-module: bootstrap, registration, rendering bridge, error mapper, exit-code mediator, and Commander wiring all in one file

- **Files / code:** `packages/cli/src/index.ts` (lines 60–73 lang
  adapter registration, 213–268 ToolCliContext + program creation,
  273–326 tool registration loops, 336–491 every CLI-owned command
  wired inline, 497–531 main + parseAsync error handler).
- **Pattern / principle:** SRP, Composition Root. A composition root
  *should* be large; it should not also be the *implementation* of any
  step it composes.
- **Status:** Active smell. ~540 lines doing six categorically distinct
  jobs.
- **Why it matters:** Three knock-on effects:
  1. None of the bootstrap is unit-testable. The file's most important
     contract — "first-party tools are registered before discovery, then
     `register()` is called in registration order, then CLI commands
     are mounted" — has no integration test because every step is bare
     module-level code or a closure inside `main()`.
  2. The error renderer in `parseAsync().catch(...)` (lines 511–530)
     mirrors `getErrorSuggestion` logic that already lives in contracts,
     and at the same time bypasses the `ToolCliContext.setExitCode`
     contract (sets `process.exitCode` directly).
  3. The `ToolCliContext` factory captures an unused `exitCode` closure
     (lines 248, 266 `void exitCode`) that exists "for future debug
     logging" — dead intent that should either materialize or be deleted.
- **Recommendation:** Extract three modules and let `index.ts` shrink to
  the actual composition wiring:
  - `bootstrap.ts` — `registerLanguageAdapters()`, `loadDiscoveredTools()`,
    `registerAllTools()` returning a populated program. Pure functions
    that take a registry and produce side effects on it; testable with
    in-memory fakes.
  - `cli-context.ts` — `buildToolCliContext(program, render, …)`
    factory. Removes the inline closure.
  - `cli-commands.ts` — the `registerCliCommands(program, ctx)` body.
    Already a function; just lift it to its own file so `index.ts` no
    longer holds 150 lines of `init`/`sessions`/`configure`/`plugin`/
    `completion`/`uninstall` Commander wiring.
  After extraction, `index.ts` reads as a 60-line composition root.

### F2 — `ToolCliContext.program: unknown` and `renderLive(viewKey: string)` leak the abstraction the contract is supposed to seal

- **Files / code:**
  `packages/core/src/tools/types.ts:60–94` (the contract);
  `packages/cli/src/index.ts:169–184` (the `if (viewKey === 'fit') …`
  switch); each Tool casts `program as Command` (e.g. fitness, graph,
  simulation tool files).
- **Pattern / principle:** Interface segregation, Liskov, DIP. An
  `unknown` typed seam plus an unbounded string-key dispatch is two
  abstraction *gaps*, not one abstraction.
- **Status:** Active. Documented as deliberate (the doc says "typed
  loosely so the contract doesn't pin every tool to a specific Commander
  major version") but the cost is real.
- **Why it matters:**
  - Every tool casts `cli.program as Command`. Each cast is an opaque
    coupling point: if `commander` ships breaking changes, every tool
    breaks at runtime, not at compile time.
  - The string-keyed `renderLive` (`if (viewKey === 'fit') … if
    (viewKey === 'graph') …`) re-introduces the exact tool-aware
    branching the dispatcher is supposed to avoid. Adding a fourth tool
    with a live view requires editing `index.ts` — defeating the
    "adding a tool requires zero CLI edits" claim in the architecture
    docs.
  - The "fall through to `renderApp`" branch silently masks bugs: a
    tool that mistypes its `viewKey` gets a static render with no
    diagnostic.
- **Recommendation:** Three options, ranked by ambition:
  1. Lowest friction: keep `program: unknown` but ship a
     `commander/v13` peer-dep contract on every tool package and add
     a typed re-export in `@opensip-tools/contracts`
     (`export type CliProgram = Command`). Tools import that and get a
     real type.
  2. Medium: replace `renderLive(viewKey, args)` with a registration
     API: `ToolCliContext.registerLiveView(key, render)` so each tool
     contributes its own view. The CLI no longer hard-codes `'fit'` /
     `'graph'`.
  3. Highest: invert the seam entirely — let tools mount Ink
     components by passing a React node back to the CLI. Reasonable
     long term; large diff.

### F3 — Ink view layer holds direct dependencies on first-party tool packages

- **Files / code:**
  `packages/cli/src/ui/components/FitView.tsx:8` (`import { … } from
  '@opensip-tools/fitness'`),
  `packages/cli/src/ui/components/GraphView.tsx:15–22` (`import { … }
  from '@opensip-tools/graph'`).
- **Pattern / principle:** DIP, layer ownership. The CLI's generic
  rendering layer should not take hard deps on individual tools.
- **Status:** Active. Both views call into the tool's runner
  (`executeFit`, `runGraph`, `reportToCloud`, `ensureChecksLoaded`,
  `buildUnifiedReportLines`) and re-implement controller logic
  (state machine over `loading → running → done → error`).
- **Why it matters:**
  - The rendering layer is supposed to render `CommandResult` shapes
    from `@opensip-tools/contracts`. `FitView` instead orchestrates
    the run itself: kicks off `executeFit`, polls progress, and posts
    results to cloud. That responsibility belongs to the fitness tool's
    own command handler.
  - `GraphView` has the same problem in a more entangled form — it
    knows the names of every graph stage and renders stage progress
    by importing `GRAPH_STAGES` directly.
  - The "live view" abstraction is therefore a fiction: each "view"
    is in fact a controller for a specific tool's run loop. `cli/ui`
    de facto depends on the `fitness` and `graph` engines.
- **Recommendation:** Move the controller halves of these components
  into their respective tool packages:
  - `packages/fitness/engine/src/cli/fit-runner.ts` should own the
    state machine and `executeFit`/`reportToCloud` orchestration.
  - `packages/graph/engine/src/cli/graph-runner.ts` should own
    `runGraph` orchestration and `buildUnifiedReportLines`.
  Each tool then exposes a *progress event stream* (already present —
  `onProgress`) and the CLI's view becomes a pure renderer of stream
  events. With that split, `cli/ui` imports only contract types, and
  the dependency-cruiser layer rule doesn't have to special-case the
  view layer.

### F4 — `getErrorSuggestion` is a brittle if/else chain on substring matches; the wire-up duplicates that logic in `index.ts`

- **Files / code:** `packages/contracts/src/exit-codes.ts:15–74` (the
  ladder); `packages/cli/src/index.ts:511–530` (the catch block that
  re-classifies a fall-through into `RUNTIME_ERROR`).
- **Pattern / principle:** Chain of Responsibility / strategy table.
  GoF-correct shape exists in concept but has been collapsed into a
  switch over `Error.message.includes(...)` which is the worst of both
  worlds.
- **Status:** Active. Several rules overlap (`message.includes('not
  found')` vs `message.includes('opensip-tools.config.yml')` vs the
  generic `message.includes('config')`); evaluation order alone decides
  which suggestion wins.
- **Why it matters:**
  - Localization-fragile: any error rewording in a downstream package
    silently flips the suggestion or kills the mapping.
  - Substring `'config'` matches `'configurable'`, `'configuration'`,
    `'reconfig'`, etc. The mapping has false positives.
  - The CLI catch-handler does not call back through `cli.setExitCode`;
    it sets `process.exitCode` itself, so the contract surface widens
    silently when tools throw rather than return.
- **Recommendation:**
  - Replace substring matches with typed errors: a small
    `OpenSipError` hierarchy in contracts (e.g. `CheckNotFoundError`,
    `RecipeNotFoundError`, `ConfigError`, `ReportError`,
    `MissingChecksError`). Tool code throws the typed error; the
    suggester pattern-matches on `instanceof`. Substring match becomes
    a fallback for unknown errors.
  - Route the catch handler through `setExitCode` so the contract is
    consistent: tools and the dispatcher agree on a single exit-code
    write path.

### F5 — Subcommand `.action()` blocks duplicate the same pattern; an Adapter for "Result-producing command → render → exit" is hiding in plain sight

- **Files / code:** `packages/cli/src/index.ts:336–491`
  (`registerCliCommands`). Compare:
  - `init`'s action (lines 346–378): `executeInit(args) → if json
    write JSON else renderResult`. Has special-case handling for
    `ambiguousLanguageError`.
  - `sessions list` (lines 386–392): `showHistory() → renderResult`.
  - `plugin add/remove/list/sync` (lines 422–459): each one is
    `await pluginX(...) → renderResult(result)`.
  - `sessions purge` (line 405) is the outlier — calls `executeClear`
    directly which writes its own banner using ANSI codes.
- **Pattern / principle:** Command pattern; small Adapter to bridge
  Commander's action signature → "execute a function, render its result,
  set exit code".
- **Status:** Smell, not bug. The directness is actively useful when
  reading top-to-bottom, but the pattern repeats five times verbatim.
- **Why it matters:** Every new CLI-owned subcommand has to remember
  three things: render the result, set the exit code, handle the
  `--json` short-circuit. The init command got point #3 right and
  bypasses Ink for JSON; the others ignore `--json` for their result
  shape entirely (e.g. `sessions list` with `--json` still renders
  through Ink, which is wrong for a pipeable command).
- **Recommendation:** Add a thin helper:
  ```ts
  type CommandHandler<T> = (opts: T) => CommandResult | Promise<CommandResult>;
  function mountResultCommand<T>(cmd: Command, handler: CommandHandler<T>): void {
    cmd.action(async (opts: T & { json?: boolean }) => {
      const result = await handler(opts);
      if ((opts as { json?: boolean }).json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        await renderResult(result);
      }
      if ('exitCode' in result && typeof result.exitCode === 'number') {
        process.exitCode = result.exitCode;
      }
    });
  }
  ```
  Then `init`/`sessions list`/`plugin *` all reduce to a couple of
  lines of declaration. This is also the right place to ensure all
  result-producing commands honour `--json` consistently.

### F6 — `commands/clear.ts` writes ANSI escape codes directly; the Ink layer is bypassed

- **Files / code:** `packages/cli/src/commands/clear.ts:36–46` (raw
  `[…]` ANSI helpers and `console.log` printing) plus the same
  bypass in `commands/configure.ts:75–95` which uses `console.log` and
  `readline` directly.
- **Pattern / principle:** Single rendering pipeline; consistent UX.
- **Status:** Active. Comments justify the bypass for `clear.ts`
  ("Ink's useInput requires raw mode which isn't always available")
  but the same logic doesn't apply to `configure.ts`, and even for
  `clear.ts` the prompt itself is the only Ink-incompatible piece —
  the banner and result line could use the Ink renderer.
- **Why it matters:**
  - Two rendering pipelines coexist (Ink + raw ANSI). The raw-ANSI
    branch ignores `theme.ts` and the colour configuration — so a
    user with `NO_COLOR=1` still gets coloured output from the clear
    banner.
  - `clear.ts` already has a `ClearResult` shape but renders inline
    rather than returning the result up to `App.tsx` (which has a
    `case 'clear-done':` branch that *does* render via Ink — that
    branch is dead code unless a caller goes through the renderer).
- **Recommendation:** Have `executeClear` and `executeConfigure`
  return their result objects without rendering. Use Node's stock
  `readline` for prompts (already done) but render banners/results
  through `renderApp(result)`. The `case 'clear-done'` branch in
  `App.tsx` becomes live; the ANSI helpers in `clear.ts` go away.

### F7 — `App.tsx` `toPluginAction` re-validates a contract that was already supposed to be typed

- **Files / code:** `packages/cli/src/ui/App.tsx:206–230` (the function
  with `(result.plugins as { … }[]) ?? []` casts);
  `packages/contracts/src/types.ts:291–295` (the `PluginResult` type
  with `[key: string]: unknown`).
- **Pattern / principle:** "Make illegal states unrepresentable." The
  `PluginResult` interface uses an open dictionary with `[key: string]:
  unknown` — so consumers MUST cast at the consumer end.
- **Status:** Active. Casts in `App.tsx` are load-bearing: if any
  property is missing the component silently substitutes defaults.
- **Why it matters:**
  - The current shape lets the producer (`pluginAdd`, `pluginRemove`,
    `pluginList`, `pluginSync` in `commands/plugin.ts`) emit any keys
    it likes — and emits `action: 'add'` while the consumer matches
    `action: 'install'`. That mismatch is silent: the discriminator
    has no compile-time check (also see how `PluginResult.action` lists
    `'install'` and `'add'` as both valid; the producer uses 'add', the
    consumer matches 'install').
  - The component-side `PluginAction` type already exists (`PluginFeedback.tsx`
    discriminated union). The contract should be that union directly.
- **Recommendation:** Tighten `PluginResult` in contracts to a
  discriminated union:
  ```ts
  export type PluginResult =
    | { type: 'plugin'; action: 'list'; plugins: PluginInfo[]; totalCount: number }
    | { type: 'plugin'; action: 'add';    packageName: string; success: boolean; error?: string }
    | { type: 'plugin'; action: 'remove'; packageName: string; success: boolean; error?: string }
    | { type: 'plugin'; action: 'sync';   synced: SyncEntry[]; errors?: string[]; success: boolean };
  ```
  Then `toPluginAction` becomes a one-line switch with no casts and the
  `'install'` / `'add'` mismatch surfaces at compile time.

### F8 — Update notifier and welcome share startup but live in different lifecycles

- **Files / code:** `packages/cli/src/index.ts:497–509`
  (`maybeNotify({...})` is called only when argv has a subcommand,
  i.e. the welcome path doesn't notify); `packages/cli/src/welcome.ts`
  (welcome implementation, which says it does notify); the
  architecture doc `01-cli-dispatch.md:107–110` describes the welcome
  screen as the place where update-notifier "runs".
- **Pattern / principle:** Documentation/code parity.
- **Status:** Drift. The doc and the code disagree.
- **Why it matters:** A user typing bare `opensip-tools` will never
  see the update prompt — they only see it when they run a real
  command. That's actually probably correct behaviour (don't nag on
  zero-arg runs), but the doc claims the opposite.
- **Recommendation:** Decide. Either:
  (a) call `maybeNotify` *before* the welcome short-circuit so bare
  invocations also surface updates, or
  (b) leave the code as is and update the doc to say "the update
  notifier fires on every command, but not on bare `opensip-tools`."

### F9 — `commands/plugin.ts` `addToConfigPluginList` does a regex-driven YAML mutation; no AST, no schema

- **Files / code:** `packages/cli/src/commands/plugin.ts:85–196`
  (`addToConfigPluginList`, `removeFromConfigPluginList`).
- **Pattern / principle:** Encapsulate the YAML edit behind a YAML
  AST/object API; do not parse YAML by line regex.
- **Status:** Active. Comments acknowledge: "The line-edit assumes the
  standard 2-space indent inside `plugins:`; a non-standard formatting
  will fail closed (no edit; warning logged)." Failing closed is
  acceptable; failing *silently and writing a malformed file* is the
  risk.
- **Why it matters:**
  - The mutation works on `plugins:\n  fit:\n    - "x"` exactly. Any
    user-edited variation (block scalar, flow style, comment between
    keys, tabs) won't match and the edit is silently lost or — worse
    — a duplicate `plugins:` block gets appended.
  - The `yaml` package is already a dep of the CLI (used in
    `configure.ts`). Using it would let us round-trip the config
    correctly.
- **Recommendation:** Either parse with the `yaml` package's Document
  API (preserves comments and ordering) and mutate the AST, or accept
  the current failure mode and add a precondition check that the
  config matches the expected shape before attempting an edit. Either
  is better than the current "regex finds the right line… most of the
  time."

### F10 — `loadCliDefaults` is called inside `preAction`, after side-effecting `setSilent(true)` already ran

- **Files / code:** `packages/cli/src/index.ts:217–241` (the preAction
  hook).
- **Pattern / principle:** Initialization order; observable side
  effects.
- **Status:** Active. The hook always sets `silent=true`, then loads
  config, then merges defaults. If the config sets `verbose: true` the
  merge mutates `opts.verbose` but the logger silence has already
  flipped. Conversely, `setDebugMode(true)` runs after `setSilent(true)`
  so a `--debug` flag *does* unsilence — but only because debug mode
  overrides silent in the logger, not because the order is correct.
- **Why it matters:** Subtle bug class. The behaviour is "correct
  because of an unrelated piece of logger code." If the logger ever
  changes how silent + debug interact, this hook silently breaks.
- **Recommendation:** Move `loadCliDefaults` + `mergeConfigDefaults`
  ahead of `setSilent`/`setDebugMode`, then derive both from the merged
  options. Or, simpler: read `opts.verbose` and `opts.debug` from the
  *merged* opts before deciding silent/debug state.

---

## Non-findings considered and dismissed

- **"Static module-load side effects (lang adapter registration) are
  bad."** Considered. Dismissed: the doc explicitly explains why this
  is required (adapters MUST be in place before any check evaluates a
  file or scope-empty checks treat everything as raw text). Moving
  these into `main()` would create a pre-condition the language
  registry can't enforce. The current design is correct.
- **"Tools should be loaded lazily on first command use, not all at
  startup."** Considered. Dismissed: `--help` discovery requires every
  registered tool's `commands[]` metadata up front; lazy load would
  hide subcommands until first invocation. The 30ms bootstrap cost
  cited in the docs is acceptable.
- **"Bare `opensip-tools` should print `--help`, not a custom welcome."**
  Considered. Dismissed: progressive disclosure (the welcome
  showing fit/sim only) is a deliberate UX call. Commander's auto-help
  would dump every CLI-owned + tool-mounted command, which is the
  opposite of the welcome intent.
- **"Singleton `defaultToolRegistry` is bad — should be DI'd."**
  Considered. Dismissed: the registry is part of the kernel's public
  surface (`@opensip-tools/core`); third-party tools register against
  it as a side effect of import. A DI container would force every
  tool package to plug into one shape, breaking the "any npm package
  whose main exports `tool`" discovery story.
- **"`open-dashboard.ts` should integrate with `--report-to` so
  external dashboards get auto-opened too."** Considered. Out of
  scope: that's a feature request, not an architectural defect.
- **"`completion.ts` hard-codes the subcommand list."** Considered.
  Dismissed: the doc-commented design is "static scripts; can become
  dynamic later by querying `fit --list` if needed." The current
  trade-off (no subprocess per keystroke) is the right one. Worth
  watching: the hard-coded list will drift from the registered tools.
  A test asserting `SUBCOMMANDS` matches `defaultToolRegistry.list()`
  metadata at build time would close the loop.
- **"`uninstall.ts` is also a god-module."** Considered. Disagree —
  it's 230 lines of tightly-related logic, takes injectable dependencies
  for its three I/O surfaces (`prompt`, `write`, `cwd`), and has clean
  internal seams (`collectTargets`, `printTargets`, `handleEmptyTargets`).
  It is the model of how a CLI command should be written in this
  codebase.
