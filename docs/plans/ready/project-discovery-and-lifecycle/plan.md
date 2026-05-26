# Project Discovery & Lifecycle-Aware CLI Plan

Introduce a unified `ProjectContext` resolved once per CLI invocation, a two-bucket `uninstall` model that protects user-authored content by default, a `schemaVersion` field that enables future upgrade messaging, and a scope-aware `Project:` header — so customers can no longer accidentally scaffold phantom projects, lose custom checks, or get cryptic Zod errors after an upgrade.

## Problem

`opensip-tools` treats `process.cwd()` as the project root with zero discovery. The bug surfaces in three ways today:

1. **Phantom scaffolds.** Running any command from a subdirectory of an initialized project silently creates a *second* `opensip-tools/` tree at the subdir. Evidence: `/Users/sb/Documents/Code/opensip-ai/opensip/opensip-tools/fit/opensip-tools/.runtime/logs/2026-05-17.jsonl` exists in a sibling repo, with the first log line recording `cwd: ".../opensip/opensip-tools/fit"`. The user `cd`'d into `fit/` to look at custom checks; the CLI silently scaffolded a phantom project under that directory.
2. **Destructive uninstall default.** `opensip-tools uninstall --project` (`packages/cli/src/commands/uninstall.ts:147-233`) deletes user-authored content (custom checks, recipes, scenarios, config) by default. The warning text reads "Git history is your safety net" — which is hope, not a contract. There is no flag to preserve user content.
3. **No upgrade story.** `opensip-tools.config.yml` has no version field. A breaking config schema change between CLI versions produces a Zod error at load time with no detection and no actionable message.

Two cross-cutting problems make all three harder to debug:

- **No command tells the user where it's operating.** A `Project: /abs/path` line is the missing piece for trust.
- **Tool packages own their own Commander handlers.** `fitness/engine/src/tool.ts:174`, `simulation/engine/src/tool.ts:54`, and `graph/engine/src/tool.ts:92` each declare `.option('--cwd <path>', 'Target directory', process.cwd())` and route through tool-specific opts→args adapters. Any discovery fix that only wires CLI-owned commands silently misses the most common commands (`fit`, `sim`, `graph`). The fix has to land in the contract surface (`ToolCliContext`), not just at the bootstrap seam.

## Target State

After this plan:

- One resolved `ProjectContext` per CLI invocation, computed by `pre-action-hook` after `--cwd` is parsed. Carries `cwd`, `cwdExplicit`, `projectRoot`, `configPath`, `walkedUp`, `scope`. Threaded through `ToolCliContext.project` so first-party tools (and third-party tools that ship later) read from one source of truth.
- `opensip-tools <any-command>` walks up from `cwd` to the nearest `opensip-tools.config.yml`, honoring the existing `package.json#opensip-tools.configPath` pointer at each ancestor (the same three-tier precedence `resolveProjectConfigPath` already implements at a single directory level). Uses the discovered ancestor as `projectRoot`. Falls back to `cwd` only for `init` when no parent project is found.
- `opensip-tools init` refuses to scaffold when discovery finds a parent project, unless the user explicitly passes `--cwd <path>`. The refusal message offers three copy-paste-ready next actions.
- `opensip-tools uninstall --project` removes only `opensip-tools/.runtime/` (rebuildable state) by default. `--purge` is required to touch user-authored content + the config file. The "user-authored" bucket is *everything under `opensip-tools/` other than `.runtime/`* — future tools and user-created dirs are preserved automatically.
- Every project-scoped, human-readable command renders a `ℹ Project: <abs path>` header (with `(found N levels up)` annotation when discovery walked) before its main output. Suppressed for `--json`, `--help`, `--version`, `completion`, and user-scoped commands.
- `opensip-tools.config.yml` carries a `schemaVersion: 1` field. The CLI detects version skew at load time: silent when compatible, structured "upgrade the CLI" message pointing at `npm install -g @opensip-tools/cli@latest` when the config is newer than the CLI knows. (When `migrate` ships later, older-than-CLI configs grow their own message.)
- A stale phantom `opensip-tools/` subtree below the discovered root triggers an info message ("Detected an orphaned opensip-tools/.runtime/ at <path> — safe to delete with rm -rf <path>"). Never auto-deleted.
- The README copy at `README.md:674` ("Project-mode uninstall removes user-authored content … git history is the safety net") is rewritten in lockstep with the behavior change. CHANGELOG entry documents the breaking default change.

