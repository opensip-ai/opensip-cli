---
status: current
last_verified: 2026-06-11
release: v0.1.1
title: "Configuration"
audience: [getting-started, ci-integrators, plugin-authors]
purpose: "The opensip-cli.config.yml schema, every field, defaults, and where each is read."
source-files:
  - packages/config/src/composer.ts
  - packages/cli/src/bootstrap/config-and-capabilities.ts
  - packages/fitness/engine/src/config/fitness-config-schema.ts
  - packages/simulation/engine/src/cli/sim-config-schema.ts
  - packages/graph/engine/src/cli/graph-config-schema.ts
  - packages/config/src/document/global-config.ts
  - packages/cli/src/commands/init.ts
related-docs:
  - ../00-start/06-system-context.md
  - ../20-fit/02-targets-and-scope.md
  - ../80-implementation/02-plugin-loader.md
---
# Configuration

opensip-cli reads two config files:

| File | Scope | Holds |
|---|---|---|
| `<project>/opensip-cli.config.yml` | Project (committed) | Targets, plugins, fitness config, CLI defaults |
| `~/.opensip-cli/config.yml` | User (gitignored, cross-project) | OpenSIP Cloud API key and machine-wide cloud-sync controls |

Each tool contributes a Zod schema for its own top-level namespace (`fitness:`, `simulation:`, `graph:`); the host **composes** them into one strict whole-document schema ([`packages/config/src/composer.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.1/packages/config/src/composer.ts), ADR-0023) and validates the entire file **before dispatch** ([`config-and-capabilities.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.1/packages/cli/src/bootstrap/config-and-capabilities.ts)). Each known namespace is **strict**: an unknown key inside it (a typo) is **rejected** with a `CONFIGURATION_ERROR`, not silently dropped. Unclaimed *top-level* keys are tolerated (the catchall seam), so a key no tool owns passes through.

## Top-level shape

```yaml
schemaVersion: 1            # project config schema version
globalExcludes: []        # readonly string[] — repo-wide glob excludes
targets: {}               # name → TargetDefinition (kebab-case keys)
checkOverrides: {}        # check-slug → target-name(s)
fitness: {}               # FitnessConfig
simulation: {}            # SimulationConfig
cli: {}                   # CliDefaults
plugins: {}               # per-domain pin lists
dashboard: {}             # dashboard.editor
graph: {}                 # graph rule knobs (tool-contributed namespace)
```

Every section is optional; a missing section becomes `{}`.

The composed strict schema covers the host-owned blocks (`schemaVersion`, `globalExcludes`, `targets`, `checkOverrides`, `cli`, `dashboard`, `plugins`) plus each tool's namespace (`fitness:`, `simulation:`, `graph:` — each contributed by its owning tool). **The whole document validates strict before dispatch**: a typo inside `graph:` (e.g. `minCrossPackageDuplicatePackges`) or inside `fitness:` is rejected with a `CONFIGURATION_ERROR`, not silently dropped. The `graph:` block is no longer read out-of-band — it is a tool-contributed namespace validated against [`graph-config-schema.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.1/packages/graph/engine/src/cli/graph-config-schema.ts) like every other.

`schemaVersion` defaults to `1`. The pre-action hook reads it before the strict loader runs; if a project config declares a schema newer than the installed CLI understands, the CLI exits 2 with an "upgrade your CLI" message rather than misreading the file.

---

## `globalExcludes`

Glob patterns excluded from every target's resolved file list. Replaces the earlier `.fitnessignore` file. Default `[]` — though the resolver always adds `node_modules`, `dist`, and `.git` internally as a safety net.

```yaml
globalExcludes:
  - '**/node_modules/**'
  - '**/dist/**'
  - '**/*.generated.ts'
```

## `targets`

Map of kebab-case target names to `TargetDefinition`. See [targets and scope](/docs/opensip-cli/20-fit/02-targets-and-scope/) for resolution semantics.

```yaml
targets:
  backend:
    description: TypeScript REST API
    include: ['services/api/**/*.ts']
    exclude: ['**/*.test.ts']
    languages: ['typescript']
    concerns: ['backend', 'server']
```

