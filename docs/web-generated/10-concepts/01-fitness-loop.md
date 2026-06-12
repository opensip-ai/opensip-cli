---
status: current
last_verified: 2026-06-09
release: v1.0.0
title: "The fitness loop"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "One check, end to end. Definition → loading → recipe selection → scope resolution → execution → signal → render → exit. The spine of the doc set."
source-files:
  - packages/cli/src/index.ts
  - packages/fitness/engine/src/tool.ts
  - packages/fitness/engine/src/cli/fit.ts
  - packages/fitness/engine/src/recipes/service.ts
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/fitness/engine/src/framework/execution-context.ts
  - packages/fitness/engine/src/recipes/parallel-execution.ts
  - packages/fitness/engine/src/recipes/sequential-execution.ts
related-docs:
  - ../00-start/01-what-is-opensip-cli.md
  - ./02-tool-plugin-model.md
  - ../20-fit/01-recipes-and-checks.md
  - ../20-fit/03-ignore-directives.md
  - ../20-fit/04-output-gate-sarif.md
  - ../80-implementation/01-cli-dispatch.md
---
# The fitness loop

This is the spine. Every other doc in the set is a deeper read on one stage of this loop. If you understand only one doc in this set, make it this one.

> **What you'll understand after this:**
> - The eight stages a fitness run passes through, in order.
> - Where each stage lives in source.
> - What "the same check, run twice" actually means deterministically.
> - Where the worked example (`acme-api`) lands at every stage.

