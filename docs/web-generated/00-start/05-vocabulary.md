---
status: current
last_verified: 2026-06-15
release: v0.1.8
title: "Vocabulary"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "The terms used everywhere in opensip-cli. Read this once before going deeper."
source-files:
  - packages/core/src/types/signal.ts
  - packages/core/src/tools/types.ts
  - packages/core/src/plugins/types.ts
  - packages/core/src/languages/adapter.ts
  - packages/core/src/recipes/registry.ts
  - packages/fitness/engine/src/framework/check-types.ts
  - packages/fitness/engine/src/recipes/types.ts
  - packages/fitness/engine/src/signalers/types.ts
  - packages/fitness/engine/src/targets/types.ts
  - packages/graph/engine/src/rules/define-rule.ts
  - packages/graph/engine/src/rules/registry.ts
related-docs:
  - ./01-what-is-opensip-cli.md
  - ./06-system-context.md
  - ../10-concepts/01-fitness-loop.md
---
# Vocabulary

The codebase has thirteen load-bearing terms. If you know what each of these is, you can read any source file in the repo without guessing. They're listed in a deliberate order — earlier terms support later ones.

If you're skimming for one definition, [Ctrl-F]. If you're reading top-to-bottom, expect each entry to be ~3-6 sentences with a source pointer.

---

## Tool

A **Tool** is a kernel-level plugin that contributes one or more CLI subcommands. `fit` is a Tool. `sim` is a Tool. `graph` is a Tool. Anything you write that mounts under the `opensip` binary is a Tool.

The contract lives in [`packages/core/src/tools/types.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/core/src/tools/types.ts). Each Tool exports `metadata` (id, version, description), a `commands[]` array (names + descriptions, used for `--help`), declarative `commandSpecs` (the typed command specs the host mounts), and an optional `initialize()` hook. The CLI is a generic dispatcher — it builds a per-invocation `ToolRegistry`, populates it during bootstrap, and mounts each registered Tool's `commandSpecs`.

First-party Tools (`fit`, `sim`, `graph`) load by package name through the same plugin path as third-party Tools ([ADR-0027](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/docs/decisions/ADR-0027-ga-parity-cutover.md)) — the CLI holds no static `import` of a tool runtime. Third-party Tools are discovered by walking `node_modules` for any package whose `package.json` declares `opensipTools.kind === 'tool'`. See [`../10-concepts/02-tool-plugin-model.md`](/docs/opensip-cli/10-concepts/02-tool-plugin-model/).

## Check

A **check** is a single, named, deterministic rule. "No `console.log` in production code." "Cyclomatic complexity ≤ 25." "Every `defineCheck` declares at least one tag." A check produces zero or more `Signal`s when run.

Checks are created with `defineCheck()` from [`packages/fitness/engine/src/framework/define-check.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/framework/define-check.ts), which returns a `Check` object ([`packages/fitness/engine/src/framework/check-types.ts:45`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/framework/check-types.ts)). A check's config carries an `id` (UUID, stable across renames), a `slug` (human-readable identifier), `tags`, a `description`, and one of three execution modes:

- **`analyze`** — per-file: `(content, filePath) => CheckViolation[]`. The framework filters comments and strings before calling.
- **`analyzeAll`** — multi-file: `(fileAccessor) => CheckViolation[]`. The check controls its own iteration; useful for cross-file rules like circular-import detection.
- **`command`** — external tool: `command: { argv: [...], parseOutput: ... }`. The framework runs the binary, captures stdout/stderr, and the check parses violations from the output.

Checks live in three places: project-local `.mjs` files under `opensip-cli/fit/checks/`, npm packages declaring `opensipTools.kind: "fit-pack"` (auto-discovered), and any package listed in `plugins.checkPackages:` in the project config (exact-name supplement).

## Recipe

A **recipe** is a named selection of checks plus execution options. "Run the `quick-smoke` recipe" means run a curated subset of checks (selected by tag, glob, or explicit id list), in parallel or sequential mode, with configured timeouts and reporting.

