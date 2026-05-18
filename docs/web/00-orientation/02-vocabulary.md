---
status: current
last_verified: 2026-05-15
title: "Vocabulary"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "The terms used everywhere in opensip-tools. Read this once before going deeper."
source-files:
  - packages/core/src/types/signal.ts
  - packages/core/src/tools/types.ts
  - packages/core/src/plugins/types.ts
  - packages/core/src/languages/adapter.ts
  - packages/fitness/engine/src/framework/check-types.ts
  - packages/fitness/engine/src/recipes/types.ts
  - packages/fitness/engine/src/signalers/types.ts
  - packages/fitness/engine/src/targets/types.ts
related-docs:
  - ./01-what-is-opensip-tools.md
  - ./03-system-context.md
  - ../10-mental-model/01-fitness-loop.md
---
# Vocabulary

The codebase has eleven load-bearing terms. If you know what each of these is, you can read any source file in the repo without guessing. They're listed in a deliberate order — earlier terms support later ones.

If you're skimming for one definition, [Ctrl-F]. If you're reading top-to-bottom, expect each entry to be ~3-6 sentences with a source pointer.

---

## Tool

A **Tool** is a kernel-level plugin that contributes one or more CLI subcommands. `fit` is a Tool. `sim` is a Tool. Anything you write that mounts under the `opensip-tools` binary is a Tool.

The contract lives in [`packages/core/src/tools/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/core/src/tools/types.ts). Each Tool exports `metadata` (id, version, description), a `commands[]` array (just names + descriptions, used for `--help`), an optional `initialize()` hook, and a `register(cli)` method that wires its actual Commander commands. The CLI is a generic dispatcher — it walks `defaultToolRegistry` and asks each Tool to register itself.

First-party Tools (`fit`, `sim`) are imported statically by the CLI. Third-party Tools are discovered by walking `node_modules` for any package whose `package.json` declares `opensipTools.kind === 'tool'`. See [`../10-mental-model/02-tool-plugin-model.md`](/docs/opensip-tools/10-mental-model/02-tool-plugin-model/).

## Check

A **check** is a single, named, deterministic rule. "No `console.log` in production code." "Cyclomatic complexity ≤ 25." "Every `defineCheck` declares a category." A check produces zero or more `Signal`s when run.

Checks are created with `defineCheck()` from [`packages/fitness/engine/src/framework/define-check.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/framework/define-check.ts), which returns a `Check` object ([`packages/fitness/engine/src/framework/check-types.ts:45`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/framework/check-types.ts)). A check's config carries an `id` (UUID, stable across renames), a `slug` (human-readable identifier), `tags`, a `description`, and one of three execution modes:

- **`analyze`** — per-file: `(content, filePath) => CheckViolation[]`. The framework filters comments and strings before calling.
- **`analyzeAll`** — multi-file: `(fileAccessor) => CheckViolation[]`. The check controls its own iteration; useful for cross-file rules like circular-import detection.
- **`command`** — external tool: `command: { argv: [...], parseOutput: ... }`. The framework runs the binary, captures stdout/stderr, and the check parses violations from the output.

Checks live in three places: project-local `.mjs` files under `opensip-tools/fit/checks/`, npm packages whose name matches `@opensip-tools/checks-*` (auto-discovered), and any package listed in `plugins.checkPackages:` in the project config (explicit pinning).

## Recipe

A **recipe** is a named selection of checks plus execution options. "Run the `quick-smoke` recipe" means run a curated subset of checks (selected by tag, glob, or explicit id list), in parallel or sequential mode, with configured timeouts and reporting.

Recipes are created with `defineRecipe()` from [`packages/fitness/engine/src/recipes/types.ts:218`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/recipes/types.ts). The recipe carries a `CheckSelector` (one of `all`, `tags`, `pattern`, or `explicit`), `execution` options (`mode: 'parallel' | 'sequential'`, `stopOnFirstFailure`, `timeout`, `maxParallel`), and `reporting` options (`format: 'table' | 'json' | 'unified'`, `verbose`).

