# Phase 4 Summary — CLI as generic tool dispatcher

## What landed

The CLI's `index.ts` no longer hardcodes any tool's command surface.
It builds the Commander tree by walking `defaultToolRegistry` and
calling `tool.register(cliContext)` on each registered tool. fitness
contributes `fit`, `dashboard`, `fit-list`, `fit-recipes`; simulation
contributes `sim`; and a third-party tool can contribute any subcommand
by implementing the `Tool` contract and shipping a `package.json` with
`opensipTools.kind === 'tool'`.

The Tool contract was reshaped:
- Removed `ToolCommand.run(argv, ctx)` (a stub from Phase 2 that the
  CLI never actually invoked).
- Replaced with `Tool.register(cli: ToolCliContext): void` — the tool
  mounts Commander subcommands directly using its own option-parsing
  rules.
- `Tool.commands[]` now carries metadata only (`name`, `description`,
  `aliases`) — used for `--help` listings and conflict detection.
- `ToolCliContext` provides shared CLI infrastructure to tools:
  `program`, `render`, `renderLive`, `maybeOpenDashboard`, `logger`,
  `setExitCode`. Tools call back into these instead of taking a hard
  dep on `@opensip-tools/cli`.

## What moved to fitness

- `cli/src/gate.ts` → `fitness/engine/src/gate.ts` (architecture-gate
  primitives — operate on fitness's CliOutput).
- `cli/src/sarif.ts` → `fitness/engine/src/sarif.ts` (SARIF builder +
  `reportToCloud` upload — fitness-output-specific).
- `cli/src/__tests__/gate.test.ts` → `fitness/engine/src/__tests__/gate.test.ts`
- `cli/src/__tests__/sarif.test.ts` → `fitness/engine/src/__tests__/sarif.test.ts`

Re-exported from `@opensip-tools/fitness`. The CLI's UI layer
(`FitView.tsx`) updated to import `reportToCloud` from `@opensip-tools/fitness`
instead of `../../sarif.js`.

## What stayed in the CLI

- `index.ts` — generic dispatcher, ~430 lines (down from ~627; simpler
  control flow, every fitness/simulation-specific block now lives in
  the tool packages).
- CLI-only commands: `init`, `sessions list`, `sessions purge`,
  `configure`, `plugin list/install/remove/sync/add`, `completion`,
  `uninstall`.
- The Ink rendering layer: `ui/`, `welcome.ts`, `update-notifier.ts`,
  `open-dashboard.ts` (`decideOpen` + `launchBrowser`).
- The error-suggestion table (`@opensip-tools/cli-shared/exit-codes`).

## Counts

- `cli/src/index.ts`: 627 → 430 lines (-31%).
- 4 files moved with `git mv` (gate, sarif, + their tests).
- New file: `docs/plans/v2-architecture/p4-summary.md`.
- Modified files: ~8 (Tool contract, two tool.ts rewrites, two
  package.json dep additions for `commander`, CLI's index.ts rewrite,
  FitView import update).

## Verification

- `pnpm -r build` — green (17 packages).
- `pnpm -r typecheck` — green.
- `pnpm -r test` — green: 569 tests pass workspace-wide. CLI tests
  dropped from 150 → 107 because gate.test + sarif.test (43 tests)
  moved with their source to fitness/engine. fitness/engine went
  145 → 188. Net unchanged.
- DART `npx opensip-tools fit` → 120 / 0 / 11 — bit-for-bit parity.
- DART `npx opensip-tools fit --list` works.
- DART `npx opensip-tools fit --recipes` works.
- DART `npx opensip-tools list-checks` (alias) works.
- DART `npx opensip-tools fit --gate-save` works.
- DART `npx opensip-tools sim` works.
- DART `npx opensip-tools --help` lists all 12 subcommands across the
  two tools and the CLI's housekeeping set.

## Known gaps / follow-ups

1. **`renderLive('fit', args)`** dispatches by string key. Future tools
   that want a live (spinner + transition) view must extend the CLI's
   `renderLive()` switch. A more honest design would pass a typed
   "live view component" through the context, but that drags React/Ink
   types into core, which we explicitly chose not to do. The string-key
   indirection is the cleanest contract until a third tool needs it.

2. **The `--debug` flag's preAction hook** lives at the program level
   in cli/index.ts. Tool subcommands inherit the option declaration on
   each individual `command()` call (carried over from the previous
   layout). This is duplication but it's what the existing UX
   contracts on; consolidating into a global option would change the
   `--help` rendering.

3. **commander is now a dep of fitness AND simulation AND cli.** Three
   declared deps for one shared package. pnpm dedupes at install, but
   semver drift across the three is a hazard. Pinned at `^13.1.0`
   everywhere; revisit if the Tool contract grows enough that adding a
   `program` wrapper to `ToolCliContext` makes sense (it'd let tools
   not directly depend on commander).

4. **Tool discovery walks from cliInstallDir**, which is correct for
   bundled first-party tools but doesn't honor the project's `cwd`
   when the user installs a third-party tool there. Minor: today's
   third-party-tool count is zero. Phase 5 (when we have one) will
   thread `projectDir` through.

## Blockers / open questions

None. P4 is functionally complete; v2.0.0 is shippable subject to
final smoke-test review tomorrow.
