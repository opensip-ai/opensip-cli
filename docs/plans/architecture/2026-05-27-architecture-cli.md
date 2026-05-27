# Architecture audit — cli

**Date:** 2026-05-27
**Scope:** packages/cli
**Auditor:** Claude

## Summary

`packages/cli` is structurally healthy. The composition root (`src/index.ts`) is a small, readable top-to-bottom wiring file; bootstrap, command registration, the `ToolCliContext` factory, and the error handler are each carved into single-responsibility modules. The Tool-plugin contract is honoured at the CLI boundary — `mountAllToolCommands` is a pure registry walk with no `if (tool.id === 'fitness')`-style branching, the only first-party tool name the CLI source mentions in a load-bearing position is in the lazy import inside `bootstrap/dashboard.ts`, and graph-adapter discovery mirrors the tool-discovery shape. Pre-action hook ordering is documented and load-bearing; the `mountResultCommand` helper removes the repeated json-vs-Ink branch from every command-registrar.

The most material smells are: (a) the `bootstrap/dashboard.ts` helper is hard-wired to `@opensip-tools/fitness.openDashboard`, which silently makes "dashboard auto-open" a fitness-only behaviour and contradicts the doc-claim that the launcher is "tool-agnostic"; (b) `cli-context.ts` keeps the per-run project context in module-level globals, mixing what should be a per-invocation Context object with a Factory — fine today, but the comment "if an in-process harness ever runs multiple invocations concurrently…" already names the failure mode; (c) the `App.tsx` `switch (result.type)` is a textbook polymorphism candidate now that tools own their own live renderers — a small `ResultRendererRegistry` would let third-party tools render their own done-results without forking `App.tsx`; (d) `plugin.ts` is doing four separable jobs (npm shellout, YAML round-trip, peer-dep walking, command shape) inside one file with no internal seam. Those plus a handful of smaller findings below.

## Findings

### F1 — Dashboard auto-open silently couples the CLI to fitness

- **Files:** `packages/cli/src/bootstrap/dashboard.ts`, `packages/cli/src/cli-context.ts`
- **Principle/Pattern:** Dependency Inversion / OCP; the Tool-plugin contract
- **Status:** Problematic
- **Evidence:**
  - `packages/cli/src/bootstrap/dashboard.ts:43` — `const { openDashboard } = await import('@opensip-tools/fitness');`
  - `packages/cli/src/cli-context.ts:175` — `maybeOpenDashboard: opts.maybeOpenDashboard` is exposed on the generic `ToolCliContext` every tool receives.
- **Why it matters:** The CLAUDE.md invariant says "The CLI source has zero direct imports from `@opensip-tools/fitness`… beyond the static `tool` exports." `bootstrap/dashboard.ts:43` violates that — a *dynamic* import is still a hard reference. More importantly, `ctx.maybeOpenDashboard` is offered to every tool registered, but only fitness can ever produce the file it opens. A simulation or third-party tool calling `ctx.maybeOpenDashboard({ openRequested: true, jsonOutput: false })` will trigger fitness's dashboard generator regardless of whether fitness ran. The header comment claiming this is "tool-agnostic" is aspirational, not true.
- **Recommendation:** Push the responsibility back to the tool. Either (a) move `maybeOpenDashboard` off `ToolCliContext` and let each tool register a `post-run hook` keyed by tool-id (a small `PostRunHookRegistry` mirroring `LiveViewRegistry`), or (b) keep the seam but require the tool to supply both the artifact generator and the launch decision. Concretely: `ctx.runPostRunArtifact({ toolId, generate: () => Promise<{ path: string }>, openRequested, jsonOutput })`. The Strategy pattern fits — `decideOpen()` is the policy, the artifact builder is the strategy, and `launchBrowser()` is the action. After the change, the dynamic import to `@opensip-tools/fitness` disappears.

### F2 — Per-run state lives in module-level mutable globals

