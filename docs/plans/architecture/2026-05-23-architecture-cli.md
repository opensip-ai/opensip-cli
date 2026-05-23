---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/cli"
package: "@opensip-tools/cli"
audience: [contributors, architects]
related-audits:
  - ./2026-05-22-architecture-cli.md
  - ./2026-05-22-plan-layer-5-cli.md
prior-finding-status:
  F1: closed     # index.ts is now 78 lines; bootstrap/, cli-context, error-handler, commands all extracted + tested
  F2: closed     # registerLiveView API + UnknownLiveViewError; no viewKey === switches; CliProgram alias in contracts
  F3: deferred   # explicit per-plan; FitView/GraphView still import fitness/graph; 3 process.exitCode writes still in UI
  F4: closed     # error-handler.ts uses instanceof typed-error rules + getErrorSuggestion fallback; setExitCode-routed
  F5: closed     # mountResultCommand + mountResultCommandWithArg adopted by init/sessions/configure/plugin
  F6: closed     # clear/configure return ClearDoneResult/ConfigureDoneResult; rendered via Ink; no raw ANSI in commands/
  F7: closed     # PluginResult is a discriminated union; toPluginAction is gone; PluginFeedback consumes the contract
  F8: closed     # code+doc agree — maybeNotify runs only after the welcome short-circuit; comment at index.ts:58–60
  F9: closed     # yaml Document API (parseDocument/isMap/isSeq/isScalar) replaces regex; fails closed on malformed
  F10: closed    # pre-action-hook does load → merge → derive (silent/debug); reads merged opts.debug
---
# Architecture audit (delta) — @opensip-tools/cli

## Summary

Waves 1–4 landed cleanly. `index.ts` is a real composition root (78
lines, top-to-bottom wiring); the bootstrap extractions, `cli-context`,
`error-handler`, and `commands/index` each have a clear responsibility
and unit tests; the `viewKey === 'fit'` switch is gone, replaced by a
typed `LiveViewRegistry` that throws `UnknownLiveViewError`;
`mountResultCommand` is consistently adopted; `PluginResult` is a
discriminated union; the YAML mutation in `plugin.ts` round-trips
through the `yaml` Document API. Eight of ten prior findings are
closed; F3 is deferred by design and the three `process.exitCode`
writes in `FitView`/`GraphView` travel with it.

The net-new findings (G1–G8) are all small. The most material are
G2 (CLI's `cli:` config block loaded through `@opensip-tools/fitness`,
inverting layering for a tool-agnostic concern) and G7 (shell
completion suggests `plugin install`, but the canonical action is
`plugin add` post-F7). The missed-by-prior issues (M1–M4) are SRP/ISP
cleanups in second-tier files the god-module decomposition didn't
reach.

## Prior findings — verification

### F1 — `index.ts` god-module — CLOSED

`index.ts` is 78 lines, zero inline `.action()` bodies, no
ToolCliContext closure, no module-level for-of loops. Reads
top-to-bottom: `bootstrapCli` → `buildToolCliContext` →
`mountAllToolCommands` → `registerCliCommands` → welcome short-circuit
→ `parseAsync().catch(handleParseError)`. Extractions match the plan:
`bootstrap/{register-language-adapters,register-tools,
pre-action-hook,cli-defaults,render-helpers,index}.ts`,
`cli-context.ts`, `commands/index.ts`, `error-handler.ts`. Each is
covered by a focused test (`bootstrap.test.ts`, `cli-context.test.ts`,
`commands.test.ts`, `error-handler.test.ts`,
`mount-result-command.test.ts`, `completion-subcommands.test.ts`).

### F2 — `program: unknown` + `viewKey: string` — CLOSED (with residual)

