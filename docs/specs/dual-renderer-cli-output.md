# Spec: Dual-Renderer CLI Output Architecture

> Status: **IMPLEMENTED** (2026-06-01). Built on branch
> `feat/dual-renderer-cli-output` (Phases 0–7). The drift bug is closed for
> the fit + graph report/gate paths and every `CommandResult` renders
> through the view-model. One residual is tracked in
> `docs/backlog/graph-side-channel-stdout.md`.
> Author: audit follow-up, 2026-06-01.

## Objective

Guarantee that every OpenSIP Tools command produces **identical content**
whether it renders to an interactive terminal (Ink, colored) or to a pipe /
CI log / file (plain text, no ANSI) — by defining each command's output
**once** as a renderer-agnostic view-model and rendering it through **two**
interpreters that cannot structurally drift.

**Who is the user?** Two audiences with one expectation of consistency:
the engineer running `fit` / `graph` / `sim` in a TTY, and the same output
consumed in CI logs, `| less`, or `> report.txt`. Today those two can
silently diverge.

**Why now?** A UX-consistency audit (2026-06-01) found the non-interactive
output path is a set of **hand-maintained plain-text duplicates** of the Ink
components. `packages/graph/engine/src/cli/graph-report.ts` is the clearest
case: `writeRunSummaryPlain`, `writeFooterHintsPlain`,
`writeResolutionBannerPlain`, `writeUnifiedReport` re-type the format of
cli-ui's `RunSummary` / `RunFooterHints` Ink components, kept in sync **by a
comment** ("matching the format of cli-ui's RunSummary Ink component"). Edit
the Ink component and the piped/CI output drifts with no compiler or test
catching it.

This is the **completion of an in-flight migration**, not a new direction.
`App.tsx` history shows `clear` (Layer 5 Phase 6) and `uninstall` (audit
2026-05-23 G5) were already moved off raw stdout into the
`CommandResult → App.tsx` path. Graph and the fitness/graph gate modes are
the remaining holdouts, and graph is the structural outlier (no
`CommandResult` variant at all).

### Success criteria (concrete)

- A single decision point chooses Ink vs. plain text from
  `detectTerminalCapabilities()` (`isTTY`) + `NO_COLOR` + `--json`; no tool
  makes this decision.
- No package outside the three documented side-channels writes
  human-readable report text via `process.stdout.write`. The
  `write*Plain` / `writeUnifiedReport` duplicates in
  `graph-report.ts` are **deleted**, not refactored-in-place.
- `graph` has a `graph-done` `CommandResult` variant and routes its primary
  (non-`--json`) report through the central dispatcher like `fit`/`sim`.
- For every migrated result type, an automated test renders it through
  **both** interpreters and asserts the plain-text output equals the Ink
  output with ANSI stripped and trailing whitespace normalized. Drift fails
  the test.
- `pnpm typecheck && pnpm test:coverage && pnpm lint` (eslint + depcruise +
  depcruise:types + gate:verify) all green, **including per-package coverage
  thresholds**. cli-ui keeps **ink + react as its only runtime deps**.

## Scope

### In Scope

- A renderer-agnostic **view-model vocabulary** (`ViewNode` / `Span` /
  semantic `Tone`) plus two interpreters: `renderToInk(node)` and
  `renderToText(node)`, living in `@opensip-tools/cli-ui`.
- Reframing the drift-prone shared elements (`RunSummary`,
  `RunFooterHints`, `ProjectHeader`, resolution banner, gate output) as
  **view-model producers** that both interpreters consume.
- A `graph-done` `CommandResult` and the dispatcher case for it; deletion of
  graph's hand-rolled plain-text report functions.
- A central `renderResult(result, …)` seam that replaces the Ink-only
  `renderApp`, selecting interpreter by terminal capability.
- Cross-renderer **snapshot/equivalence tests** proving non-drift.

### Out of Scope (and why)

