# opensip-tools v2.0.0 — architecture refactor

**Posture:** strict kernel, single-package tool contract, all four phases today.
**Outcome:** opensip-tools is a true tool-plugin platform. fitness and simulation
become peer packages. core is a tool-agnostic kernel. Adding a third tool is
"write a Tool, install the package."

**Version:** 2.0.0. The split (1.0.0) was breaking for check packs. This is
breaking for the entire kernel API surface — every check pack updates its
imports, the CLI's command tree is rebuilt, the directory layout changes.

**Non-goal:** new tool functionality. Pure refactor. Behavior parity.

## Definition of done

1. `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` all green across the
   reorganized workspace.
2. `npx opensip-tools fit` on DART produces 120 checks, 0 errors, same warning
   set (the 11 dead-code false positives) — bit-for-bit parity with current
   main.
3. `npx opensip-tools sim --help` works — simulation tool still discoverable.
4. The CLI source has zero direct imports from `@opensip-tools/fitness` or
   `@opensip-tools/simulation`. It discovers them through the Tool contract.
5. No package import surface lost: anything DART or third-party check packs
   currently import from `@opensip-tools/core` is either still there (kernel)
   or available with a clear migration to `@opensip-tools/fitness`.

## Phases (executed in dependency order)

| # | Phase | Files touched (est) | Commit |
|---|-------|---------------------|--------|
| 1 | Extract `@opensip-tools/fitness` from core | ~250 | C1 |
| 2 | Add `Tool` contract; fitness + simulation implement it | ~15 | C2 |
| 3 | Directory reorg: `packages/<tool>/<package>/` layout | ~17 dirs | C3 |
| 4 | CLI loads tools generically from registry | ~10 | C4 |

Four commits, one per phase. Each commit leaves the workspace green.

---

## Phase 1 — Extract `@opensip-tools/fitness` from core

### What moves

From `packages/core/src/` → `packages/fitness/src/`:

- `framework/` (28 files) — `defineCheck`, `CheckRegistry`, `ExecutionContext`,
  `result-builder`, `path-matcher`, `file-cache`, `file-accessor`,
  `import-graph`, `parse-cache`, `content-filter`, `directive-inventory`,
  `ignore-processing`, `memory-profiler`, `scope-resolver`, `strip-literals`,
  `ast-utilities`, `register-helpers`, `define-check`, `check-config`,
  `check-types`, `constants`, `abortable-exec`.
- `recipes/` (11 files) — `FitnessRecipeService`, registries, parallel/
  sequential execution, retry, types.
- `signalers/` (4 files) — fitness signaler config.
- `targets/` (6 files) — fitness target/scope config + loader.
- `types/findings.ts` — `Finding`, `Severity`, `CheckResult`, `Signal` types.
  These are emitted ONLY by checks.

### What stays in `@opensip-tools/core`

The kernel. Ten things, no more:

- `lib/errors.ts` — `ToolError`, `ValidationError`, `Result`.
- `lib/logger.ts` — `logger`, `setLogLevel`, `setSilent`, `setRunId`.
- `lib/ids.ts` — `generateId`, `generatePrefixedId`, etc.
- `lib/retry.ts` — `withRetry`.
- `languages/` — `LanguageAdapter`, `defaultLanguageRegistry`,
  `parse-cache` (the registry, not the framework cache),
  `content-filter-dispatch`. **Used by both fitness and any future
  source-scanning tool.**
- `plugins/discover.ts`, `plugins/loader.ts` — plugin file/package
  discovery for the four domains (fit/sim/asm/lang).
- `plugins/check-package-discovery.ts` — moves to fitness (it's
  fitness-specific). **Decision:** keep here for now; it's already named
  `check-package-discovery` and rename it `tool-package-discovery` in
  Phase 2 when generalized.
- `plugins/types.ts` — generic `PluginDomain`, `LoadedPlugin`,
  `DiscoveredPlugin`, `PluginExports`.
  - `FitPluginExports` interface MOVES to fitness.
  - Domain types (`PluginDomain` union) stay generic.
