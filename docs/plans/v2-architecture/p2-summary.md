# Phase 2 Summary — Tool plugin contract

## What landed

`@opensip-tools/core` gained a `Tool` plugin contract (metadata, commands,
optional initialize). fitness and simulation became first-class Tool
implementations exporting `fitnessTool` / `simulationTool`. All
fitness-specific CLI command implementations moved into the fitness
package (`fit`, `dashboard`, `list-checks`, `list-recipes`); the sim
command moved into simulation. A new `@opensip-tools/cli-shared` package
holds the cross-tool CLI infrastructure (types, exit codes, session
persistence, dashboard HTML generator) so tool packages can depend on
it without depending on the CLI entry point.

The CLI's source code still imports `executeFit`, `openDashboard`, etc.
directly from `@opensip-tools/fitness` and `executeSim` from
`@opensip-tools/simulation`. Phase 4 will replace these direct imports
with a generic Tool registry walk.

## Final package list and dep graph

```
@opensip-tools/core                 — kernel: errors, logger, IDs, retry, languages, plugin discovery, Tool contract
  ↑
@opensip-tools/cli-shared           — CLI types, exit codes, session persistence, dashboard HTML
  ↑
@opensip-tools/fitness              — fitness engine + fit/dashboard/list-checks/list-recipes commands
  ↑
@opensip-tools/checks-typescript    — TS-AST checks
@opensip-tools/checks-universal     — cross-language checks
@opensip-tools/checks-{python,go,java,cpp}
                                    — language-specific check packs

@opensip-tools/simulation           — simulation engine + sim command (depends on core + cli-shared)

@opensip-tools/lang-{typescript,rust,python,go,java,cpp}
                                    — language adapters (depend on core; lang-typescript on fitness for filterContent)

@opensip-tools/cli                  — entry point: imports from all tool packages + cli-shared
```

## Counts

- 12 source files moved with `git mv`:
  - `cli/src/{types.ts, exit-codes.ts}` → `cli-shared/src/`
  - `cli/src/persistence/store.ts` → `cli-shared/src/persistence/store.ts`
  - `cli/src/persistence/dashboard/*` (8 files) → `cli-shared/src/persistence/dashboard/*`
  - `cli/src/commands/{fit,dashboard,list-checks,list-recipes}.ts` → `fitness/src/cli/`
  - `cli/src/commands/sim.ts` → `simulation/src/cli/`
  - `core/src/plugins/check-package-discovery.ts` → `fitness/src/plugins/check-package-discovery.ts`
  - The discovery test followed its source.
- New files: `cli-shared/{package.json, tsconfig.json, src/index.ts}`,
  `core/src/tools/{types.ts, registry.ts, index.ts}`,
  `core/src/plugins/tool-package-discovery.ts`,
  `fitness/src/tool.ts`, `simulation/src/tool.ts`.
- Import sites rewritten in CLI source: ~30 (relative `../types.js` /
  `../exit-codes.js` / `../persistence/...` paths → `@opensip-tools/cli-shared`;
  `./commands/{fit,dashboard,list-checks,list-recipes}.js` → `@opensip-tools/fitness`;
  `./commands/sim.js` → `@opensip-tools/simulation`).

## Judgment calls

1. **Created `@opensip-tools/cli-shared` rather than moving CLI types into core.**
   The CLI types (CliOutput, FitDoneResult, etc.) are tool-agnostic but
   they are CLI-specific output shapes — not kernel material. Putting
   them in core would have bloated the kernel and made core depend on
   things it shouldn't (session persistence, dashboard HTML). cli-shared
   keeps the dependency graph clean and acyclic.

2. **Tool contract lives in `core/src/tools/` not its own package.**
   Per user decision in the plan questionnaire.

3. **`check-package-discovery.ts` moved into fitness.** It's
   semantically fitness-specific (it scans for `@opensip-tools/checks-*`
   packages — a fitness concept). Phase 2 also added the kernel-level
   `tool-package-discovery.ts` in core.

4. **CLI still drives commands directly.** Phase 2 doesn't rewire the
   CLI's command tree — that's Phase 4. The fitness/simulation tools'
   `commands` arrays exist but aren't yet driving the dispatch.

## Verification

- `pnpm -r build` — green (17 packages, 0 errors)
- `pnpm -r typecheck` — green
- `pnpm -r test` — green (370+ tests pass; the persistence test was
  updated to import dynamically from `@opensip-tools/cli-shared` rather
  than the relative `../persistence/store.js` path)
- DART `npx opensip-tools fit` → `120 Passed, 0 Failed (0 Errors, 11 Warnings)`
  bit-for-bit parity with main.
- DART `npx opensip-tools fit --list` works
- DART `npx opensip-tools fit --recipes` works
- DART `npx opensip-tools sim` works (shows the development notice)

## Recovery from mid-phase crash

The first attempt at Phase 2 crashed mid-execution with an API error.
The working tree was left with file moves complete but ~30 import sites
still pointing at the old relative paths. Recovery was mechanical:
sed-driven rewrite of `../types.js` → `@opensip-tools/cli-shared` etc.,
plus a manual fix to one dynamic-import string the regex missed.

No work was lost.

## Blockers / open questions

None. The CLI's `cli/src/commands/{fit,dashboard,list-checks,list-recipes,sim}.ts`
shim files are gone (deleted as part of the move). cli/src/commands/
still contains the CLI-internal commands: clear, completion, configure,
history, init, plugin, project-plugins, uninstall.