- **Live progress views (Path B)** — `fit-runner.tsx` / `graph-runner.tsx`
  registered via `cli.registerLiveView`. They are inherently TTY-only
  (animated, stateful); a non-TTY run already falls back to the static
  result. **Decision (resolved):** keep them TTY-only for this effort, and
  **schedule a later phase** to express each live view's *final frame* via
  the same view-model so interrupted/CI live runs are content-consistent.
  That later phase is tracked in
  `docs/backlog/live-view-final-frame-dual-render.md`; out of scope here.
- **`--json` output** (`CliOutput` v1.0) — a stable machine contract; its
  shape must not change. It keeps its own `cli.emitJson` seam.
- **Legitimate side-channels** — shell-completion script emission, readline
  prompts (`configure`/`clear` pre-prompt), shard-worker IPC
  (`shard-worker.ts` JSON-to-parent), and the documented `welcome.ts` ANSI
  fast-path. These are not themed output and stay as direct writes.
- **Theme/color redesign** — `DEFAULT_THEME` tokens are unchanged; `Tone`
  maps onto them.
- **Rich Ink-only components with no plain-text counterpart today**
  (`HistoryTable`, `InitFeedback`, `PluginFeedback`, `Findings`, …) — they
  render fine via the view-model, but migrating each is sequenced *after* the
  drift-prone shared elements (see Migration approach). Until migrated they
  keep their current Ink component and a straightforward text fallback.

### Migration approach (resolved: phased)

1. **Phase 1 — IR + interpreters.** Land `ViewNode`/`Span`/`Tone` +
   `renderToInk` + `renderToText` in cli-ui with full unit + no-ANSI tests.
2. **Phase 2 — drift-prone shared elements.** `RunSummary`,
   `RunFooterHints`, `ProjectHeader`, resolution banner, gate output become
   view-model producers; both interpreters consume them.
3. **Phase 3 — graph-done + dispatcher seam.** Add `graph-done`, route
   graph's report through `renderResult`, delete the `write*Plain` /
   `writeUnifiedReport` duplicates; suppress banner in plain-text mode.
4. **Phase 4+ — rich components incrementally** (tables, init/plugin
   feedback) behind the same IR. Each migration ships its own
   cross-renderer equivalence test.

Smaller, independently reviewable PRs; the drift bug is closed by end of
Phase 3.

## Technical Context

### Existing architecture

- **Output contract** — `packages/contracts/src/types.ts`: `CommandResult`
  discriminated union (16 variants: `fit-done`, `sim-done`, `list-checks`,
  …, `error`; **no `graph-done`**). `CliOutput` v1.0 is the separate `--json`
  contract. Exit codes + `mapToolErrorToExitCode` in
  `packages/contracts/src/exit-codes.ts`.
- **Central Ink renderer** — `packages/cli/src/ui/render.tsx#renderApp`
  mounts Ink and renders `App` (`packages/cli/src/ui/App.tsx`), which
  switches on `result.type`. Single banner rule
  (`BANNERLESS_RESULT_TYPES`). This is the only static render seam.
- **Theme + capability detection** — `packages/cli-ui/src/theme.ts`:
  `DEFAULT_THEME` (12 tokens), `NO_COLOR_THEME` (zeroed), and
  `detectTerminalCapabilities()` which already gates every capability flag on
  `isTTY` (lines 116-126) — the correct basis for the renderer decision.
- **The right precedent to generalize** —
  `packages/cli-ui/src/project-header.tsx`: `formatProjectHeader(input):
  string` (pure) **alongside** `<ProjectHeader>` (Ink view that renders the
  same string). Format defined once, two consumers. The view-model
  generalizes this from one element to all of them.
- **Tool dispatch seam** — `ToolCliContext` (`packages/core/src/tools/
  types.ts`): `render(result)`, `emitJson(value)`, `setExitCode(code)`,
  `registerLiveView`/`renderLive`. Tools compute a result and hand it to the
  runner; they do not own rendering — except graph today.

### Key dependencies / packages touched

- `@opensip-tools/contracts` — add `GraphDoneResult` + union member.
- `@opensip-tools/cli-ui` — add view-model vocabulary + `renderToInk` /
  `renderToText`; reframe shared components as view-model producers. **Must
  stay ink+react-only.**