- **Files:** `packages/cli/src/cli-context.ts`
- **Principle/Pattern:** Single Responsibility / "context object" pattern; thread-safety / re-entrancy
- **Status:** Problematic
- **Evidence:**
  - `packages/cli/src/cli-context.ts:49-50` — `let currentProjectContext: ProjectContext | undefined; let datastoreCache: DataStore | undefined;`
  - `packages/cli/src/cli-context.ts:53-56` — `setProjectContextForRun` mutates them; the getter on `ctx.project` (line 162) reads them.
  - `packages/cli/src/bootstrap/dashboard.ts:18` — `import { getCurrentProjectRoot } from '../cli-context.js'` then `getCurrentProjectRoot()` is called from a context-free helper.
- **Why it matters:** The header comment already concedes the failure case ("if an in-process harness ever runs multiple invocations concurrently, a per-invocation context bag is the right next step"). The shape is half-way there: the rest of the CLI passes a `ToolCliContext` object explicitly, but two pieces of per-run state slip out as globals so non-context callers (`bootstrap/dashboard.ts`, `cli-commands/sessions`) can read them. That's a leaky abstraction — the Context Object pattern is incomplete. Test isolation already suffers: any test that runs `setProjectContextForRun` and crashes leaves state behind for the next test in the same process.
- **Recommendation:** Introduce a `RunScope` (a record carrying `runId`, `project`, lazy `datastore` thunk, `setExitCode`, etc.) constructed in the `preAction` hook and passed explicitly down every code path that today reads the module-level holders. `ToolCliContext` already carries `project` and `datastore` getters — they can read from a captured `RunScope` instance instead of module globals. The helpers in `bootstrap/dashboard.ts` should accept a `projectRoot: string` parameter rather than calling `getCurrentProjectRoot()`. This makes the CLI re-entrant and stops tests from sharing hidden state.

### F3 — `App.tsx` is a single growing switch — polymorphism candidate

- **Files:** `packages/cli/src/ui/App.tsx`
- **Principle/Pattern:** Open-Closed / Strategy / "registry instead of switch"
- **Status:** Problematic / Missing opportunity
- **Evidence:**
  - `packages/cli/src/ui/App.tsx:36-124` — a 16-arm `switch (result.type)` dispatch covering `fit-done`, `list-checks`, `list-recipes`, `history`, `dashboard`, `init`, `experimental`, `sim-done`, `plugin-*`, `clear-done`, `configure-done`, `uninstall-done`, `help`, `error`, and a `default`.
- **Why it matters:** This is the *static* renderer counterpart to the `LiveViewRegistry` (`cli-context.ts:108`) that already exists for tool-owned live views. The live-view seam was added precisely so tools could ship their own renderers without `App.tsx` knowing about them — but `App.tsx` still owns the static-render dispatch for every tool's done-result. Adding a new tool today is "zero CLI changes" for live views but requires editing `App.tsx` for static renders. That violates the dispatch-extensibility invariant the rest of the CLI works hard to maintain. The `default` arm renders "Unknown command result" with no context — a third-party tool's result silently falls through.
- **Recommendation:** Mirror the live-view registry. Add `cli.registerResultRenderer(type, component)` on `ToolCliContext`. `App.tsx` becomes a tiny dispatcher that looks the renderer up and renders the registered component, falling back to `<ErrorMessage>` only for truly unknown types. CLI-owned results (`init`, `plugin-*`, `clear-done`, `configure-done`, `uninstall-done`, `error`, `help`) register their components from inside `commands/index.ts`. Tools register theirs in `tool.register(ctx)`. This finishes the work the live-view extraction started.

### F4 — `plugin.ts` mixes four concerns in one 650-line module