We trace one specific scenario: a single check named `no-console-log` (one of the `console-log` family of detectors in [`packages/fitness/checks-universal/src/checks/quality/code-structure/no-console-log.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/checks-universal/src/checks/quality/code-structure/no-console-log.ts)) running inside `acme-api`. We follow it from the moment you type `opensip fit` to the moment your shell prompt reappears.

---

## The eight stages

```
  argv          ┌──────────────────────────────────────────────────┐
   │            │  1. CLI dispatch       packages/cli/src/index.ts │
   ▼            └──────────────────────────────────────────────────┘
  commandSpecs ─────────► fitnessTool   (host-mounted; no raw Commander)
                            │
                            ▼
                ┌──────────────────────────────────────────────────┐
                │  2. Config + paths     core/lib/paths.ts         │
                │                        contracts/persistence    │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────────────────────────────┐
                │  3. Plugin load        core/plugins/discover.ts  │
                │                        fitness/plugins/          │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────────────────────────────┐
                │  4. Recipe selection   fitness/recipes/registry  │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────────────────────────────┐
                │  5. Target / scope     fitness/targets/          │
                │     resolution         fitness/framework/        │
                │                        path-matcher              │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────────────────────────────┐
                │  6. Check execution    fitness/framework/        │
                │                        define-check.ts           │
                │                        recipes/parallel-exec     │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────────────────────────────┐
                │  7. Signal aggregation core/types/signal.ts      │
                │                        contracts/types          │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────────────────────────────┐
                │  8. Render + exit      Ink (renderLive)          │
                │                        JSON / SARIF              │
                │                        exit code                 │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
                       shell prompt
```

Eight stages, every one a read away.

---

## Stage 1 — CLI dispatch

Source: [`packages/cli/src/index.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/cli/src/index.ts)

`opensip fit` invokes the binary. The CLI's job at this stage is small:

1. Parse global flags (`--debug`, `--quiet`).
2. Set up the logger and assign a `runId` (`RUN_<ulid>`).
3. Walk the per-invocation `ToolRegistry` (populated during bootstrap) and mount each registered Tool's declared `commandSpecs` via the host's `mountCommandSpec`. The fitness Tool declares `fit`, `fit-list`, `fit-recipes`, and `fit-baseline-export`; the host builds the Commander commands, applies the shared cross-tool flags, and owns the parse → handler → render → `--json` → exit pipeline. The cross-tool `report` command is mounted separately by the CLI because it composes data from every registered Tool.
4. Hand argv to Commander, which dispatches to the `fit` command spec's handler ([`packages/fitness/engine/src/tool.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/tool.ts) assembles the `commandSpecs`; the handler bodies live in the `cli/` spec modules alongside it).

The CLI does not know what `fit` does. It knows a Tool exists, it admitted and
imported it, mounted the typed `commandSpecs` the Tool declared, and Commander
now owns the routing. Everything specific to fitness from this point on lives
inside `@opensip-cli/fitness`; see [the tool-plugin model](/docs/opensip-cli/10-concepts/02-tool-plugin-model/).

> **Where the example lands:** the binary is `opensip-cli`, argv is `['fit']` (defaults applied), the resolved Tool is `fitnessTool` with metadata `{ id: 'fitness', version: <pkg.version>, description: 'Run fitness checks against a codebase' }`. (Version is read at startup from `@opensip-cli/fitness/package.json`.)

---

## Stage 2 — Config and paths

Source: [`packages/core/src/lib/paths.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/core/src/lib/paths.ts), the configure command for user-level settings, and `loadProjectConfig()` inside `executeFit()`.

The handler resolves two things:

1. **Project paths.** `resolveProjectPaths(cwd)` returns the canonical layout: where the config file is, where checks live, where the runtime dir is, where the gate baseline default lives. Every other component reads paths through this resolver — there's no `path.join('opensip-cli', '.runtime', ...)` scattered through the codebase.
2. **The project config.** Read from `<project>/opensip-cli.config.yml` (or the path passed via `--config`). The config carries `targets:`, `plugins:`, `globalExcludes:`, recipe overrides, and reporting defaults. See [`70-reference/03-configuration.md`](/docs/opensip-cli/70-reference/03-configuration/) for the full schema.

If the config is missing, the CLI exits 2 with a pointer to `opensip init`. If the config is malformed, the CLI exits 2 with the validation error.

> **Where the example lands:** `acme-api/opensip-cli.config.yml` declares two languages (`typescript`, `python`), one custom check directory, and a `quick-smoke` recipe pointing at universal checks only. The default invocation runs *every* check, not the `quick-smoke` set.

---

## Stage 3 — Plugin load

Source: [`packages/core/src/plugins/discover.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/core/src/plugins/discover.ts), [`packages/fitness/engine/src/plugins/`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/plugins/), [`packages/cli/src/bootstrap/register-language-adapters.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/cli/src/bootstrap/register-language-adapters.ts) (language-adapter registration).

Three sources of checks get loaded, in order:

1. **Language adapters.** Registered inside `bootstrapCli()` before any tool is mounted — `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp` each contribute one `LanguageAdapter` to the per-invocation `LanguageRegistry`. Without this, the framework would treat every file as raw text and a regex check looking for `console.log` would also match the literal string in a comment.
2. **npm-package check packs.** The plugin loader walks `node_modules` for packages declaring `opensipTools.kind: "fit-pack"` (the canonical marker form), plus any exact packages listed in `plugins.checkPackages:`. Each one exports a list of `defineCheck()` results. Bundled packs include `@opensip-cli/checks-universal`, `@opensip-cli/checks-typescript`, `@opensip-cli/checks-python`, etc.
3. **Project-local checks.** `.mjs` files under `<project>/opensip-cli/fit/checks/` are loaded via dynamic `import()`. Each module either exports a single `Check` (the value returned by `defineCheck()`) or an array of them.

`plugins.checkPackages:` is an exact-name supplement for non-marker packages; marker-based fit-pack discovery still runs.

After this stage, the in-memory check registry has every available check addressable by id and slug.

> **Where the example lands:** `acme-api` ends up with the universal pack, the typescript pack, the python pack, and three custom checks (`require-cdk-json-exists`, `no-print-outside-pipelines`, `infra-tag-required`). The `no-console-log` check we're tracing comes from `@opensip-cli/checks-universal` (it lives there because the regex shape is identical across JS/TS files and its strip behavior comes from the language adapter, not the pack).

---

## Stage 4 — Recipe selection

Source: [`packages/fitness/engine/src/recipes/registry.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/recipes/registry.ts), [`packages/fitness/engine/src/recipes/built-in-recipes.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/recipes/built-in-recipes.ts).

The `--recipe <name>` flag selects which recipe to run. Without a flag, the default recipe runs (every enabled check, parallel execution, table output).

A recipe's `CheckSelector` decides which checks make it into the run:

- `{ type: 'all', exclude?: [...] }` — every registered check minus the exclusions.
- `{ type: 'tags', include: [...], exclude?: [...] }` — only checks whose tag list overlaps `include`.
- `{ type: 'pattern', include: ['fit:no-*'], exclude?: [...] }` — slug glob match.
- `{ type: 'explicit', checkIds: [...] }` — exact id list.

The recipe service ([`packages/fitness/engine/src/recipes/service.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/recipes/service.ts)) projects the recipe's `config:` map (per-check parameter overrides) into module-level state so each check can read its slice via `getCheckConfig<T>(slug)`.

> **Where the example lands:** the default recipe runs. Selector is `{ type: 'all' }`. `no-console-log` makes the cut because it's not in the exclude list.

---

## Stage 5 — Target / scope resolution