- `config-resolution.ts` — locating `opensip-tools.config.yml`.
- `types/signal.ts` — only if shared by simulation/assess; else moves with
  fitness. Audit during execution.
- The new `Tool` contract added in Phase 2.

### What about `@opensip-tools/core`'s remaining barrel exports?

Hard cutover. Anything that moves to fitness is REMOVED from core's barrel.
Check packs update their `import { defineCheck } from '@opensip-tools/core'`
to `from '@opensip-tools/fitness'`. The strict kernel choice means no
deprecation alias.

### Steps

1. Create `packages/fitness/` with `package.json` (name `@opensip-tools/fitness`,
   version `2.0.0`, deps: `@opensip-tools/core: workspace:*`, `glob`, `minimatch`,
   `typescript`).
2. `git mv packages/core/src/{framework,recipes,signalers,targets} packages/fitness/src/`.
3. Move `types/findings.ts` to `packages/fitness/src/types/`.
4. In `core/src/index.ts`, delete every export that lives in moved
   subdirs. The new core barrel exports only the kernel symbols listed above.
5. In `fitness/src/index.ts`, re-export everything that used to come out of
   core's barrel for fitness consumers. Look at the previous core/src/index.ts
   exports as the reference list.
6. Update every `from '@opensip-tools/core'` import in:
   - `packages/checks-typescript/` (~70 files)
   - `packages/checks-universal/` (~95 files)
   - `packages/checks-go/`, `checks-python/`, `checks-java/`, `checks-cpp/`
     (~5 files each)
   - `packages/cli/src/commands/{fit,dashboard,list-checks,list-recipes}.ts`
   - `packages/cli/src/persistence/dashboard/checks.ts` (catalog rendering)
   - Anywhere else grep finds it
   ...to `from '@opensip-tools/fitness'` for moved symbols, kept as
   `from '@opensip-tools/core'` for kernel symbols. Single sweep with awareness.
7. Add `@opensip-tools/fitness: workspace:*` to:
   - all 6 check package `package.json` files
   - cli `package.json`
   Remove `@opensip-tools/core` from check packs IF they import nothing from
   core after step 6 (likely they all still do for `LanguageAdapter`-driven
   utilities — keep core as transitive dep through fitness).
8. Update `pnpm-workspace.yaml` if it has explicit listings (it uses globs).
9. Build, fix every TS error, repeat until clean.
10. Test, fix every test import, repeat until green.
11. Run DART fitness check, confirm 120/0/11.

### Pitfalls (accepted in advance)

- **`getCheckConfig` and friends.** These connect recipes to the in-memory
  config slice. They're fitness-only. They go to fitness.
- **`PROJECT_CONFIG_FILENAME` and `resolveProjectConfigPath`.** Both tools
  read the same project config file. Stays in core.
- **`buildScopeBasedFileMap` is exported from core's `framework/scope-resolver.ts`.**
  Fitness-specific. Goes to fitness.
- **`isCheck`** type guard is on a fitness type (`Check`). Moves to fitness.
- **`SignalersConfig`, `TargetsConfig`** — fitness-only naming, but the
  config loader logic is fitness-shaped. Moves to fitness.
- **Logger setup currently happens via `logger.ts` in core.** Stays in core,
  imported by fitness.

### Commit message (C1)

```
refactor(core,fitness): extract fitness engine into @opensip-tools/fitness

Moved:
  packages/core/src/{framework,recipes,signalers,targets}
  packages/core/src/types/findings.ts
→ packages/fitness/src/

Strict kernel: core now exports ONLY language adapters, plugin loader,
errors, logger, IDs, retry, config resolution. Every fitness symbol
(defineCheck, CheckRegistry, FitnessRecipeService, Finding, etc.) is
exclusively in @opensip-tools/fitness.

All check packs updated to import from @opensip-tools/fitness. CLI
fitness command updated. ~200 import sites touched.

Hard cutover, no deprecation alias. Bumps the workspace to 2.0.0.

Verified: pnpm -r build/typecheck/test green; DART fit 120 checks,
0 errors, parity preserved.
```