- **Files:** `packages/cli/src/commands/plugin.ts`
- **Principle/Pattern:** SRP; cohesion / coupling
- **Status:** Problematic
- **Evidence:**
  - npm shellout: `plugin.ts:346-349`, `plugin.ts:448-451`, `plugin.ts:520-523`, `plugin.ts:566-569`
  - YAML round-trip: `plugin.ts:106-220` (`editPluginList`, `appendToPluginList`, `removeFromPluginList`)
  - Peer-dep resolution: `plugin.ts:552-623` (`installMissingPeers`, `findInstalledPackage`, `extractNameFromSpec`)
  - Command surface + result shaping: `plugin.ts:262-540`
- **Why it matters:** Each of these has a different reason to change (npm CLI versioning, yaml v2 API drift, peer-dep policy, CommandResult schema). They're also at three different abstraction levels in one file. The `__test = { editPluginList }` escape hatch (line 227) is a tell — tests want to reach into the YAML edit layer but the file's public surface doesn't expose it. The peer-dep auto-install in particular is a substantive sub-feature with its own failure modes (`installMissingPeers` swallows errors at line 570) and deserves an independent module + tests.
- **Recommendation:** Split into three:
  - `commands/plugin/yaml-edit.ts` — pure `editPluginList(...)` + helpers (no `fs` writes leak into add/remove command bodies; expose the function for real, drop the `__test` hatch).
  - `commands/plugin/npm-exec.ts` — `runNpmInstall(spec, dir)` / `runNpmUninstall` / peer-dep resolution. Single chokepoint for `execFileSync` so the `--ignore-scripts` policy and the stdio→stderr redirect live in one place.
  - `commands/plugin/index.ts` — the four command functions, now thin orchestrators.
  This keeps `register-plugins.ts` unchanged and makes the CLI surface easier to test without npm in the loop.

### F5 — `App.tsx` reaches into command-internal helpers for `formatBytes`

- **Files:** `packages/cli/src/ui/App.tsx`, `packages/cli/src/commands/uninstall.ts`
- **Principle/Pattern:** Layering / "renderer doesn't know the model"
- **Status:** Problematic
- **Evidence:**
  - `packages/cli/src/ui/App.tsx:296-301` — `formatBytes` defined locally with the comment "Mirror of `formatUninstallSize` so the renderer doesn't reach into commands/."
  - `packages/cli/src/commands/uninstall.ts:150-155` — `formatSize` defined separately, with the same body.
- **Why it matters:** The very comment that explains the duplication identifies the design problem: the renderer wants a presentation helper, the command file has the same helper, and rather than introducing a shared utility both files duplicate it. This is "fix-as-found"-tier — small now, but the pattern (renderer mirrors command helpers) will recur as more `*-done` result types add their own size/duration/percentage formatters. There's already a `cli-ui` package extracted exactly for shared UI primitives (the description notes "shared Ink/React primitives… Banner, Spinner, RunHeader, theme").
- **Recommendation:** Move both copies to `@opensip-tools/cli-ui` as `formatBytes` (and `formatDurationMs`, which `SimDoneSummary` also derives inline at `App.tsx:138-139`). Renderers import the helper; commands either drop their own copy or, since `executeUninstall` doesn't actually render its own bytes string today, just delete `formatSize` from `uninstall.ts`. Establishes the convention before the next tool ships a `*-done` result.

### F6 — `mergeConfigDefaults` uses sentinel-driven conditionals where a precedence chain belongs

- **Files:** `packages/cli/src/bootstrap/cli-defaults.ts`
- **Principle/Pattern:** Replace conditional with polymorphism / "uniform option semantics"
- **Status:** Problematic
- **Evidence:**
  - `packages/cli/src/bootstrap/cli-defaults.ts:57-66` — each field uses a different "default" check: `undefined`, `=== false`, `(opts.exclude as string[]).length === 0`, and `opts.apiKey === undefined`.