Example session post-plan, from a subdirectory:

```
$ cd packages/api && opensip-tools fit
ℹ Project: /Users/sb/work/my-app  (found 2 levels up)
[analysis output]
```

## Design Principles

**No backwards compatibility.** The destructive `uninstall --project` default is replaced outright — there is no flag to restore the old behavior beyond `--purge`. The plan introduces no compatibility shims, no feature flags, no opt-in toggles. The architecturally correct behavior becomes the only behavior.

**Contract over convention.** Discovery is expressed in the `ToolCliContext` contract, not in scattered call-site conventions. Tools cannot accidentally bypass discovery — the type system fails them if they try to read `opts.cwd` instead of `ctx.project.root` (the field doesn't carry the resolved root). The first-party tools (`fitness`, `simulation`, `graph`) are migrated in lockstep; future third-party tools inherit the contract automatically.

**One context, one resolution.** `ProjectContext` is resolved exactly once per CLI invocation, in `pre-action-hook` after `--cwd` is parsed. Resolution itself is pure — no filesystem writes.

**Side effects follow intent.** `.runtime/` is created only when a command actually does work that needs it. The datastore is opened lazily on first access (via a getter on `ToolCliContext.datastore`), the log-file backing is initialised only after schema and "no project found" bailouts have decided the run will proceed, and dry-runs / errors leave the filesystem clean. The SQLite backend's `mkdirSync` (`packages/datastore/src/backends/sqlite.ts:8`) only fires when a tool's action body genuinely reads `cli.datastore` for the first time. This is the architectural difference between "an opensip-tools command was invoked here" and "an opensip-tools command did real work here."

**Strict `--config`.** When the user passes `--config <path>` and the path does not resolve to a config file, the CLI errors with the structured `ValidationError` from `resolveProjectConfigPath`. It does **not** silently walk up to find some other config — that would be the same class of "command found the wrong thing" surprise the rest of this plan eliminates. Implicit discovery (no `--config` flag) still walks; explicit paths are honored strictly.

**Naming consistency.** Three surfaces carry the resolved `ProjectContext`, with different field names by surface to avoid Commander-flag collisions:

| Surface | Field |
|---------|-------|
| Commander `opts` (set by preAction) | `opts.projectContext` |
| `ToolCliContext` (tools read via getter) | `ctx.project` |
| Tool `CliArgs` bridge (built from opts in the action callback) | `args.project` |

The `opts.projectContext` name avoids collision with `--project [path]` (a flag value `uninstall.ts` already uses). `ctx.project` and `args.project` have no such conflict.

**User-authored content is sacred.** The plan establishes a clear boundary between *runtime state* (`opensip-tools/.runtime/`, rebuildable, owned by the tool) and *user-authored content* (everything else under `opensip-tools/`, owned by the customer). No tool operation may destroy user-authored content as a side effect of a non-destructive command. The destructive command (`uninstall --purge`) must show the user exactly what will disappear before doing it.

**Plan-improvements pipeline.** This repo does not currently host the pipeline at `docs/ai-helpers/prompts/plan-improvements/plan-improvements.md`. Architectural compliance, observability event-name policy, hardening posture, audit, and cross-cutting instrumentation are *not* exhaustively addressed in this draft and will need a follow-up pass before implementation. Each phase that touches a concern owned by a pipeline phase carries a `> Deferred: <concern>` blockquote pointing at what's missing.

## Phases

| Phase | Name | Description | Depends On |
|-------|------|-------------|------------|
| 0 | ProjectContext resolver | `resolveProjectContext` in `core/lib/`. Walks ancestors via `resolveProjectConfigPath` (honors `package.json` pointer). | — |
| 1 | Contract + bootstrap | Extend `ToolCliContext` with `project: ProjectContext`. Move datastore open out of `bootstrapCli` into `pre-action-hook` (after `--cwd` parses). | 0 |
| 2 | Project header | `formatProjectHeader` in `cli-ui` + scope-aware mount in `pre-action-hook` (suppress for `--json` / completion / help / version / user-scoped commands). Verify no overlap with `RunHeader`. | 1 |
| 3 | Call-site migration | Migrate `init`, `uninstall`, `plugin`, `configure`, `sessions`, `dashboard` PLUS the three tool packages (`fitness/tool.ts`, `simulation/tool.ts`, `graph/tool.ts`) to read `ctx.project.root` instead of `opts.cwd`. | 1 |
| 4 | Init refusal | Refuse with three-option message when `init` runs inside an existing project without explicit `--cwd`. Wire through `InitResult` in `contracts/types.ts` and render in `InitFeedback.tsx`. | 3 |
| 5 | Uninstall buckets + docs | Refactor `collectTargets`: `.runtime/` is the sole "delete-by-default" bucket; everything else under `opensip-tools/` is preserved. Add `--purge`. Update README + CHANGELOG. | 3 |
| 6 | Schema version | Add `schemaVersion: 1` to config schema + scaffolded configs. Detect skew at load time; "upgrade the CLI" message for newer-than-CLI; silent info log for older-than-CLI (until `migrate` ships). | 3 |
| 7 | Phantom detect | Detect orphaned `opensip-tools/` subtrees between `cwd` and `projectRoot`. Warn, never auto-delete. | 1 |
| 8 | Tests | Unit + integration tests for everything above, including tool-package coverage. | All implementation |
| 9 | Validation | End-to-end scenarios spanning fit/sim/graph + lifecycle moments. | 8 |

## Dependency Graph

```
Phase 0 (ProjectContext resolver)
└── Phase 1 (Contract + bootstrap)
      ├── Phase 2 (Project header)             ── parallel ──┐
      ├── Phase 3 (Call-site migration)                      │
      │     ├── Phase 4 (Init refusal)         ── parallel ──┤
      │     ├── Phase 5 (Uninstall + docs)     ── parallel ──┤
      │     └── Phase 6 (Schema version)       ── parallel ──┤
      └── Phase 7 (Phantom detect)             ── parallel ──┘
                                                             │
                              Phase 8 (Tests) ───────────────┘
                                    └── Phase 9 (Validation)
```

Phase 1 is the central seam — it grows the `ToolCliContext.project` field, so Phases 2–7 all depend on it. Phase 3 must precede 4/5/6 because those phases modify call sites Phase 3 has just migrated.

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | `packages/core/src/lib/project-context.ts`, `packages/core/src/lib/__tests__/project-context.test.ts` | `packages/core/src/index.ts` |
| 1 | — | `packages/core/src/tools/types.ts` (add `project: ProjectContext`), `packages/cli/src/bootstrap/pre-action-hook.ts`, `packages/cli/src/bootstrap/index.ts`, `packages/cli/src/cli-context.ts` |
| 2 | `packages/cli-ui/src/project-header.ts` | `packages/cli-ui/src/index.ts`, `packages/cli-ui/src/run-header.tsx` (Target: → Project:), `packages/cli/src/bootstrap/pre-action-hook.ts` |
| 3 | — | `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/register-init.ts`, `packages/cli/src/commands/uninstall.ts`, `packages/cli/src/commands/register-uninstall.ts`, `packages/cli/src/commands/plugin.ts`, `packages/cli/src/commands/configure.ts`, `packages/cli/src/commands/register-sessions.ts`, `packages/fitness/engine/src/cli/dashboard.ts`, `packages/fitness/engine/src/tool.ts`, `packages/simulation/engine/src/tool.ts`, `packages/graph/engine/src/tool.ts` |
| 4 | — | `packages/contracts/src/types.ts` (`InitResult` discriminator), `packages/cli/src/commands/init.ts`, `packages/cli/src/ui/components/InitFeedback.tsx` |
| 5 | — | `packages/cli/src/commands/uninstall.ts`, `README.md`, `CHANGELOG.md` (add entry) |
| 6 | `packages/core/src/lib/config-version.ts` | `packages/core/src/index.ts`, `packages/fitness/engine/src/signalers/schema.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/bootstrap/pre-action-hook.ts` |
| 7 | `packages/core/src/lib/phantom-detect.ts` | `packages/cli/src/bootstrap/pre-action-hook.ts` |
| 8 | Many `__tests__/*.test.ts` under packages above | — |
| 9 | `packages/cli/src/__tests__/e2e-discovery.test.ts` | `packages/cli/src/__tests__/e2e.test.ts` (add cross-reference) |

## Critical Files Reference

| File | Role | Key Structures |
|------|------|----------------|
| `packages/core/src/lib/paths.ts` | Path resolver. Sole place `'opensip-tools'` is appended. | `resolveProjectPaths(projectDir): ProjectPaths` (line 99), `ProjectPaths` interface (line 37) |
| `packages/core/src/config-resolution.ts` | Three-tier config-path resolution (`--config` → `package.json#opensip-tools.configPath` → default). Already honors the package.json pointer the discovery walker must reuse. | `resolveProjectConfigPath(rootDir, explicitPath?)` (line 63), `readConfigPathFromPackageJson(rootDir)` (line 30), `PROJECT_CONFIG_FILENAME` (line 23) |
| `packages/core/src/tools/types.ts` | Tool ↔ CLI contract surface. Adding `project: ProjectContext` here is the load-bearing change of Phase 1. | `ToolCliContext` (line 98), `Tool` (line 169), `maybeOpenDashboard` opt block (lines 135–139) |
| `packages/cli/src/bootstrap/pre-action-hook.ts` | Commander `preAction` hook. Centralises run-id, config-merge, log/persistence path setup. Already gates `initLogFile` behind `existsSync(cwd)` (line 54). Phase 1 makes this the single context-resolution site. | `installPreActionHook(program)` (line 32), `resolveProjectPaths(cwd)` call (line 44) |
| `packages/cli/src/bootstrap/index.ts` | Composition root. Today opens SQLite datastore *before* `--cwd` parses (line 92) — bug class Phase 1 fixes by deferring open to pre-action-hook. | `bootstrapCli(opts): BootstrapResult` (line 84), `DataStoreFactory.open` (line 93) |
| `packages/cli/src/cli-context.ts` | Builds the `ToolCliContext` instance handed to tools. Phase 1 adds `project` to the construction site. | `buildToolCliContext(...)` |
| `packages/fitness/engine/src/tool.ts` | Fitness Commander handler. Declares its own `--cwd` (line 174); maps Commander opts→`CliArgs` via `fitOptsToCliArgs` (line 103). The most-impactful call site for the bug fix. | `register(cli: ToolCliContext)` (line 127), `fitOptsToCliArgs` (line 103), per-mode subcommand registrars (lines 159+) |
| `packages/simulation/engine/src/tool.ts` | Simulation Commander handler. Same `--cwd` shape (line 54). | `register(cli: ToolCliContext)` (line 44), `toolOptsToCliArgs('sim', opts)` (line 64) |
| `packages/graph/engine/src/tool.ts` | Graph Commander handler. Same `--cwd` shape (line 92). | `program.command(GRAPH.name)...` (line 89), inline action body |
| `packages/cli/src/commands/init.ts` | Scaffold command with `--keep` / `--remove` mutex. State machine: `pristine` / `partial-config-only` / `partial-dir-only` / `fully-initialized`. | `executeInit(args)` (line 878), `classifyWorkingDir(paths)` (line 479), `runScaffold(...)` (line 827) |
| `packages/cli/src/commands/uninstall.ts` | `uninstall --project` / `--user` with confirm prompt. Today deletes `userSourceDir` + `configFile` together. | `executeUninstall(opts)` (line 208), `collectTargets(...)` (line 147), destructive iteration (lines 247–249) |
| `packages/contracts/src/types.ts` | Owns the `InitResult` discriminator surface that Phase 4 extends. | `InitResult` (line 273), `PreExistingFile` (line 268), `DashboardResult` (line 261) |
| `packages/cli/src/ui/components/InitFeedback.tsx` | The Ink/React renderer Phase 4 extends for the refusal message. | `InitFeedback` component (cited line 42); branches on the `InitResult` discriminator |
| `packages/cli-ui/src/index.ts` | Barrel for shared CLI UI primitives. Export site for the new `project-header` helper. | Existing exports: `banner.tsx`, `run-header.tsx`, `spinner.tsx`, `error-message.tsx`, `theme.ts`, `clock.ts` |
| `packages/fitness/engine/src/signalers/schema.ts` | Root Zod schema for `opensip-tools.config.yml`. Phase 6 adds the `schemaVersion` field. | `SignalersConfigSchema` (line 121), `section(schema)` preprocess wrapper (line 116) |
| `packages/contracts/src/cli-config.ts` | Permissive (non-Zod) reader of the `cli:` block. Pattern Phase 6.1 mirrors for top-level `schemaVersion`. | `loadCliDefaults(cwd, explicitPath?)` (line 96) |
| `packages/fitness/engine/src/cli/dashboard.ts` | Dashboard generator. One of the non-CLI tool-side call sites of `resolveProjectPaths`. | `openDashboard(projectDir?, datastore?)` (line 92), `resolveProjectPaths` calls (lines 72, 135) |
| `README.md` | Public docs. The `Project-mode uninstall removes user-authored content` paragraph at line 674 must update in lockstep with Phase 5. | Project-mode uninstall paragraph (line 674), state-table (line 685+) |

### Files this plan creates (greenfield)

| File | Role | Key Structures (planned) |
|------|------|--------------------------|
| `packages/core/src/lib/project-context.ts` (new — Phase 0) | One-shot project-context resolver. Architectural anchor of the whole plan. | `ProjectContext` (cwd, cwdExplicit, projectRoot, configPath, walkedUp, scope), `resolveProjectContext({ cwd, cwdExplicit, explicitConfigPath?, stopAt? })` |
| `packages/cli-ui/src/project-header.ts` (new — Phase 2) | Pure string formatter for the `Project: <abs path>` line. | `formatProjectHeader({ root, walkedUp }): string` |
| `packages/core/src/lib/config-version.ts` (new — Phase 6) | Permissive top-level `schemaVersion` reader + compatibility check. | `CLI_SUPPORTED_SCHEMA_VERSION`, `readConfigSchemaVersion(configPath): number`, `checkSchemaCompat(configVersion): 'ok' \| 'older' \| 'cli-too-old'` |
| `packages/core/src/lib/phantom-detect.ts` (new — Phase 7) | Detect orphaned `opensip-tools/` subtrees between `cwd` and `projectRoot`. Warn-only. | `detectPhantomRuntimes(cwd, root): readonly string[]` |

## Per-Task Verification Standard

At the end of every task, run:

```bash
pnpm build && pnpm typecheck && pnpm test
```

Phase-specific verification commands are listed in each phase file.

## Pipeline-deferred concerns

Because `docs/ai-helpers/prompts/plan-improvements/plan-improvements.md` does not currently exist in this repo, the following cross-cutting concerns are *not* addressed in this draft and must be revisited before merge:

- **Architectural compliance invariants.** Dependency-cruiser rules likely don't need changes (new modules sit in `core/lib/` and `cli-ui/src/`; tool-package modifications stay within their own layer). Verify explicitly during Phase 0 / Phase 3 implementation.
- **Observability event-name catalog.** Phase files name proposed `evt:` values inline (`project.root.resolved`, `project.root.not-found`, `cli.project.discovered`, `cli.init.refused`, `cli.uninstall.purge.confirmed`, `cli.config.schema.skew`, `cli.config.schema.cli-too-old`, `cli.phantom.runtime.detected`); the broader event-name policy needs a human review pass.
- **Hardening posture.** Discovery walks the filesystem reading paths from `cwd` up to `/`. The new readers stay within the discovered root subtree. No new input sanitization is anticipated; confirm during code review.
- **Audit trail.** No new state-mutating writes beyond existing init/uninstall scaffolding. Audit obligations unchanged.
- **Customer-facing copy review.** Phase 4 (init refusal), Phase 5 (uninstall printer), Phase 6 (schema-version error) all introduce customer-facing strings. The mockups are wired in as the proposed copy, flagged for human review before merge — *especially* the schema-version copy where the original draft had the message direction wrong.