---

## Phase 2 — Tool plugin contract

### What it is

A `Tool` interface in `@opensip-tools/core/src/tools/`:

```ts
// packages/core/src/tools/types.ts
export interface ToolMetadata {
  readonly id: string                       // e.g. 'fitness', 'simulation'
  readonly version: string
  readonly description: string
}

export interface ToolCommand {
  readonly name: string                     // CLI subcommand: 'fit', 'sim'
  readonly description: string
  readonly aliases?: readonly string[]
  /** Hand off to the tool's CLI implementation. */
  readonly run: (argv: readonly string[], ctx: ToolRunContext) => Promise<ToolRunResult>
}

export interface ToolRunContext {
  readonly cwd: string
  readonly configPath?: string
  readonly logger: typeof import('../lib/logger.js').logger
  // Future: telemetry, dashboard handle, etc.
}

export interface ToolRunResult {
  readonly exitCode: number
  /** Optional structured output for --json. */
  readonly output?: unknown
}

/** What an @opensip-tools/<tool> package exports. */
export interface ToolPluginExports {
  readonly tool: Tool
}

export interface Tool {
  readonly metadata: ToolMetadata
  readonly commands: readonly ToolCommand[]
  /**
   * Optional: tool-level discovery. Called once at CLI startup so the
   * tool can register its own check / scenario / etc. packages.
   * Equivalent of fitness's loadDiscoveredCheckPackages today.
   */
  readonly initialize?: (ctx: ToolRunContext) => Promise<void>
}
```

### Tool registry

```ts
// packages/core/src/tools/registry.ts
export class ToolRegistry { register(tool: Tool); list(): Tool[]; get(id): Tool | undefined }
export const defaultToolRegistry = new ToolRegistry()
```

### Tool discovery

In `@opensip-tools/core/src/plugins/`:

```ts
// tool-package-discovery.ts — generalized from check-package-discovery.ts
discoverToolPackages({ projectDir }): DiscoveredToolPackage[]
```

Scans `node_modules/@opensip-tools/` for any package whose `package.json`
declares `"opensipTools": { "kind": "tool" }` (explicit marker, not a name
prefix — that breaks down for organizations publishing third-party tools).

For first-party convenience, the CLI's `package.json` declares both
`@opensip-tools/fitness` and `@opensip-tools/simulation` as direct deps,
so they're always loaded.

### What fitness and simulation export

`packages/fitness/src/tool.ts`:
```ts
export const fitnessTool: Tool = {
  metadata: { id: 'fitness', version: '2.0.0', description: 'Run fitness checks against a codebase' },
  commands: [
    { name: 'fit', description: '...', run: async (argv, ctx) => fitCommand(argv, ctx) },
    { name: 'fit-list', description: 'List available checks', ... },
    { name: 'fit-recipes', description: 'List available recipes', ... },
  ],
  initialize: async (ctx) => { /* discover check packs, register adapters */ },
}
```

The CLI's existing `fit.ts` becomes `fitCommand(argv, ctx)` inside the
fitness package — the implementation moves with the tool. CLI source
shrinks dramatically.

### Steps

1. Add `core/src/tools/` (types, registry).
2. Generalize `check-package-discovery.ts` → `tool-package-discovery.ts`
   in core/src/plugins/. Old check-package-discovery becomes fitness-internal.
3. Create `packages/fitness/src/tool.ts` exporting `fitnessTool`. The
   commands wrap the existing `fit.ts` etc.
4. Create `packages/simulation/src/tool.ts` exporting `simulationTool`
   wrapping the existing `sim.ts` command.
5. Move CLI command implementations into their tool packages.
   - `cli/src/commands/fit.ts` → `fitness/src/cli/fit.ts`
   - `cli/src/commands/dashboard.ts` → `fitness/src/cli/dashboard.ts`
   - `cli/src/commands/list-checks.ts` → `fitness/src/cli/list-checks.ts`
   - `cli/src/commands/list-recipes.ts` → `fitness/src/cli/list-recipes.ts`
   - `cli/src/commands/sim.ts` → `simulation/src/cli/sim.ts`