- **Why it matters:** The function expresses "use the config value when the flag wasn't supplied" four times, four different ways, because Commander represents "not supplied" differently per option type. The asymmetry is a latent bug: `verbose: false` from a config block would lose to a Commander default of `false`, which means `--no-verbose` cannot be expressed by config. The same holds for `json`. The comment in `pre-action-hook.ts:228` says "merge order is load → merge → derive" — but the merge itself doesn't preserve Commander's "source of value" distinction.
- **Recommendation:** Use Commander's `getOptionValueSource(name)` (which the code already uses for `cwd` in `pre-action-hook.ts:226`) to detect "supplied vs default" uniformly. A small helper:
  ```ts
  function applyConfigDefault<K extends string>(opts, cmd, key: K, configValue) {
    if (configValue === undefined) return;
    if (cmd.getOptionValueSource(key) === 'cli') return;
    opts[key] = configValue;
  }
  ```
  makes the merge homogeneous and fixes the false-flag-loss case. (`mergeConfigDefaults` would then take the actionCommand as a parameter, which it already has access to in the caller at `pre-action-hook.ts:224`.)

### F7 — Typed-error table inverts the OO dispatch

- **Files:** `packages/cli/src/error-handler.ts`
- **Principle/Pattern:** Polymorphism vs table-driven dispatch; the Mapper pattern
- **Status:** Correct (but could be cleaner)
- **Evidence:**
  - `packages/cli/src/error-handler.ts:43-82` — `TYPED_ERROR_RULES` is an array of `{ is: instanceof X, build: ... }` rules iterated top-down at line 85.