| Field | Type | Required | Effect |
|---|---|---|---|
| `description` | string | yes | Human-readable description (≥ 1 char). |
| `include` | string[] | yes | Glob patterns (≥ 1 entry). |
| `exclude` | string[] | no | Globs subtracted from include. |
| `languages` | string[] | no | Matched against check `scope.languages`. |
| `concerns` | string[] | no | Matched against check `scope.concerns`. |
| `tags` | string[] | no | Free-form tags for grouping. |

Target names must match `^[a-z0-9]+(-[a-z0-9]+)*$` (kebab-case).

## `checkOverrides`

Per-check target overrides. A listed check runs against the named target(s) regardless of its declared scope — use when a third-party check's scope doesn't match your project's reality.

```yaml
checkOverrides:
  no-console-log: backend
  no-todos: ['backend', 'frontend']
```

Value is a single target name (string) or a non-empty list.

## `fitness`

| Field | Type | Default | Effect |
|---|---|---|---|
| `defaultTarget` | string | — | Target used when a check has no `scope`. |
| `maxParallel` | int ≥ 1 | runner default (CPU-derived) | Cap on parallel checks. |
| `timeout` | int ≥ 1000 | runner default | Per-check timeout in ms. |
| `failOnErrors` | int ≥ 0 | `1` | Error threshold for the run verdict (the host derives the exit code from `envelope.verdict`, ADR-0035). `0` = never fail; `1` = fail on first error. |
| `failOnWarnings` | int ≥ 0 | `0` | Threshold for warnings. `0` = ignore warnings entirely. |
| `disabledChecks` | string[] | `[]` | Slugs to skip (a recipe's `includeDisabled` can opt back in). |
| `recipe` | string | — | Default recipe for `fit` when `--recipe` is not passed (ADR-0022). Tool-scoped — distinct from `graph.recipe` / `simulation.recipe`. An unknown name here falls back to the built-in `default` recipe with a warning; an explicit `--recipe` typo still hard-fails. |

```yaml
fitness:
  maxParallel: 8
  timeout: 30000
  failOnErrors: 1
  disabledChecks: ['legacy-check']
  recipe: backend            # default recipe for `fit` (tool-scoped, ADR-0022)
```

Setting `failOnErrors: 5` lets a run pass with fewer than 5 errors — useful during debt burn-down, though `--gate-compare` is the more principled alternative.

> **Roadmap note — `schedules`.** A `fitness.schedules` key for cloud-side scheduled runs is not part of the current schema. The `fitness:` namespace validates **strict**, so a `schedules` key is **rejected** with a `CONFIGURATION_ERROR` by the current CLI — it is not silently ignored. There is no local scheduler. (Historical docs described this field as silently dropped; under strict composed validation it is now a hard error.)

## `simulation`

| Field | Type | Default | Effect |
|---|---|---|---|
| `recipe` | string | — | Default recipe for `sim` when `--recipe` is not passed (ADR-0022). Tool-scoped — distinct from `fitness.recipe` / `graph.recipe`. An unknown name here falls back to the built-in `default` recipe with a warning; an explicit `--recipe` typo still hard-fails. |

```yaml
simulation:
  recipe: default            # default recipe for `sim` (tool-scoped, ADR-0022)
```

> **Roadmap note — `schedules`.** A `simulation.schedules` key for cloud-side scheduling is not part of the current schema. The `simulation:` namespace validates **strict**, so a `schedules` key is **rejected** with a `CONFIGURATION_ERROR` by the current CLI. There is no local scheduler.

## `cli`

CLI-wide defaults that act as flag pre-fills. Each project's `cli` section is equivalent to a config-loaded set of flags applied to every invocation.

Recipe defaults are tool-scoped (ADR-0022), so set `fitness.recipe`,
`graph.recipe`, or `simulation.recipe`. The `cli` namespace is strict; unknown
config fields are rejected.

| Field | Type | Effect |
|---|---|---|
| `exclude` | string[] | Default exclusions. |
| `verbose` / `json` | bool | Defaults for `--verbose` / `--json`. |
| `debug` | bool | Default for `--debug`. |
| `reportTo` | URL | Default for `--report-to`. |
| `apiKey` | string | Literal API key. **No `${VAR}` interpolation** — use the env-var or user-level config instead. |
| `fileTypes` | string[] | Restrict the run to these extensions. |
| `ignore` | string[] | Additional exclude patterns. |
| `ui.banner` | `'mini' \| 'lg' \| 'md' \| 'sm'` | Banner art above each command. Default `mini` — a compact boxed card (amber cup + version + tagline + `www.opensip.ai` + project path). Set `lg`/`md`/`sm` for the full ASCII wordmark. **No CLI flag** — persistent preference. |
| `cloud.sync` | bool | Project-level opt-out for automatic OpenSIP Cloud signal sync. `false` disables sync even when a user-level config enables it. |
| `cloud.endpoint` | URL | HTTPS override for the built-in OpenSIP Cloud endpoint. User-level endpoint takes precedence when both are set. |

```yaml
cli:
  reportTo: 'https://opensip.ai/api'
  ui:
    banner: mini   # mini | lg | md | sm
  cloud:
    sync: false    # optional project-level cloud signal-sync opt-out
# Recipe defaults are tool-scoped (ADR-0022) — set them per tool:
fitness:
  recipe: backend
graph:
  recipe: default
```

**API key resolution precedence**: `--api-key` flag > `cli.apiKey` > `OPENSIP_API_KEY` env > `~/.opensip-cli/config.yml`. Prefer the flag, env var, or user-level config for real secrets; `cli.apiKey` exists for controlled environments and still wins over the env var if set.

CLI flags always override config — `--no-json` overrides a `cli.json: true` setting.

## `plugins`

Plugin lists and discovery preferences. Scoped name-pattern discovery, explicit/project-pinned package lists, and project-local files layer. The `plugins:` block is a strict host-owned config namespace: unknown keys or wrong value types are rejected during the pre-dispatch config validation pass.

| Field | Effect |
|---|---|
| `plugins.fit` | Arbitrary-scope fitness packs pinned into `.runtime/plugins/fit/`. Managed by `plugin add/remove/sync`. |
| `plugins.sim` | Arbitrary-scope simulation packs pinned into `.runtime/plugins/sim/`. |
| `plugins.packageScopes` | Additional npm scopes to scan for `<scope>/scenarios-*` simulation packages. `@opensip-cli` is always scanned. |
| `plugins.checkPackages` | Exact fitness package names to load from project `node_modules`. |
| `plugins.scenarioPackages` | Exact simulation package names to load from project `node_modules`; when set, replaces the `<scope>/scenarios-*` name-pattern scan. |
| `plugins.autoDiscoverScenarios` | `false` disables the `<scope>/scenarios-*` name-pattern scan for sim. Default `true`. Ignored when `scenarioPackages` is set. |
| `plugins.graphAdapters` | Exact graph adapter package names to load from project `node_modules`; when set, replaces marker auto-discovery. |
| `plugins.autoDiscoverGraphAdapters` | `false` disables graph-adapter marker auto-discovery. Default `true`. Ignored when `graphAdapters` is set. |

```yaml
plugins:
  fit: ['@my-org/checks-internal']
  packageScopes: ['@acme']
  graphAdapters: ['@my-org/graph-cpp']
```

**Sim-pack discovery is by name-pattern** (ADR-0029): the simulation tool's manifest declares a `name-pattern` discovery mode (`prefix: "scenarios-"`, default scope `@opensip-cli`), so any installed `<scope>/scenarios-*` package is discovered automatically. There is **no** `opensipTools.kind: "sim-pack"` marker — sim marker discovery was retired in ADR-0029. The three layers that contribute scenario packs are: the `<scope>/scenarios-*` name-pattern scan (governed by `packageScopes` / `autoDiscoverScenarios`), explicit `scenarioPackages` pins, and project-local scenario files under `opensip-cli/sim/scenarios/`. See [plugin loader](/docs/opensip-cli/80-implementation/02-plugin-loader/).

## `dashboard`

| Field | Type | Effect |
|---|---|---|
| `editor` | `'vscode' \| 'cursor'` | Renders an "Open in editor" deep link in the Code Paths Function Card (`vscode://file/...` or `cursor://file/...`). Absent → "Copy path" button. |

```yaml
dashboard:
  editor: vscode
```

Validated by the project-config schema and read by the dashboard data path. Unknown dashboard fields are rejected by the strict loader.

## `graph`

Per-rule knobs for the `graph` tool. The `graph:` block is a tool-contributed namespace validated against [`graph-config-schema.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.1/packages/graph/engine/src/cli/graph-config-schema.ts) as part of the composed strict whole-document schema (ADR-0023) — **before dispatch**. Every field is optional; an omitted field uses the rule's in-rule default. A typo'd key (e.g. `minCrossPackageDuplicatePackges`) or a malformed value (e.g. a string where a number is expected, or a `severityOverrides` value outside `'error'`/`'warning'`) is **rejected** with a `CONFIGURATION_ERROR`, not silently dropped.

### Duplicated-function-body (`graph:duplicated-function-body`)

| Field | Type | Default | Effect |
|---|---|---|---|
| `minDuplicateBodyLines` | number | `5` | Minimum lines for a duplicated-function-body match. |
| `minDuplicateBodySize` | number | `200` | Minimum normalized body size (chars) for a per-instance match. Filters trivial pass-through wrappers. |
| `minCrossPackageDuplicatePackages` | number | `3` | Minimum DISTINCT packages a body hash must appear in to trigger the aggregate cross-package duplication signal (suppressing the per-instance signals for that hash). |
| `minCrossPackageDuplicateBodySize` | number | `80` | Normalized-body-size floor (chars) for the aggregate cross-package path. Deliberately lighter than `minDuplicateBodySize`; no line floor. |

### Orphan detection (`graph:orphan-subtree`)

| Field | Type | Default | Effect |
|---|---|---|---|
| `flagExportedOrphans` | bool | `false` | Allow flagging exported, zero-caller functions as orphans. Enable only for repos with trustworthy cross-package call resolution. |
| `flagTestOrphans` | bool | `false` | Allow flagging functions declared in test files as orphans (otherwise left to `graph:test-only-reachable`). |

### Structural-rule thresholds

Two-band (warn / error) thresholds for the structural rules. A value between the warn and error band emits a `medium` signal; above the error band emits `high`.

| Field | Rule | Type | Default | Effect |
|---|---|---|---|---|
| `largeFunctionWarnLines` | `graph:large-function` | number | `300` | Body-line count above which a function emits a `medium` signal. (`bodyLines` is the physical span — incl. comments/blanks — so the gate default is calibrated higher than the dashboard's "~80 worth questioning" heuristic.) |
| `largeFunctionErrorLines` | `graph:large-function` | number | `500` | Body-line count above which a function emits a `high` signal. |
| `wideFunctionWarnParams` | `graph:wide-function` | number | `5` | Parameter count above which a function emits a `medium` signal. |
| `wideFunctionErrorParams` | `graph:wide-function` | number | `7` | Parameter count above which a function emits a `high` signal. |
| `highBlastWarnThreshold` | `graph:high-blast-untested` | number | `75` | Minimum `blast.score` (an absolute count, never a percentile) for an untested function to emit a `medium` signal. |
| `highBlastErrorThreshold` | `graph:high-blast-untested` | number | `150` | Minimum `blast.score` for an untested function to emit a `high` signal. |
| `cycleMinSize` | `graph:cycle` | number | `3` | Minimum SCC size that emits a `medium` signal. A package-crossing cycle always wins `high`. |
| `cycleSize2Severity` | `graph:cycle` | `'off' \| 'low'` | `'off'` | Posture for the size-2 band (a 2-member cycle, often legitimate mutual recursion). `'off'` → no signal; `'low'` → a `low` signal. |

### Other knobs

| Field | Type | Default | Effect |
|---|---|---|---|
| `recipe` | string | — | Default recipe for `graph` when `--recipe` is not passed (ADR-0022). Tool-scoped — distinct from `fitness.recipe` / `simulation.recipe`. An unknown name here falls back to the built-in `default` recipe with a warning; an explicit `--recipe` typo still hard-fails. |
| `entryPointHashes` | string[] | — | Override the inferred entry-point list with explicit body hashes. |
| `severityOverrides` | map (rule-slug → `'error' \| 'warning'`) | `{}` | Per-rule severity clamp. An applied opt-in: a listed rule's emitted signals are clamped to the named severity. Only `'error'` / `'warning'` values are accepted; any other value is **rejected** by strict validation with a `CONFIGURATION_ERROR`. |
| `partitionStrategy` | `'directory-depth'` \| `'file-count-chunks'` \| `'hybrid'` | `'hybrid'` | How a flat (non-workspaces) repo is partitioned into synthetic shards for the sharded build (ADR-0045). Env override: `OPENSIP_GRAPH_PARTITION_STRATEGY`. Unknown values are **rejected** by strict validation. Changing the strategy changes shard identity, so the first run after a switch is a cold (uncached) build. |

```yaml
graph:
  minDuplicateBodyLines: 8
  largeFunctionWarnLines: 100
  largeFunctionErrorLines: 200
  wideFunctionErrorParams: 8
  highBlastErrorThreshold: 30
  cycleSize2Severity: low
  severityOverrides:
    graph:orphan-subtree: warning
```

---

## User-level config

```yaml
# ~/.opensip-cli/config.yml
apiKey: '<your-opensip-cloud-key>'
cloud:
  sync: false               # optional: machine-wide opt-out of cloud signal sync
  endpoint: https://...     # optional: https override of the built-in cloud URL
```

Cross-project, flat keys. `apiKey` is the OpenSIP Cloud key (for `--report-to`
and cloud signal sync). The optional `cloud` block is the machine-wide
privacy control: `sync: false` disables cloud signal sync for every project run
from this account (it layers over each project's `cli.cloud:`; a `false` in
either place wins). Use `opensip configure` to write the key;
`opensip uninstall --user` removes the entire `~/.opensip-cli/` directory.

---

## A complete example

```yaml
# acme-api/opensip-cli.config.yml

schemaVersion: 1

globalExcludes:
  - '**/dist/**'
  - '**/*.generated.ts'

targets:
  backend:
    description: TypeScript REST API
    include: ['services/api/**/*.ts']
    exclude: ['**/*.test.ts']
    languages: ['typescript']
    concerns: ['backend', 'server']
  pipelines:
    description: Python ETL jobs
    include: ['pipelines/etl/**/*.py']
    exclude: ['**/*_test.py']
    languages: ['python']
    concerns: ['data-pipeline']

fitness:
  maxParallel: 8
  failOnErrors: 1
  disabledChecks: ['legacy-check']
  recipe: backend            # default recipe for `fit` (tool-scoped, ADR-0022)

graph:
  recipe: default            # default recipe for `graph` (tool-scoped, ADR-0022)

cli:
  reportTo: 'https://opensip.ai/api'
  # apiKey is read from OPENSIP_API_KEY env or ~/.opensip-cli/config.yml — avoid committing a literal key.

plugins:
  fit:
    - '@opensip-cli/checks-universal'
    - '@opensip-cli/checks-typescript'
```

Every section is optional; add or remove as needed.

---

## What's next

- [**JSON output schema**](/docs/opensip-cli/70-reference/04-json-output-schema/) — the `SignalEnvelope` shape that runs emit.
- [**Targets and scope**](/docs/opensip-cli/20-fit/02-targets-and-scope/) — how targets interact with check scopes.
- [**Plugin loader**](/docs/opensip-cli/80-implementation/02-plugin-loader/) — how `plugins.<domain>:` is consumed.