6. The CLI keeps only tool-agnostic commands: `init`, `plugin`,
   `clear`, `completion`, `configure`, `history`, `uninstall`, `sessions`.
7. fitness and simulation each export `tool` from their main barrel
   so the CLI can import.

### Commit message (C2)

```
feat(core,fitness,simulation): tool-plugin contract

Add the Tool interface in @opensip-tools/core/tools — { metadata,
commands, initialize? }. Tools are first-party (declared as CLI deps)
or third-party (discovered via package.json#opensipTools.kind === 'tool').

Migrate fitness and simulation to implement Tool. Their CLI commands
move INTO the tool packages: fitness owns fit/fit-list/fit-recipes/
dashboard; simulation owns sim. The CLI no longer imports
fitness-specific or simulation-specific code.

The check-package-discovery rule generalizes into tool-package-discovery.
Each tool registers its own sub-packages during initialize().

Result: adding a new tool ('audit', 'lint', whatever) is now a
"write a Tool, install the package" workflow. CLI source no longer
hardcodes any tool's name.
```

---

## Phase 3 — Directory reorganization

Today (flat):
```
packages/
  cli/  core/
  fitness/                       (created in Phase 1)
  simulation/
  checks-typescript/  checks-universal/  checks-python/  checks-go/
  checks-java/  checks-cpp/
  lang-typescript/  lang-rust/  lang-python/  lang-go/  lang-java/  lang-cpp/
```

Target (nested):
```
packages/
  cli/
  core/
  languages/
    lang-typescript/
    lang-rust/
    lang-python/
    lang-go/
    lang-java/
    lang-cpp/
  fitness/                       — tool root
    fitness/                     — engine package
    checks-typescript/
    checks-universal/
    checks-python/
    checks-go/
    checks-java/
    checks-cpp/
  simulation/                    — tool root
    simulation/                  — engine package
```

### Critical constraint

npm package names DON'T change. `@opensip-tools/checks-typescript` keeps
its name even though the directory becomes `packages/fitness/checks-typescript/`.
pnpm workspaces resolve by `name`, not path.

This makes the change purely a developer-experience win with zero runtime
impact and zero blast radius beyond the workspace globs file.

### Naming twist

`packages/fitness/fitness/` is awkward. Two options:
- A: keep as-is. Outer `fitness/` is the namespace, inner `fitness/` is
  the engine package. Mirrors how npm scopes work (`@opensip-tools/fitness`).
- B: name the inner package `engine/`. Then it's `packages/fitness/engine/`,
  package name still `@opensip-tools/fitness`.

I recommend **option B** — it's clearer at a glance ("the fitness engine")
and avoids the visual stutter. Same call for simulation: `packages/simulation/engine/`.

### Steps