Source: [`packages/targeting/src/resolve.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/targeting/src/resolve.ts), [`packages/fitness/engine/src/framework/path-matcher.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/framework/path-matcher.ts), [`packages/fitness/engine/src/framework/scope-resolver.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/framework/scope-resolver.ts).

For each check that survived selector filtering, the framework computes the file set it'll run against:

1. Read the check's declared `scope` (semantic — `{ languages: ['typescript'], concerns: ['backend'] }`) and/or `fileTypes` (extension-based — `['ts', 'tsx']`).
2. Resolve the scope to a target. If the project's `targets:` defines a `backend` target with explicit globs, those globs win. If no target matches, fall back to the language adapter's default extensions.
3. Apply per-check overrides from `targets.checkOverrides:` if present.
4. Combine with `globalExcludes:` from the config.
5. Run the resulting glob set against the project tree to produce the matched-file list.

The end result is one resolved file list per check. If no files match, the check is reported as `skipped` with reason `no matching files`.

> **Where the example lands:** `no-console-log` declares `scope: { languages: ['typescript'], concerns: ['backend'] }`. The `acme-api` project has a `backend` target with `services/api/**/*.ts`. After exclusions (`**/*.test.ts`, `node_modules/`, `dist/`), the file list resolves to 47 TypeScript files under `services/api/src/`.

---

## Stage 6 — Check execution

Source: [`packages/fitness/engine/src/framework/define-check.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/framework/define-check.ts), [`packages/fitness/engine/src/recipes/parallel-execution.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/recipes/parallel-execution.ts), [`packages/fitness/engine/src/recipes/sequential-execution.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/recipes/sequential-execution.ts).

The recipe's execution mode (`parallel` or `sequential`) decides the dispatcher. Each check runs inside an `ExecutionContext` carrying:

- `cwd` — the project root.
- `signal?` — an optional `AbortSignal`; long-running checks should call `checkAborted()` periodically to throw cooperatively.
- `checkAborted()` — throws `CheckAbortedError` if the signal has fired.
- `readFile(path)`, `fileExists(path)` — async file accessors.
- `matchFiles(patterns?, { ignore? }?)` — the resolved file list from Stage 5 (with optional in-context narrowing).
- `getMatcher()` — the per-check `PathMatcher` for ad-hoc filtering inside the analyzer.
- `checkId`, `checkSlug` — the check's identifiers.
- `log(msg)` — per-check logger sink (gated by `verbose`).
- `extractSnippet(...)` — helper for building violation excerpts.

The check's analysis mode determines what the framework does inside that context:

- **`analyze`** — for each file, read it, dispatch through the language adapter's content filter (strips comments and string literals per the check's `contentFilter` setting), then call `analyze(content, filePath)`. Each returned `CheckViolation` becomes a `Signal` via `createSignal()`.
- **`analyzeAll`** — hand the check a lazy `FileAccessor` over the file list and let it iterate however it wants. Suitable for cross-file rules.
- **`command`** — spawn the configured external binary, capture output, hand stdout/stderr to the check's parser.

The framework also applies inline ignore directives at this stage — `// @fitness-ignore-next-line <slug>`, `/* @fitness-ignore-file <slug> */` — by filtering the produced `Signal[]` before returning. The ignore-processing step records which directives were applied, so the renderer can show "ignored 3 violations" alongside "found 1 violation".

A timeout per check kicks in if `execution.timeout` is set. A timed-out check returns an error result; the recipe-level `stopOnFirstFailure` decides whether subsequent checks still run.

> **Where the example lands:** `no-console-log` is mode `analyze`. The framework reads each of the 47 TypeScript files, runs the typescript adapter's `strip-strings-and-comments` content filter (so `// console.log("debug")` and `"console.log"` don't match), then runs the regex `/console\.log\b/`. Two files match: `services/api/src/routes/health.ts:42` and `services/api/src/routes/orders.ts:118`. Two violations.

---

## Stage 7 — Signal aggregation

Source: [`packages/core/src/types/signal.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/core/src/types/signal.ts), [`packages/contracts/src/signal-envelope.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/contracts/src/signal-envelope.ts), [`packages/fitness/engine/src/framework/result-builder.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/framework/result-builder.ts).

Every check returns a `CheckResult` carrying `Signal[]`. The recipe service aggregates results into the run-level summary (totals, pass/fail counts, ignored counts), then assembles the `SignalEnvelope`.

The `SignalEnvelope` ([`packages/contracts/src/signal-envelope.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/contracts/src/signal-envelope.ts)) is the canonical artifact: `schemaVersion`, `tool`, `recipe?`, `runId`, `createdAt`, a `verdict` (score, passed, summary), a `units[]` sidecar (per-check ran/errored/timing facts), and the flat `signals[]` list. Anything that consumes the JSON output (CI, dashboard, the gate) reads the envelope (ADR-0011).