Recipes are created with `defineRecipe()` from [`packages/fitness/engine/src/recipes/types.ts:218`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/recipes/types.ts). The recipe carries a `CheckSelector` (one of `all`, `tags`, `pattern`, or `explicit`), `execution` options (`mode: 'parallel' | 'sequential'`, `stopOnFirstFailure`, `timeout`, `maxParallel`), and `reporting` options (`format: 'table' | 'json' | 'unified'`, `verbose`).

The default recipe — what `opensip fit` runs without `--recipe` — is built by [`packages/fitness/engine/src/recipes/built-in-recipes.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/recipes/built-in-recipes.ts) and selects every enabled check. A project ships its own recipes as `.js`/`.mjs` files under `opensip-cli/fit/recipes/`, including nested category directories.

The generic recipe substrate — the named selection of units (by id/tag) plus per-unit config overrides — lives in `@opensip-cli/core` (`RecipeRegistry<T>`, generic over the unit type), with the selector-resolution and per-unit-override logic shared. Each tool keeps its own *execution* strategy (fitness runs checks parallel/sequential over file content; sim runs scenarios; graph evaluates rules once over the dataset). `sim` and `graph` reuse the same substrate with their own selectors — same idea, different unit type.

## Scenario

A **scenario** is the sim-side equivalent of a check — a single, named, deterministic simulation. The two kinds today are:

- **`load`** — exercise the system at a workload level and measure throughput/latency.
- **`chaos`** — inject failures and assert recovery.

Scenarios are defined by tool packs analogous to check packs ([`packages/simulation/engine/src/kinds/`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/simulation/engine/src/kinds/)). The shape is younger and less stable than checks — expect minor-version churn.

## Rule

A **rule** is the `graph`-side equivalent of a check — a single, named analysis over the static call graph. The graph tool is an architectural peer of fitness: rules are authored with `defineRule` ([`packages/graph/engine/src/rules/define-rule.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/graph/engine/src/rules/define-rule.ts)), the parallel to `defineCheck`. The difference is the input — a check sees `(content, filePath)`; a rule's `evaluate(dataset)` sees the engine **dataset**: the catalog, the indexes, and a derived **feature layer** (per-function size, fan-out, blast radius, test reachability; package-coupling and SCC membership). "The data is the data, the engine is the engine" — rules are declarative queries over that dataset, and the dashboard's graph view is a pure view over the same data.