1. Verify `pnpm-workspace.yaml` uses a deep glob (`packages/*` alone
   won't catch nested packages — needs `packages/**`). Update if needed.
2. `git mv` operations:
   ```
   packages/lang-* → packages/languages/lang-*
   packages/fitness → packages/fitness/engine
   packages/checks-* → packages/fitness/checks-*
   packages/simulation → packages/simulation/engine
   ```
3. Update each package's `tsconfig.json` `extends` if it uses a relative
   path (most extend `../../tsconfig.json` — becomes `../../../tsconfig.json`
   one level deeper).
4. Update workspace tooling: turbo config, vitest config inheritance,
   any path-based references in build scripts.
5. Verify build/test still green. The package names didn't change so
   imports still resolve.

### Commit message (C3)

```
refactor: nest packages by tool — packages/<tool>/<package>/

Workspace layout reorganized so each tool's packages live under one
directory. npm package names unchanged — purely DX cleanup, zero
runtime impact:

  packages/lang-*               → packages/languages/lang-*
  packages/fitness              → packages/fitness/engine
  packages/checks-*             → packages/fitness/checks-*
  packages/simulation           → packages/simulation/engine

`pnpm-workspace.yaml` glob extended to `packages/**`. tsconfig
extends paths bumped one level deeper. No other config changes.

Adding a new tool now slots cleanly under `packages/<tool>/`.
```

---

## Phase 4 — CLI as generic tool runner

### What it is

The CLI's command tree becomes data-driven. It builds a Commander/yargs
tree by iterating `defaultToolRegistry.list()` and registering each tool's
commands.

```ts
// packages/cli/src/index.ts (sketch)
import { Command } from 'commander'
import { defaultToolRegistry } from '@opensip-tools/core'
import { fitnessTool } from '@opensip-tools/fitness'
import { simulationTool } from '@opensip-tools/simulation'

defaultToolRegistry.register(fitnessTool)
defaultToolRegistry.register(simulationTool)
await loadDiscoveredTools(projectDir)   // scan node_modules for third-party tools

const program = new Command()
for (const tool of defaultToolRegistry.list()) {
  await tool.initialize?.(ctx)
  for (const cmd of tool.commands) {
    program.command(cmd.name)
      .description(cmd.description)
      .action((args) => cmd.run(args, ctx))
  }
}
// + CLI-owned commands (init, plugin, history, etc.)
program.parse()
```

### Steps

1. CLI's `index.ts` rewritten as a generic tool dispatcher.
2. Tool-agnostic commands (`init`, `plugin`, `history`, `clear`,
   `configure`, `uninstall`, `completion`) stay in CLI as they manage
   global concerns.
3. Delete the stub `cli/src/commands/{fit,sim,dashboard,list-checks,list-recipes}.ts`
   files left over from Phase 2 (their bodies are already in tool packages
   at that point).
4. Add a smoke test: `npx opensip-tools` with no args lists all tools'
   commands. `npx opensip-tools fit --help` works.

### Commit message (C4)

```
feat(cli): tool-agnostic command dispatcher

CLI builds its command tree from defaultToolRegistry instead of
hardcoded imports. fitness and simulation are registered at startup
(as direct deps); third-party tools discovered via node_modules.

Adding a new tool now never touches CLI source. The CLI's job is:
- Set up logger / config resolution
- Discover and register tools
- Build Commander tree from each tool's commands
- Run shared housekeeping commands (init, plugin, history, etc.)

Verified: full DART workflow runs unchanged; sim --help works;
fitness/simulation/check pack discovery all behave identically.
```

---

## Risks and what we're explicitly accepting

- **Blast radius is huge.** Phase 1 alone touches ~200 import sites. If
  the build breaks, it'll break in many places. Mitigated by: doing the
  sweep with grep + ed scripts where possible, building after every
  package, fixing forward.
- **No deprecation alias.** Anyone outside DART and the workspace check
  packs depending on `@opensip-tools/core`'s fitness symbols will break
  on upgrade. We accept this — DART is the only real consumer today.
- **CLI `index.ts` rewrite (Phase 4) is a real surface change.** Smoke
  tests cover it; e2e CLI tests cover it. Keep an eye on argv parsing —
  Commander's hierarchical commands are subtle.
- **Nested directories are usually fine, but tooling exceptions exist.**
  Specifically, vitest's `--reporter` / `--coverage` paths and turbo's
  `tasks.outputs` may need updating. Caught by Phase 3 build/test.

## Verification matrix

After EACH phase commits:
- `pnpm -r build` clean
- `pnpm -r typecheck` clean
- `pnpm -r test` green
- DART workspace `npx opensip-tools fit` → 120 checks / 0 errors / 11 warnings
- DART `cargo build --workspace` clean (sanity — no Rust impact expected)

The sequence is the verification: any phase that doesn't get to all-green
gets debugged before starting the next.

## Estimated time

Optimistic: 4-5 hours of focused work.
Realistic: 6-8 hours including debugging the import-graph fallout.
We have today. Going.