The string-keyed dispatch is gone. `cli-context.ts:50–78`'s
`createLiveViewRegistry` is a typed `Map<string, LiveViewRenderer>`
with duplicate-warn semantics and `UnknownLiveViewError` on misses
(line 69–71). `cli-context.test.ts:29–86` covers positive, miss,
duplicate, and per-instance isolation. Tools self-register via
`cli.registerLiveView(...)` in their `register(cli)` hook
(`fitness/.../tool.ts:103–123`, `graph/.../tool.ts:39–55`).

Residual: `program: unknown` half. `@opensip-tools/contracts` exports
a `CliProgram` alias (`contracts/src/index.ts:114`) but tools cast
`cli.program as Command` from `commander` directly
(`fitness/.../tool.ts:106`, `graph/.../tool.ts:42`). Tracked as G6.

### F3 — Tool controllers in `cli/ui/components/` — DEFERRED

State matches the plan's expectation:
- `FitView.tsx:8` imports `executeFit`, `ensureChecksLoaded`,
  `getEnabledCheckCount`, `reportToCloud` from `@opensip-tools/fitness`.
- `GraphView.tsx:15–22` imports `runGraph`, `GRAPH_STAGES`,
  `buildUnifiedReportLines`, etc. from `@opensip-tools/graph`.
- `process.exitCode` writes at `FitView.tsx:64`, `FitView.tsx:79`,
  `GraphView.tsx:132` bypass the `setExitCode` write path. Three
  known leaks until Phase 3 lands.

### F4 — Error-suggestion ladder — CLOSED

`error-handler.ts:43–82` is a typed-error rule table (`instanceof
NotFoundError | ConfigurationError | ValidationError | NetworkError |
TimeoutError`) with `getErrorSuggestion` as fallback (line 108).
Always routes through `setExitCode` (lines 111, 122). The substring
rules in `contracts/src/exit-codes.ts` were also tightened — the
over-broad `'config'` rule was split into `opensip-tools.config.yml`
+ `YAML` (comment at L51–55).

### F5 — Subcommand action adapter — CLOSED

`commands/mount-result-command.ts` exports `mountResultCommand` +
`mountResultCommandWithArg`, consumed by every result-producing CLI
command in `commands/index.ts`: `init` (L74), `sessions list` (L114),
`sessions purge` (L131), `configure` (L149), `plugin list/add/remove/sync`
(L171–214). `--json` is honoured uniformly via the `jsonFlag`
extractor; helper bypasses Ink and emits indented JSON
(mount-result-command.ts:87–91). `mount-result-command.test.ts`
covers rendered + JSON paths and the positional-arg variant.

### F6 — Raw-ANSI bypasses — CLOSED

`commands/clear.ts:41–71` returns a `ClearDoneResult`; the `App.tsx`
`case 'clear-done':` branch (App.tsx:99–101 + summary at L193–210)
is now live. `commands/configure.ts:91–115` returns a
`ConfigureDoneResult` rendered via `case 'configure-done':`
(App.tsx:103–105 + L213–233). `grep '\\x1b\\[' commands/` is empty.
The two `process.stdout.write` calls that survive in `clear.ts:56–58`
and `configure.ts:98` are pre-prompt hints around `readline` — plain
text, no ANSI; comments document why Ink can't take over there.

### F7 — Discriminated `PluginResult` — CLOSED

`contracts/src/types.ts:337–347` is a discriminated union; producer
(`plugin.ts:279, 354, 427, 505`) emits the union directly; consumer
(`PluginFeedback.tsx:21–36`) is a one-line `switch (action.action)`
with no casts. `App.tsx:95–97` no longer wraps via `toPluginAction`;
the helper is gone. `'install'`/`'add'` discriminator drift is
impossible at compile time.

### F8 — Update-notifier doc/code drift — CLOSED