- `@opensip-tools/cli` — `renderApp` → `renderResult` (interpreter
  selection); `App.tsx` switch becomes a `CommandResult → ViewNode` mapper.
- `@opensip-tools/graph` — return `graph-done`; delete `write*Plain` /
  `writeUnifiedReport`.
- `@opensip-tools/fitness` — gate-mode stdout writes (`fit-modes.ts`)
  routed through the result/renderer path.

### Constraints

- **Layering (dependency-cruiser):** core ← contracts ← (cli-ui / fitness /
  sim / graph) ← checks ← cli. cli-ui must **not** import `contracts` (would
  couple the generic UI kit to result types and add a workspace dep). →
  *The view-model vocabulary is generic and lives in cli-ui; the
  `CommandResult → ViewNode` mapping lives in cli.*
- **`renderToText` emits zero ANSI** — stronger than `NO_COLOR`; it drops
  `Tone` entirely rather than zeroing colors.
- **Coverage gate:** CI runs `pnpm test:coverage`; new view-model /
  interpreter / mapper code must meet each package's vitest coverage
  thresholds. Tests are part of each phase, not a follow-up.
- ESM Node16 (`.js` import extensions), Node 22+, TS 5.7.
- All gates green, including `gate:verify` (architecture liveness).

## Design Decisions

| Decision | Choice | Rationale | Alternatives considered |
|---|---|---|---|
| How to guarantee non-drift | **One view-model IR, two interpreters** | A result is expressed once as `ViewNode`s; Ink and text both interpret it. Drift is structurally impossible — there is no second definition to fall out of sync. | **(a) Two parallel `switch(result.type)` renderers sharing `format*()` functions** — lighter, but still two renderers that can diverge in *structure* (ordering, which elements appear); the guarantee is weaker. **(b) Status quo (hand-maintained duplicates)** — the bug. |
| Where the view-model vocabulary lives | **`@opensip-tools/cli-ui`** (generic `ViewNode`/`Span`/`Tone`, no contracts import) | Keeps cli-ui ink+react-only and reusable; both interpreters sit next to the theme they map tones onto. | Put it in `contracts` — but then cli-ui must import contracts to render it, coupling the UI kit to result types. Rejected. |
| Where `CommandResult → ViewNode` lives | **`@opensip-tools/cli`** (the existing `App.tsx` owner) | cli already owns the `result.type` switch and may depend on everything. Natural home for the mapping. | Each tool maps its own result — spreads the mapping and re-introduces per-tool drift. Rejected. |
| Color representation in the IR | **Semantic `Tone`** (`brand`/`success`/`error`/`warning`/`info`/`muted`/`default`), not raw color | Ink interpreter maps `Tone → DEFAULT_THEME` token; text interpreter ignores it. Single semantic vocabulary, theme stays the only color source. | Raw color strings in the IR — leaks theme into the model and into text. Rejected. |
| Ink-vs-text decision point | **Central dispatcher**, from `detectTerminalCapabilities().isTTY` + `NO_COLOR` + `--json` | One place, matches the existing capability gate; tools stay rendering-agnostic. | Per-tool `isTTY` checks — the current graph pattern; the thing we are removing. Rejected. |
| Graph integration | **Add `graph-done` `CommandResult`**; delete `write*Plain`/`writeUnifiedReport` | Folds the outlier into the one path every other tool uses; both renderings derive from one view-model. | Keep graph self-rendering but share format fns — leaves graph off the central seam. Rejected. |
| Banner in plain-text (non-TTY) | **Suppress it** | Cleanest CI logs and pipes; matches how `--json`/completion already skip the banner. Decoration shouldn't cost log lines or pollute `> file`. | One-line text wordmark / full ASCII-as-text — noisier in logs and diffs. Rejected. |
| Sequencing | **Phased** — drift-prone shared elements first, rich Ink-only components after | Highest-value/highest-risk duplicates removed by Phase 3; low-risk rich components migrate incrementally behind the same IR. Smaller PRs. | Big-bang migrate all 16 result types at once — larger blast radius, harder review. Rejected. |