- **Why it matters:** This is a legitimate, deliberate use of a data-driven dispatch rather than polymorphism — the comment explicitly says "Adding a new typed error to core is one line here." The rationale is sound (`ToolError` lives in `core`, the CLI doesn't want to push `toErrorSuggestion()` onto every error class). The current implementation is correct. The minor smell: the `is:` callbacks (`(error) => error instanceof NotFoundError`) are five identical-shaped functions; an `errorClass: typeof NotFoundError` field plus a single `error instanceof rule.errorClass` check would be flatter and equally readable.
- **Recommendation:** Optional cleanup — replace the `is` callback with an `errorClass` field referencing the class itself. Drop five one-liners and let the table data-describe itself. Not urgent.

### F8 — `executeInit` is a 130-line state machine without explicit states

- **Files:** `packages/cli/src/commands/init.ts`
- **Principle/Pattern:** State pattern / explicit transition table
- **Status:** Missing opportunity
- **Evidence:**
  - `packages/cli/src/commands/init.ts:916-1046` — `executeInit` runs through: inside-existing-project check, mutex flag check, cwd existence, language resolution, working-dir classification, pristine fast-path, partial-state refusal, `--remove`, `--keep`.
  - States are named in the `WorkingDirState` type (`'pristine' | 'fully-initialized' | 'partial-config-only' | 'partial-dir-only'`) — but the transition behaviour (`pristine` → scaffold; `*` + `--keep` → preserve+scaffold; `*` + `--remove` → wipe+scaffold; `*` + neither → refuse) is encoded as nested `if`s rather than a table.
- **Why it matters:** This is the most user-facing state machine in the CLI (the CLAUDE.md state table at the package root calls it out explicitly). Today the conditional logic does the right thing, but the rules — what `--keep` means in each state, what `--remove` means, the mutex — are spread across a sequence of returns. A reader has to reconstruct the state table from imperative code. The CLAUDE.md has the truth; the code has the implementation; they're not directly comparable.
- **Recommendation:** Lift the four-state-by-two-flag matrix into a constant table, then dispatch:
  ```ts
  const INIT_TRANSITIONS: Record<WorkingDirState, {
    pristine: 'scaffold' | 'refuse';
    keep: 'scaffold-preserve' | 'refuse';
    remove: 'scaffold-wipe' | 'refuse';
    none: 'scaffold' | 'refuse';
  }> = { ... };
  ```
  Then `executeInit` reads the row for the classified state and dispatches to one of three action functions (`scaffold`, `scaffoldPreserve`, `scaffoldWipe`). The CLAUDE.md table and the source then literally encode the same thing. Refactor pays for itself the next time a fifth init flag is proposed.

### F9 — Implicit `process.exit` calls inside `preAction` defeat the centralised exit-code seam

- **Files:** `packages/cli/src/bootstrap/pre-action-hook.ts`, `packages/cli/src/cli-context.ts`
- **Principle/Pattern:** Single write path / SRP
- **Status:** Problematic
- **Evidence:**
  - `packages/cli/src/cli-context.ts:158, 177-180` — the deliberate "one `process.exitCode` write path" via `setExitCode`.
  - `packages/cli/src/bootstrap/pre-action-hook.ts:157, 193, 245` — three `process.exit(2)` calls inside the preAction hook (schema bailout, no-project bailout, ValidationError on strict `--config`).
- **Why it matters:** The CLI deliberately routes exit codes through `ctx.setExitCode` so a single seam owns the mutation (cli-context.ts:177 comment: "`process.exitCode` is mutated in exactly one place (here)"). The preAction hook breaks that contract three times — and `process.exit(2)` (vs `process.exitCode = 2; return`) skips the pending stderr flush, which is precisely the bug the comment at `index.ts:80-84` calls out for fatal bootstrap errors. The preAction hook has the same risk profile. Today it works because the stderr writes immediately precede the exit, and Node tends to flush in practice — but the documented invariant disagrees with the code.
- **Recommendation:** Two complementary changes: (a) thread `ctx.setExitCode` into the preAction hook (it's already constructed by `buildToolCliContext`; the order can be flipped so the hook captures it), and (b) replace `process.exit(2)` with `setExitCode(2)` + `actionCommand.help({ error: true })` or a thrown `ValidationError` that the existing `parseAsync().catch()` then renders through `handleParseError`. The "fatal during bootstrap, no Commander yet" path stays where it is (`error-handler.ts:145`); the "fatal during preAction, Commander is up" path joins the normal exit-code flow.

### F10 — `discoverAndRegisterToolPackages` and `discoverAndRegisterGraphAdapterPackages` repeat the same pattern by hand

- **Files:** `packages/cli/src/bootstrap/register-tools.ts`, `packages/cli/src/bootstrap/register-graph-adapters.ts`
- **Principle/Pattern:** Template Method / DRY
- **Status:** Missing opportunity
- **Evidence:**
  - `packages/cli/src/bootstrap/register-tools.ts:49-73` and `packages/cli/src/bootstrap/register-graph-adapters.ts:44-94` — same shape: (1) discover packages, (2) iterate, (3) dynamic-import, (4) validate the named export, (5) register, (6) on failure: stderr-write + `logger.warn` with isolated-failure semantics.
- **Why it matters:** Two near-identical async-discovery walks with different export keys (`tool` vs `adapter`) and different log-event names. They'll diverge — one already does (`register-graph-adapters.ts` uses `pathToFileURL(meta.mainEntry)` while `register-tools.ts` does a bare `await import(pkg.name)`). When a third plugin kind lands (the CLAUDE.md mentions future `audit` / `lint` / `bench` tools, and graph-engine docs hint at rule-pack plugins), copying this pattern a third time is the obvious next step.
- **Recommendation:** Extract `discoverAndRegister<TMod>({ discover, exportKey, validate, register, logEventPrefix })` in `bootstrap/discover-helper.ts`. Both call sites collapse to ~10 lines each, the isolation policy lives in one place, and the next plugin kind gets the right shape for free. Template Method or, more idiomatic-TS, a generic function — either fits.

### F11 — `setProjectContextForRun` clears `datastoreCache` but does not close the prior DB

- **Files:** `packages/cli/src/cli-context.ts`
- **Principle/Pattern:** RAII / lifecycle management
- **Status:** Problematic (latent)
- **Evidence:**
  - `packages/cli/src/cli-context.ts:53-56` — `setProjectContextForRun` sets `datastoreCache = undefined` but does not call `datastoreCache.close()` (if such a method exists) before dropping the handle.
- **Why it matters:** Today this is unreachable — `setProjectContextForRun` fires once per process, in the preAction hook. But the comment on the holders explicitly contemplates "an in-process harness running multiple invocations" (F2). If/when that happens, the second invocation drops the first invocation's SQLite handle on the floor without closing it. Better-sqlite3 (which `@opensip-tools/datastore` likely wraps) flushes the WAL on close; leaking the handle means data integrity rides on the GC running before process exit.
- **Recommendation:** Either (a) decide explicitly that re-entrancy is unsupported and have `setProjectContextForRun` throw when called twice, or (b) close the previous datastore before reassigning. Pair with the F2 refactor: when `RunScope` becomes a real object, its disposal can run `datastore.close()` deterministically.

### F12 — `commands/index.ts` ↔ `mount-result-command.ts` circular type import

- **Files:** `packages/cli/src/commands/index.ts`, `packages/cli/src/commands/mount-result-command.ts`
- **Principle/Pattern:** Acyclic dependencies
- **Status:** Problematic (cosmetic)
- **Evidence:**
  - `packages/cli/src/commands/index.ts:29` — `import type { CliCommandsContext } from './shared.js';`
  - `packages/cli/src/commands/mount-result-command.ts:28` — `import type { CliCommandsContext } from './index.js';`
- **Why it matters:** `mount-result-command.ts` imports its type from `commands/index.ts`, which in turn re-exports it from `shared.ts`. The type itself lives in `shared.ts:25`. The import via the barrel adds an unnecessary cycle in the type graph (TypeScript handles it because `type` imports are erased, but tooling like dependency-cruiser still records the edge). It also makes `mount-result-command.ts` brittle to changes in the index barrel.
- **Recommendation:** Change `mount-result-command.ts:28` to `import type { CliCommandsContext } from './shared.js';`. Trivial; ought to be a one-line PR.

### F13 — `executeUninstall` carries legacy boolean flags for back-compat at the contract boundary

- **Files:** `packages/cli/src/commands/uninstall.ts`
- **Principle/Pattern:** Single source of truth / "discriminator wins"
- **Status:** Problematic
- **Evidence:**
  - `packages/cli/src/commands/uninstall.ts:123-127` — `UninstallResult` extends `UninstallDoneResult` with `removed`, `dryRun`, `cancelled` "back-compat" booleans.
  - `packages/cli/src/commands/uninstall.ts:350-368` — `buildResult` writes them all derived from `action`.
- **Why it matters:** The comment "the discriminator `action` is the canonical signal; the boolean flags are derivable but kept for back-compat" describes a tech-debt promise. The risk is well-understood: two ways to ask the same question, with the booleans easier to misuse (`if (result.removed)` reads naturally but is silently false during a dry-run). The renderer (`App.tsx:UninstallDoneSummary`) already uses `action` exclusively — the booleans are unread.
- **Recommendation:** Grep for `result.removed | result.dryRun | result.cancelled` outside this file (the test suite is the most likely consumer). If only tests read them, delete the booleans from `UninstallResult` and update the tests to assert on `action`. The discriminator-only shape is then the only thing to keep in sync.

### F14 — `commands/completion.ts` hardcodes the subcommand list — drift risk between Commander tree and shell scripts

- **Files:** `packages/cli/src/commands/completion.ts`
- **Principle/Pattern:** Single source of truth / generation vs duplication
- **Status:** Problematic
- **Evidence:**
  - `packages/cli/src/commands/completion.ts:29-47` — `SUBCOMMANDS` enumerates `fit`, `fit-list`, `fit-recipes`, …, `graph`, `graph-lookup`, etc., each of which is registered separately by a tool's `register(cli)` method.
  - The file's own header says "Kept in sync with the live Commander program at test time — see `__tests__/completion-subcommands.test.ts` (drift catch)."
- **Why it matters:** The CLI is designed to be tool-pluggable, but the completion script ships a static list of every first-party tool's subcommands. A new tool registers its commands via `tool.register(ctx)` and gets discovered automatically — but its subcommands won't appear in completion until the contributor remembers to edit `completion.ts`. The drift test catches forgotten *first-party* commands; it does not (and cannot) catch third-party tool subcommands at all. Third-party tools therefore ship with completion blind by design.
- **Recommendation:** Generate the completion script from the live Commander program. After `mountAllToolCommands` has run, walk `program.commands` and read each `cmd.name()` + `cmd.options`. The script generation becomes a function of the program state, not a hand-maintained constant. First-party drift is impossible by construction; third-party tools get completion for free. The flag-per-subcommand maps (`FIT_FLAGS`, `SIM_FLAGS`, etc.) can stay if generation gets complicated, but the subcommand list is mechanical.

## Strengths

- **Composition root is small and reads top-to-bottom.** `src/index.ts:36-89` — 50 lines, every step (bootstrap, context build, command mount, parse, top-level catch) is named and discoverable. The comment at line 4 ("Reads top-to-bottom as wiring") describes the file accurately.
- **The Tool plugin contract is honoured at the registry walk.** `bootstrap/register-tools.ts:81-96` is the dispatch heart, and it contains no tool-specific branching. The "isolated failure" semantics (one tool's `register()` throw doesn't take the CLI down) is the right call.
- **Live-view registry is exactly the right abstraction.** `cli-context.ts:108-136` — `Map<string, LiveViewRenderer>`, duplicate-key warns "first registration wins", missing key throws `UnknownLiveViewError`. F3 above is "do the same thing for static renders" — that's praise for this seam.
- **`mountResultCommand` removes the json-vs-Ink branch from every command body.** `commands/mount-result-command.ts:50-93` — six call sites would otherwise repeat the same eight-line dispatch. The split between `mountResultCommand` (opts-only) and `mountResultCommandWithArg` (one positional) is a clean overload.
- **The `--json` short-circuit bypasses Ink entirely.** `commands/mount-result-command.ts:88-91` — machine consumers never see ANSI escapes; this contract is enforced in one place.
- **Pre-action ordering is documented and load-bearing.** `bootstrap/pre-action-hook.ts:13-24` — the 1–7 step list is a contract, not just a comment, and the side-effects-after-bailouts shape is correct.
- **Lazy datastore opens.** `cli-context.ts:80-100` ensures dry-run and error paths never materialise `.runtime/datastore.sqlite`. The bootstrap pipeline explicitly defers the open to first-touch.
- **`commands/shared.ts` collapses cross-command Commander option specs.** Adding a new shared flag is genuinely a one-line change there.
- **`bootstrap/global-config.ts` uses atomic temp+rename with `O_EXCL`+`0o600`** (`global-config.ts:77-99`) — the explanatory comment about closing the umask race is exactly right and the implementation matches.

## Notes

- The CLAUDE.md states `cli` depends on `lang-*` adapters at the same layer level as `fitness`/`simulation`. `packages/cli/package.json:29-54` confirms — every first-party package is a workspace dep. That's fine but it does mean the CLI's cold-start cost grows with the package matrix; the dynamic-import seams in `bootstrap/render.ts` and `bootstrap/dashboard.ts` are the right place to keep that contained.
- `commands/plugin.ts:484-540` carries an `eslint-disable` for `cognitive-complexity` on `pluginSync`. After the F4 split that suppression can come out, which is a useful by-catch.
- The `update-notifier.ts` and `welcome.ts` modules are appropriately separated and have well-justified deviations from the Ink path. Documented bypasses are fine; both files explain themselves clearly.
- `api.ts` re-exports `EXIT_CODES` and `CommandResult` from `@opensip-tools/contracts` through `@opensip-tools/cli` (lines 10, 16-26). Consumers should be importing directly from `contracts` — but the contract surface is small enough that this is more of an API-design observation than a fix. Worth a thought when the next major bump happens.