`index.ts:58–65` carries the explicit comment "the update notifier
runs AFTER this short-circuit by design (don't nag on zero-arg runs);
see docs/architecture/50-runtime/01-cli-dispatch.md." Plan picked
option (b); doc and code agree.

### F9 — YAML AST mutation — CLOSED

`plugin.ts:106–212` uses `parseDocument` / `isMap` / `isSeq` /
`isScalar`. Comments + ordering are preserved; fails closed on
malformed input (L125–131 throws on parse errors with a clear
message; L148–153 refuses to edit a non-mapping root).
`__tests__/plugin-config.test.ts` covers via the exported `__test`
hatch.

### F10 — `preAction` hook ordering — CLOSED

`bootstrap/pre-action-hook.ts:34–56` runs `mergeConfigDefaults` before
`setSilent` / `setDebugMode` and reads `opts.debug` from the merged
opts. Header comment at L8–12 records the F10 rationale.

---

## Net-new findings

### G1 — top-level fatal `try` block bypasses `setExitCode` and calls `process.exit(1)`

- **Files:** `index.ts:72–78`
- **Severity:** P2.
- **Pattern / principle:** SRP / single exit-code write path. Rest of
  the CLI funnels exit-code mutations through `ctx.setExitCode`
  (`cli-context.ts:124–127`); this branch doesn't.
- **Why it matters:** `process.exit` (vs `process.exitCode`) skips
  pending I/O flush, so the fatal stderr line can be lost; any
  structured-logging hook on bootstrap failure has nowhere to attach.
  Practical impact today is small (errors before `parseAsync` are
  rare), but it's the only `process.exit(N)` in the CLI.
- **Recommendation:** Route the fatal branch through a small
  `handleFatalBootstrapError(error, log)` that emits `cli.bootstrap.failed`,
  writes stderr, and sets `process.exitCode = 1`. Drop the
  `process.exit`; Node exits with the set code naturally.

### G2 — `bootstrap/cli-defaults.ts` reaches into `@opensip-tools/fitness`

- **Files:** `bootstrap/cli-defaults.ts:12, 16, 26`
- **Severity:** P2.
- **Pattern / principle:** DIP / layer ownership. The `cli:` block of
  `opensip-tools.config.yml` gates logger silence/debug, the global
  `--report-to`, the global `--json` default, `--exclude`, `--api-key`
  — every tool's preAction sees them. Routing the loader through
  fitness inverts the layering: the composition root depends on a
  tool implementation for a tool-agnostic concern.
- **Why it matters:** A user tree that ships only the `simulation`
  tool still imports fitness just to read its own config block. The
  schema (`SignalersConfig['cli']`) is owned by the wrong package —
  CLI defaults schema changes force a fitness release.
- **Recommendation:** Lift the `cli:` config schema + loader into
  `@opensip-tools/contracts` (alongside `EXIT_CODES`,
  `getErrorSuggestion`, `CliProgram`). Fitness re-imports if needed.
  The CLI's bootstrap then has zero tool-package imports for non-tool
  wiring.

### G3 — `bootstrap/render-helpers.ts` hard-codes the first-party live-view map

- **Files:** `bootstrap/render-helpers.ts:14–15, 29–44`
- **Severity:** P2.
- **Pattern / principle:** OCP. The "adding a fourth tool requires
  zero CLI edits" claim breaks here: a new first-party tool with a
  live view must be added to `builtinLiveViews` so the tool's
  `register()` self-lookup (`fitness/.../tool.ts:112`,
  `graph/.../tool.ts:48`) finds its renderer.
- **Why it matters:** Two registries (this map + `LiveViewRegistry`
  in `cli-context.ts`) for the same shape. Third-party tools can't
  ship live views — `cli/ui/components` isn't a package they can
  import.
- **Recommendation:** Phase 3 (deferred) collapses this. When tool
  controllers move to their packages, each tool ships its own
  renderer and calls `cli.registerLiveView(key, renderer)` directly.
  The `builtinLiveViews` map and the self-lookup handshake go away.
  Surface as a Phase-3 prerequisite item.

### G4 — `welcome.ts` carries its own ANSI helpers, bypassing the Ink/theme pipeline

- **Files:** `welcome.ts:21–35`
- **Severity:** P3.
- **Pattern / principle:** Single rendering pipeline (the same
  principle F6 closed for `clear`/`configure`).
- **Why it matters:** Theme drift — a user with a custom `theme.ts`
  still gets the hard-coded cyan accent. Discoverability — a
  contributor reading the F6 promise will be surprised by the
  bypass.
- **Recommendation:** Either (a) expose a `WelcomeResult` and render
  via Ink, or (b) tolerate the bypass but document it in
  `welcome.ts`'s header — welcome runs before Ink/React load, a
  cold-start optimisation. Pick one and write it down.

### G5 — `commands/uninstall.ts` is the one CLI-owned command not on `mountResultCommand`

- **Files:** `commands/index.ts:240–256`,
  `commands/uninstall.ts:187–235`
- **Severity:** P2.
- **Pattern / principle:** Consistency / SRP. `executeUninstall`
  owns both the I/O and the result, mirroring the original (pre-F6)
  shape of `clear` and `configure`.
- **Why it matters:** Same theme drift as G4 — the `✓` glyph and
  success line ignore `theme.ts`. The plan's Phase 5 named `init`,
  `sessions list`, `plugin *` for the helper but quietly left
  `uninstall` outside; the prior audit dismissed `uninstall` as
  exemplary on its parameter-injection pattern but not its rendering
  path.
- **Recommendation:** Carve `executeUninstall` into a
  `UninstallResult`-producing function plus a renderer (an
  `uninstall-done` `App.tsx` arm). Replace the inline action with
  `mountResultCommand`. See also G8.

### G6 — `program: unknown` cast still happens in tools; `CliProgram` alias unused

- **Files:** `contracts/src/index.ts:114`,
  `fitness/.../tool.ts:106`, `graph/.../tool.ts:42`
- **Severity:** P3.
- **Pattern / principle:** Contracts unused. F2's option (1) was
  implemented contract-side but not adoption-side.
- **Recommendation:** Replace each `as Command` with `as
  CliProgram` from `@opensip-tools/contracts`. Optional: ESLint rule
  banning `from 'commander'` in tool packages.

### G7 — `commands/completion.ts` `bash`/`zsh` plugin arm completes `'install'` (canonical action is `'add'`)

- **Files:** `commands/completion.ts:112, 150`
- **Severity:** P2 — UX bug visible to every shell-completion user.
- **Pattern / principle:** Contract / completion drift. The new
  `completion-subcommands.test.ts` test only checks top-level
  subcommands; sub-subcommand drift is uncovered.
- **Why it matters:** A user typing `opensip-tools plugin <Tab>`
  gets `install` suggested, runs `opensip-tools plugin install foo`,
  and hits Commander's "unknown command".
- **Recommendation:** Replace `'install'` with `'add'` in both
  completion arms (fish doesn't enumerate sub-subcommands so it
  carries the same drift implicitly). Extend the drift test to walk
  one level deeper: assert each sub-`Command`'s enumerated
  completion values match `program.commands.map(c =>
  c.commands.map(cc => cc.name()))`.

### G8 — `setExitCode(EXIT_CODES.SUCCESS)` is a no-op

- **Files:** `commands/index.ts:254`
- **Severity:** P3.
- **Pattern / principle:** Code clarity.
- **Why it matters:** `SUCCESS` is `0`, the default; the line has
  no effect. Reads as if cancel should yield non-zero, then the
  constant says otherwise. Either intent or code is wrong.
- **Recommendation:** Delete (or, if defensive against an upstream
  hook, keep with a comment).

---

## Issues the prior audit missed

### M1 — `bootstrap/index.ts` re-exports more symbols than form a coherent surface

- **Files:** `bootstrap/index.ts:27–36`
- **Severity:** P3. Pattern: ISP.
- **What:** Twelve re-exports; `index.ts:21–28` consumes six. The
  rest (`mergeConfigDefaults`, `loadCliDefaults`, etc.) are
  bootstrap-internal but exposed as implicit API.
- **Recommendation:** Tighten `bootstrap/index.ts`'s re-export list
  to the seven symbols `index.ts` consumes. Internal helpers stay in
  their files; `bootstrap/` siblings import directly. Knip flags the
  shrinkage.

### M2 — `commands/index.ts` is a 256-line god-module by F1's standard

- **Files:** `commands/index.ts` (whole file)
- **Severity:** P2. Pattern: SRP at file level.
- **What:** Six sub-registrars inline (`init`, `sessions`,
  `configure`, `plugin`, `completion`, `uninstall`), each carrying
  its option declarations, helper call, and (for plugin) four
  sub-subcommands. F1's "a composition root should be large; it
  should not be the implementation" applies one layer down.
- **Recommendation:** Split into
  `commands/register-{init,sessions,configure,plugin,completion,uninstall}.ts`;
  `commands/index.ts` becomes a 30-line orchestrator. Mirrors how
  `bootstrap/` already shapes itself.

### M3 — circular-feeling import: `bootstrap/cli-defaults.ts` → `commands/configure.ts`

- **Files:** `bootstrap/cli-defaults.ts:14`, `commands/configure.ts:56–61`
- **Severity:** P3. Pattern: Module ordering / SRP.
- **What:** Bootstrap (startup) imports `resolveApiKey` from
  `commands/configure.ts` (per-command) so the merge step can fall
  back to the global config's saved key. Direction inverts: startup
  → command.
- **Why it matters:** A future bootstrap reorganisation that defers
  command imports until first action breaks the merge step —
  `loadCliDefaults` runs in `preAction` (before any command body)
  but already needs the command module imported.
- **Recommendation:** Lift `resolveApiKey` and the global-config
  reader/writer pair into `bootstrap/global-config.ts`.
  `commands/configure.ts` becomes the prompt+UX wrapper. Also
  addresses G2 from the other angle.

### M4 — `bootstrap/render-helpers.ts` has three unrelated concerns

- **Files:** `bootstrap/render-helpers.ts`
- **Severity:** P3. Pattern: SRP at file level.
- **What:** (a) `renderResult` — static-render entry, tool-agnostic.
  (b) `builtinLiveViews` — first-party live-view map, imports
  `fitnessTool` + `graphTool`. (c) `maybeOpenDashboard` — TTY/CI
  decision + dynamic `import('@opensip-tools/fitness')` for
  `openDashboard`. Co-locating means the pure renderer can never be
  peeled away from the tool-specific surface.
- **Recommendation:** Three files: `bootstrap/render.ts`,
  `bootstrap/live-views.ts` (deleted in Phase 3),
  `bootstrap/dashboard.ts`. The eventual Phase-3 removal is a
  single-file delete.

---

## Overall assessment

The package is materially better than the prior audit captured. Eight
of ten findings are closed by code rather than deferral; the closures
are real (extracted modules, unit-tested seams, contract-typed errors,
registry-backed live views) rather than re-arranged. The
composition-root refactor is textbook — `index.ts` is 78 lines and
reads as wiring; bootstrap owns side effects and exposes pure
functions. `mountResultCommand` closed the JSON/exit-code consistency
gap in one stroke.

Deferred F3 is the largest remaining shape concern. Until Phase 3
lands, the dependency-cruiser "`cli/ui/` imports only contract types"
promise is aspirational and three `process.exitCode` writes leak past
`setExitCode`. None of the net-new findings are blocking; G2
(fitness back-channel for `cli:` config) is a 30-line move and the
rest are 1–10 line fixes. M1–M4 are SRP/ISP cleanups in second-tier
files the god-module decomposition didn't reach.

Recommended next-pass order: G7 (broken UX, smallest fix) → G2 + M3
(lift global config out of fitness/commands into bootstrap) → G5
(uninstall on `mountResultCommand`) → M2 (split `commands/index.ts`)
→ G1, G6, G8 (one-liners). G3, G4, M1, M4 are nice-to-haves that
can ride along with Phase 3.