## Success Criteria (testable)

- [ ] `renderToText(node)` output contains **no** ANSI escape (`\x1b[`) for
      any `ViewNode` — asserted by a unit test over all node kinds.
- [ ] For `fit-done`, `sim-done`, `graph-done`, and `error`: a test renders
      the result through both interpreters and asserts
      `stripAnsi(inkOutput).trimEnd() === textOutput.trimEnd()` line-for-line.
- [ ] `rg "process\.(stdout|stderr)\.write" packages/graph/engine/src
      packages/fitness/engine/src` returns only warnings-to-stderr and
      documented side-channels — zero human-report writes.
- [ ] `graph-report.ts` no longer exports `writeRunSummaryPlain`,
      `writeFooterHintsPlain`, `writeResolutionBannerPlain`,
      `writeUnifiedReport` (verified by grep + knip showing no orphans).
- [ ] `opensip-tools graph <scope> | cat` shows the same summary line,
      footer hints, and resolution banner text as a TTY run, **with no
      banner** (manual + snapshot).
- [ ] cli-ui `package.json` runtime deps remain exactly `ink`, `react`.
- [ ] `pnpm typecheck && pnpm test:coverage && pnpm lint` green; `--json`
      byte-output for `fit`/`graph`/`sim` unchanged (golden test).

## Boundaries

- **Always:** every new shared output element is a `ViewNode` producer
  consumed by both interpreters; cross-renderer equivalence test accompanies
  each migrated result; `.js` ESM extensions; theme is the only color source;
  tests land in the same phase as the code (coverage gate).
- **Ask first:** any change to the `CliOutput` v1.0 `--json` shape; any new
  cli-ui runtime dependency; changing human-readable text content (vs.
  preserving it) for an existing command; adding a `ViewNode` kind that
  implies layout beyond line-oriented blocks (e.g. multi-column flex).
- **Never:** import `@opensip-tools/contracts` from `@opensip-tools/cli-ui`;
  emit ANSI from `renderToText`; reintroduce per-tool `isTTY` branching or
  hand-maintained plain-text duplicates; direct color-lib imports.

## Open Questions

- [ ] **Text-renderer fidelity for tables.** `fit-done` uses `ResultsTable`
      (column alignment). Does the `table` `ViewNode` need column-width
      computation in `renderToText`, or is a simpler whitespace-padded form
      acceptable for piped output? Resolvable during planning; affects IR
      richness. (Deferred to Phase 4 — tables aren't in the drift-prone set.)

### Resolved

- **Banner in non-TTY:** suppress (no banner in plain-text mode).
- **Migration scope:** phased (shared drift-prone elements first; rich
  components incrementally).
- **Live views end state:** TTY-only now; later phase to express the final
  frame via the view-model (tracked in
  `docs/backlog/live-view-final-frame-dual-render.md`; out of scope here).

## Applicable Conventions (from CLAUDE.md)

- **Errors:** unchanged; `ErrorResult` + `mapToolErrorToExitCode` already
  centralized. No new error types expected.
- **Logging:** N/A (presentation layer).
- **Config:** N/A (no new config schema).
- **DI / RunScope:** renderer selection reads terminal state at the
  dispatcher; no new module-level mutable state. If a renderer needs
  per-invocation context it comes via args/scope, not globals.
- **Testing:** Vitest; Ink side via `ink-testing-library` (already used in
  `cli-ui/src/__tests__`); `*.test.ts(x)` beside source; coverage thresholds
  enforced by `pnpm test:coverage` in CI. New cross-renderer equivalence
  tests in cli-ui (IR-level) and cli (result-level).
- **Layering:** dependency-cruiser must stay green; the cli-ui-must-not-
  import-contracts rule is load-bearing for this design.
- **Docs:** update `docs/public/` CLI/architecture pages describing the
  rendering model; regenerate `docs/web-generated/` via `pnpm docs:build`.