The aggregation pass is also where the score is computed — currently `Math.round((passedChecks / totalChecks) * 100)` (a simple pass-rate percent). The score is informational; the exit code is the gate.

> **Where the example lands:** the run produces a `SignalEnvelope` carrying ~80 units and ~30 signals, two of which are our `no-console-log` violations.

---

## Stage 8 — Render and exit

Source: [`packages/cli/src/ui/`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/cli/src/ui/), [`packages/fitness/engine/src/cli/fit.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/fitness/engine/src/cli/fit.ts), [`packages/cli/src/open-report.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/cli/src/open-report.ts).

The fitness Tool **returns its `SignalEnvelope`** via `CommandResult`; the CLI composition root dispatches by output mode (ADR-0011 — tools no longer render their own output):

- **`--json`** — the shared `formatSignalJson` formatter (the envelope *is* the JSON), via `cli.emitEnvelope`. No tables, no colors, no spinner. Pure data.
- **SARIF** (via `--gate-save`/`--gate-compare`/`--report-to`/`fit-baseline-export`) — the shared `formatSignalSarif` formatter, owned by the root (`cli.writeSarif` / `cli.deliverSignals`).
- **default (Ink)** — `cli.renderLive('fit', args)` mounts a live Ink view that transitions from spinner → results table → summary footer. The fitness Tool doesn't depend on Ink directly; it calls back through `ToolCliContext.renderLive`, which the CLI implements.

After rendering, the report auto-open runs if conditions allow: `--open` was passed (or the user opted into auto-open in their config), output isn't `--json`, and stdout is a TTY. The HTML report at `<project>/opensip-cli/.runtime/reports/latest.html` opens in the user's default browser (a single rolling file overwritten on each generation, not a per-run archive).

The exit code is set by the fitness Tool via `cli.setExitCode(code)`:

- `0` if the run completed successfully and no failing checks.
- `1` if any check failed (violations found).
- `2` if the run errored unrecoverably.

The CLI process exits when Node's event loop drains, which happens after Ink unmounts and the dashboard launcher returns.

> **Where the example lands:** stdout shows a table with two failed checks (`no-console-log: 2 violations`, plus one other failure from a different check). The exit code is `1`. The dashboard does not auto-open because the example invocation was non-interactive (CI). The session record is persisted as a row in `acme-api/opensip-cli/.runtime/datastore.sqlite` (tool `fit`, recipe `default`) via `SessionRepo`.

---

## Why this loop, and not a different one

A few alternative shapes were considered and rejected during the design. Worth knowing why they're not what you see:

- **No worker pool / no daemon.** Each `opensip fit` invocation is a fresh process. No state persists between runs (except cache files). This makes the loop trivial to reason about and trivial to retry; the cost is startup overhead, which is ~100ms for the kernel and amortizes against the actual check work.
- **No remote execution.** Checks run on the machine that invoked the binary. There's no "send work to the cloud". OpenSIP Cloud receives *results*, not executions — a check is executed locally, then its output is optionally posted.
- **No incremental mode by default.** The default behavior runs every check against every matching file. This is deterministic and easy to reason about. An incremental mode (run only checks affected by changed files) is feasible — the framework already supports `analyzeAll` checks that pre-filter their inputs — but it's opt-in and not on the default path.
- **No mutation.** Checks emit signals. They never edit your files. There is no `--fix` mode in the kernel. (A check's `fix.action` and `suggestion` fields *describe* what a fix would look like, but applying the fix is the user's job — or a future tool's.)

These are policy choices, not technical limits. They keep the loop comprehensible. A change to any of them is a kernel-level decision, not a tool-level one.

---

## What's next

The fitness loop is the spine. The next three docs in this section sharpen it:

- **[`02-tool-plugin-model.md`](/docs/opensip-cli/10-concepts/02-tool-plugin-model/)** — how the CLI doesn't know what `fit` does. Stage 1 in depth.
- **[`03-modular-monolith.md`](/docs/opensip-cli/10-concepts/03-modular-monolith/)** — the 29-package layer cake that makes Stages 1, 3, and 6 isolatable.
- **[`04-contract-surfaces.md`](/docs/opensip-cli/10-concepts/04-contract-surfaces/)** — the public edges: argv, Tool interface, plugin manifest, the `SignalEnvelope`.

When you want stage-by-stage detail, jump to [`../20-fit/`](/docs/opensip-cli/20-fit/) — each doc there expands one of these stages with full code paths.