The default recipe — what `opensip-tools fit` runs without `--recipe` — is built by [`packages/fitness/engine/src/recipes/built-in-recipes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/recipes/built-in-recipes.ts) and selects every enabled check. A project ships its own recipes under `opensip-tools/fit/recipes/*.mjs`.

`sim` has its own parallel recipe shape ([`packages/simulation/engine/src/`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/simulation/engine/src/)). Same idea, different selector.

## Scenario

A **scenario** is the sim-side equivalent of a check — a single, named, deterministic simulation. The four kinds today are:

- **`load`** — exercise the system at a workload level and measure throughput/latency.
- **`chaos`** — inject failures and assert recovery.
- **`invariant`** — assert a property holds across many random inputs.
- **`fix-evaluation`** — replay a corpus of fixes and score them.

Scenarios are defined by tool packs analogous to check packs ([`packages/simulation/engine/src/kinds/`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/simulation/engine/src/kinds/)). The shape is younger and less stable than checks — expect minor-version churn.

## Signal

A **signal** is the canonical violation record. Every check produces `Signal[]`. Every renderer (table, JSON, SARIF, dashboard) consumes `Signal[]`. The shape lives in [`packages/core/src/types/signal.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/core/src/types/signal.ts).

A signal carries `id`, `source` (`'fitness'` for fit, `'simulation'` for sim), `provider`, `severity` (`critical | high | medium | low`), `category` (`security`, `quality`, `architecture`, `testing`, `resilience`, `documentation`, `warning`, `performance`, `error`), `ruleId` (`fit:no-console-log`), `message`, optional `suggestion`, `filePath`, optional `line`/`column`, and a free-form `metadata` map.

The kernel exports `createSignal(input)` from [`packages/core/src/types/signal.ts:53`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/core/src/types/signal.ts) — that's how every check produces signals.

## Signalers config

The "signalers" name applies to a *configuration section*, not a rule primitive. The `signalers` directory ([`packages/fitness/engine/src/signalers/`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/signalers/)) owns the loader and Zod schema for `opensip-tools.config.yml`. The schema covers `globalExcludes`, `targets`, `checkOverrides`, fitness/simulation configuration (`failOnErrors`, `maxParallel`, `disabledChecks`, `schedules`), and the `cli` defaults block.

The name reflects the conceptual model: opensip-tools' signal producers (fitness, simulation, future audit) are "signalers", and this is their config file. There is no separate "signaler" rule type — every rule is a `Check`. If you want a configuration-driven shape over `defineCheck`, that's something a check pack can build on top, but the kernel doesn't ship one.

## Ignore directive

An **ignore directive** is an inline source-level comment that suppresses violations from a specific check. Two flavors:

- `// @fitness-ignore-next-line <slug>` — suppress the next non-comment line.
- `// @fitness-ignore-file <slug>` — suppress every violation in this file (must appear in the first 50 lines).

Directives carry a slug so they're scoped to one check. The framework filters violations against the directive map after each check runs and records "applied directives" so the renderer can show "ignored 3 violations" alongside "found 1." The parser also recognizes neighboring linter directives (`eslint-disable-next-line`, `@ts-expect-error`, `prettier-ignore`, `biome-ignore`) so a stack of suppressions skips down to the actual target line. Lives in [`packages/fitness/engine/src/framework/directive-parsing.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/framework/directive-parsing.ts).

## Target

A **target** is a named glob set. Examples: `backend` (`packages/server/**/*.ts`), `tests` (`**/*.test.ts`), `module-foundation` (`packages/foundation/**`). A check can scope itself to a target so it only runs against the files in that set.

The shape lives in [`packages/fitness/engine/src/targets/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/targets/types.ts). Targets are loaded from `opensip-tools.config.yml`'s `targets:` section. The most important field on `TargetsConfig` is `globalExcludes` — repo-wide glob exclusions (replacing the old `.fitnessignore` file).

Targets also carry semantic metadata: `languages` (`'typescript' | 'rust' | ...`) and `concerns` (`'backend' | 'frontend' | ...`). A check can declare a `scope: { languages: [...], concerns: [...] }` and the resolver picks the matching targets automatically. This is the marketplace-ready shape — it lets a third-party check express "I apply to backend TypeScript" without knowing your project's specific glob layout.

## Language adapter

A **LanguageAdapter** is a per-language plugin that the framework dispatches to during content filtering. It implements one operation: given a file path and raw content, return content with comments and string literals stripped (so a check like `/TODO/` doesn't match the word "TODO" inside a comment that says "fix TODO bug").

The interface is in [`packages/core/src/languages/adapter.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/core/src/languages/adapter.ts). Six adapters ship today, one per language: `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp`. The CLI registers all six at startup; the framework dispatches per-file based on extension.

A check declares its preferred filter mode via `contentFilter: 'raw' | 'strip-strings' | 'strip-strings-and-comments'`. `'raw'` is the escape hatch for checks that *want* to see comments and string contents (e.g. a TODO scanner or a hardcoded-secret scanner).

## Plugin

A **plugin** is anything opensip-tools loads at runtime that wasn't compiled into it. Three flavors:

1. **Source-file plugins.** `.mjs` files under `opensip-tools/{fit,sim}/{checks,recipes,scenarios}/`. The plugin loader auto-discovers them at startup. Adding a check is "drop a file in checks/" — no config change.
2. **npm-package plugins.** Two discovery shapes coexist. **Tools** are any package whose `package.json` declares `opensipTools.kind === 'tool'` — the kernel walks `node_modules` for the marker. **Check packs** are any package whose name matches `@opensip-tools/checks-*` — the fitness engine walks `node_modules` by name prefix. See [`packages/core/src/plugins/tool-package-discovery.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/core/src/plugins/tool-package-discovery.ts) and [`packages/fitness/engine/src/plugins/check-package-discovery.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/plugins/check-package-discovery.ts).
3. **Project-pinned plugins.** Listed under `plugins.{fit,sim,asm,lang}:` in `opensip-tools.config.yml`. When this list is present, *only* those packages are loaded — auto-discovery is disabled, so no surprise plugin gets pulled in via a transitive dep.

The `opensip-tools plugin` command surface (`add`/`remove`/`list`/`sync`) manages the project-pinned form. See [`packages/cli/src/commands/plugin.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/cli/src/commands/plugin.ts).

## Session

A **session** is one run of `opensip-tools fit` (or `sim`). Each session writes a JSON artifact under `<project>/opensip-tools/.runtime/sessions/`, plus a structured log under `.runtime/logs/`, plus a rendered HTML report under `.runtime/reports/`.

Sessions are addressed by a prefixed ID (`run_<base32>`). The CLI's `--run-id` flag and the logger's correlation field both use this id. The `sessions list` command browses past sessions; `sessions purge` deletes them.

The runtime dir is gitignored — sessions are local artifacts, not source. The path resolver lives in [`packages/core/src/lib/paths.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/core/src/lib/paths.ts).

## Gate

A **gate** is the architecture-baseline workflow. `opensip-tools fit --gate-save` writes the current findings to a SARIF baseline. `opensip-tools fit --gate-compare` runs again, compares to the baseline, and exits non-zero if any *new* violation appeared (existing ones are tolerated; resolved ones are celebrated).

The gate matches by `(filePath, ruleId, message)` — line numbers are deliberately excluded from the identity hash so unrelated line shifts don't register as added/resolved violations. See [`packages/fitness/engine/src/gate.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/gate.ts) and [`../60-subsystems/03-architecture-gate.md`](/docs/opensip-tools/60-subsystems/03-architecture-gate/).

---

## Words you'll see but that aren't load-bearing

A few terms that appear in the codebase or docs but aren't kernel concepts:

- **Pack** — informal name for an npm package that ships checks (e.g. `@opensip-tools/checks-typescript`). Same thing as a check-pack plugin.
- **Finding** — synonym for `Signal`, used in some legacy comments. Prefer `Signal`.
- **Violation** — what a check returns to the framework (`CheckViolation[]`). The framework converts each violation into a Signal. Use `violation` inside a check, `Signal` everywhere else.
- **Selector** — the discriminated-union type a recipe uses to pick checks (`all | tags | pattern | explicit`). Lives in [`packages/fitness/engine/src/recipes/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.2.0/packages/fitness/engine/src/recipes/types.ts).

---

## What's next

With the vocabulary internalized, [`03-system-context.md`](/docs/opensip-tools/00-orientation/03-system-context/) will show you where the binary lives, what it touches on disk, and how the user-level and project-level surfaces split. After that, you're ready for the mental-model section.