Ten rules ship today, in a fixed registration order ([`packages/graph/engine/src/rules/registry.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/graph/engine/src/rules/registry.ts)): the five original reachability/duplication rules (`orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`) plus five structural rules (`large-function`, `wide-function`, `high-blast-untested`, `cycle`, `unexpected-coupling`). Runtime loading of project-local rules is deferred — the bundled set is what runs today. Rule slugs are byte-stable (they key the baseline fingerprint), so a rule's `ruleId` survives refactors.

## Signal

A **signal** is the canonical violation record. Every check produces `Signal[]`. Every renderer (table, JSON, SARIF, dashboard) consumes `Signal[]`. The shape lives in [`packages/core/src/types/signal.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/core/src/types/signal.ts).

A signal carries `id`, `source` (`'fitness'` for fit, `'simulation'` for sim, `'graph'` for graph; the field is typed `string` so plugins can use any namespace), `provider`, `severity` (`critical | high | medium | low`), `category` (`security`, `quality`, `architecture`, `testing`, `resilience`, `documentation`, `warning`, `performance`, `error`; also typed `SignalCategory | string` so plugins can extend), `ruleId` (`fit:no-console-log`, `graph:orphan-subtree`, etc.), `message`, optional `suggestion`, `filePath`, optional `line`/`column`, and a free-form `metadata` map.

The kernel exports `createSignal(input)` from [`packages/core/src/types/signal.ts:53`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/core/src/types/signal.ts) — that's how every check produces signals.

## Signalers config

The "signalers" name applies to a *configuration section*, not a rule primitive. The `signalers` directory ([`packages/fitness/engine/src/signalers/`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/signalers/)) owns the loader and Zod schema for `opensip-cli.config.yml`. The schema covers `globalExcludes`, `targets`, `checkOverrides`, current fitness/simulation configuration (`failOnErrors`, `maxParallel`, `disabledChecks`, recipe defaults), and the `cli` defaults block. Scheduling keys are not part of the current schema; see the configuration reference roadmap notes for the strict rejection behavior.

The name reflects the conceptual model: opensip-cli' signal producers (fitness, simulation, future audit) are "signalers", and this is their config file. There is no separate "signaler" rule type — every rule is a `Check`. If you want a configuration-driven shape over `defineCheck`, that's something a check pack can build on top, but the kernel doesn't ship one.

## Ignore directive

An **ignore directive** is an inline source-level comment that suppresses violations from a specific check. Two flavors:

- `// @fitness-ignore-next-line <slug>` — suppress the next non-comment line.
- `// @fitness-ignore-file <slug>` — suppress every violation in this file (must appear in the first 50 lines).

Directives carry a slug so they're scoped to one check. The framework filters violations against the directive map after each check runs and records "applied directives" so the renderer can show "ignored 3 violations" alongside "found 1." The parser also recognizes neighboring linter directives (`eslint-disable-next-line`, `@ts-expect-error`, `prettier-ignore`, `biome-ignore`) so a stack of suppressions skips down to the actual target line. Lives in [`packages/fitness/engine/src/framework/directive-parsing.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/framework/directive-parsing.ts).

## Target

A **target** is a named glob set. Examples: `backend` (`packages/server/**/*.ts`), `tests` (`**/*.test.ts`), `module-foundation` (`packages/foundation/**`). A check can scope itself to a target so it only runs against the files in that set.

The shape lives in [`packages/fitness/engine/src/targets/types.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/targets/types.ts). Targets are loaded from `opensip-cli.config.yml`'s `targets:` section. The most important field on `TargetsConfig` is `globalExcludes` — repo-wide glob exclusions (replacing the old `.fitnessignore` file).

Targets also carry semantic metadata: `languages` (`'typescript' | 'rust' | ...`) and `concerns` (`'backend' | 'frontend' | ...`). A check can declare a `scope: { languages: [...], concerns: [...] }` and the resolver picks the matching targets automatically. This is the marketplace-ready shape — it lets a third-party check express "I apply to backend TypeScript" without knowing your project's specific glob layout.

## Language adapter

A **LanguageAdapter** is a bundled per-language adapter that the framework dispatches to during content filtering. It implements one operation: given a file path and raw content, return content with comments and string literals stripped (so a check like `/TODO/` doesn't match the word "TODO" inside a comment that says "fix TODO bug").

The interface is in [`packages/core/src/languages/adapter.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/core/src/languages/adapter.ts). Six adapters ship today, one per language: `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp`. The CLI registers all six at startup; the framework dispatches per-file based on extension.

A check declares its preferred filter mode via `contentFilter: 'raw' | 'strip-strings' | 'strip-strings-and-comments'`. `'raw'` is the escape hatch for checks that *want* to see comments and string contents (e.g. a TODO scanner or a hardcoded-secret scanner).

## Plugin

A **plugin** is anything opensip-cli loads at runtime that wasn't compiled into it. Three flavors:

1. **Source-file plugins.** `.mjs` files under `opensip-cli/{fit,sim}/{checks,recipes,scenarios}/`. The plugin loader auto-discovers them at startup. Adding a check is "drop a file in checks/" — no config change.
2. **npm-package plugins.** **Tools** are any package whose `package.json` declares `opensipTools.kind === 'tool'`; **check packs** declare `opensipTools.kind === 'fit-pack'` (marker discovery). **Sim packs** are discovered by **name-pattern** (ADR-0029): any installed `<scope>/scenarios-*` package under `@opensip-cli` plus configured `plugins.packageScopes`. There is no `opensipTools.kind === 'sim-pack'` marker — sim marker discovery was retired in ADR-0029. Capability package preferences are resolved from the already-validated `plugins:` block through each domain's descriptor. See [`packages/core/src/plugins/tool-package-discovery.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/core/src/plugins/tool-package-discovery.ts), [`packages/core/src/plugins/capability-discovery.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/core/src/plugins/capability-discovery.ts), and [`packages/config/src/capability-preferences.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/config/src/capability-preferences.ts).
3. **Project-pinned tool-domain plugins.** Listed under `plugins.fit:` or `plugins.sim:` in `opensip-cli.config.yml`. When a project-pinned list is present for that domain, only those packages are loaded for the project-local plugin lane. Separate capability pins use `plugins.checkPackages:`, `plugins.scenarioPackages:`, and `plugins.graphAdapters:`. Language adapters are bundled by the CLI and are not project-discovered plugins.

The per-tool `opensip <tool> plugin` command surface (`add`/`remove`/`list`/`sync`) manages the project-pinned form — mounted under each pack-supporting tool primary (`opensip fit plugin …`, `opensip sim plugin …`), with the domain bound from the tool (no top-level `opensip plugin`, no `--domain` flag). Whole Tool plugins use `opensip tools …`. See [`packages/cli/src/commands/plugin.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/cli/src/commands/plugin.ts).

## Session

A **session** is one run of `opensip fit`, `sim`, or `graph`. Each session is persisted as a row in the project-local SQLite datastore (`<project>/opensip-cli/.runtime/datastore.sqlite`) via `SessionRepo`, alongside a structured log under `.runtime/logs/` and a rendered HTML report under `.runtime/reports/`.

Each session record is keyed by a UUID (`session.id`, generated via `randomUUID()`) and ordered by its `timestamp` column (newest first). The persisted row carries only the columns every tool shares; per-session detail rides in a companion `session_tool_payload` row as a tool-owned opaque JSON blob. The logger uses a separate per-process correlation id of the form `RUN_<ulid>` (`generatePrefixedId('run')`); it appears in every log entry as `runId`. The `sessions list` command (with `--summary-only` for agents) browses past sessions; `sessions purge` deletes the rows. See `agent-catalog` (in the CLI commands reference) for the recommended way for agents to discover these surfaces and the new ergonomics around historical inspection.

The runtime dir is gitignored — sessions are local artifacts, not source. The path resolver lives in [`packages/core/src/lib/paths.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/core/src/lib/paths.ts).

## Gate

A **gate** is the architecture-baseline workflow. `opensip fit --gate-save` stores the current run's `SignalEnvelope` in the project SQLite baseline. `opensip fit --gate-compare` runs again, compares to the baseline, and exits non-zero if any *new* violation appeared (existing ones are tolerated; resolved ones are celebrated). Use `opensip fit export --format baseline` when CI needs a SARIF file.

The gate matches by `(filePath, ruleId, message)` — line numbers are deliberately excluded from the identity hash so unrelated line shifts don't register as added/resolved violations. See [`packages/fitness/engine/src/baseline-strategy.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/baseline-strategy.ts) and [`../10-concepts/05-architecture-gate.md`](/docs/opensip-cli/10-concepts/05-architecture-gate/).

---

## Words you'll see but that aren't load-bearing

A few terms that appear in the codebase or docs but aren't kernel concepts:

- **Pack** — informal name for an npm package that ships checks (e.g. `@opensip-cli/checks-typescript`). Same thing as a check-pack plugin.
- **Finding** — user-facing synonym for `Signal`. Prefer `Signal` in platform code.
- **Violation** — what a check returns to the framework (`CheckViolation[]`). The framework converts each violation into a Signal. Use `violation` inside a check, `Signal` everywhere else.
- **Selector** — the discriminated-union type a recipe uses to pick checks (`all | tags | pattern | explicit`). Lives in [`packages/fitness/engine/src/recipes/types.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.8/packages/fitness/engine/src/recipes/types.ts).

---

## What's next

With the vocabulary internalized, [`06-system-context.md`](/docs/opensip-cli/00-start/06-system-context/) will show you where the binary lives, what it touches on disk, and how the user-level and project-level surfaces split. After that, you're ready for the mental-model section.
