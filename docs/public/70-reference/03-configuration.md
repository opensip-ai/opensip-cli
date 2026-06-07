---
status: current
last_verified: 2026-06-04
release: v2.7.0
title: "Configuration"
audience: [getting-started, ci-integrators, plugin-authors]
purpose: "The opensip-tools.config.yml schema, every field, defaults, and where each is read."
source-files:
  - packages/fitness/engine/src/signalers/schema.ts
  - packages/core/src/config-resolution.ts
  - packages/cli/src/commands/init.ts
  - packages/graph/engine/src/cli/graph-config.ts
  - packages/graph/engine/src/types.ts
related-docs:
  - ../00-start/06-system-context.md
  - ../20-fit/02-targets-and-scope.md
  - ../80-implementation/02-plugin-loader.md
---
# Configuration

opensip-tools reads two config files:

| File | Scope | Holds |
|---|---|---|
| `<project>/opensip-tools.config.yml` | Project (committed) | Targets, plugins, fitness config, CLI defaults |
| `~/.opensip-tools/config.yml` | User (gitignored, cross-project) | OpenSIP Cloud API key |

The Zod schema lives at [`packages/fitness/engine/src/signalers/schema.ts`](../../../packages/fitness/engine/src/signalers/schema.ts).

## Top-level shape

```yaml
globalExcludes: []        # readonly string[] — repo-wide glob excludes
targets: {}               # name → TargetDefinition (kebab-case keys)
checkOverrides: {}        # check-slug → target-name(s)
fitness: {}               # FitnessConfig
simulation: {}            # SimulationConfig
cli: {}                   # CliDefaults
plugins: {}               # per-domain pin lists (read out-of-band — see below)
dashboard: {}             # dashboard.editor (read out-of-band — see below)
graph: {}                 # graph rule knobs (read out-of-band — see below)
```

Every section is optional; a missing section becomes `{}`.

The validated schema (`SignalersConfigSchema`) covers `globalExcludes`, `targets`, `checkOverrides`, `fitness`, `simulation`, and `cli`. **`plugins:`, `dashboard:`, and `graph:` are read out-of-band** by separate parsers ([`readProjectPluginsList`](../../../packages/core/src/plugins/discover.ts), `extractDashboardEditor` in [`dashboard.ts`](../../../packages/fitness/engine/src/cli/dashboard.ts), and `loadGraphConfig` in [`graph-config.ts`](../../../packages/graph/engine/src/cli/graph-config.ts)) so each can evolve independently of the fitness schema. The `graph:` loader is deliberately permissive — a missing config, malformed YAML, or absent `graph:` key all collapse to `{}`, and every rule then falls back to its in-rule default.

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

Map of kebab-case target names to `TargetDefinition`. See [targets and scope](../20-fit/02-targets-and-scope.md) for resolution semantics.

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
| `failOnErrors` | int ≥ 0 | `1` | Threshold for `shouldFail`. `0` = never fail; `1` = fail on first error. |
| `failOnWarnings` | int ≥ 0 | `0` | Threshold for warnings. `0` = ignore warnings entirely. |
| `disabledChecks` | string[] | `[]` | Slugs to skip (a recipe's `includeDisabled` can opt back in). |
| `schedules` | object[] | `[]` | Reserved for cloud-side scheduled runs. **Ignored locally** — the CLI config schema does not parse, validate, or act on this field (unknown keys are silently dropped). No local scheduler exists. |

```yaml
fitness:
  maxParallel: 8
  timeout: 30000
  failOnErrors: 1
  disabledChecks: ['experimental-check']
```

Setting `failOnErrors: 5` lets a run pass with fewer than 5 errors — useful during debt burn-down, though `--gate-compare` is the more principled alternative.

## `simulation`

Currently only `schedules: []`, reserved for cloud-side scheduling — and **ignored by the local CLI** (not parsed, validated, or acted on; there is no local scheduler). The simulation engine reads no other fields from this section; future versions may add `defaultRecipe`, `maxParallel`, etc.

## `cli`

CLI-wide defaults that act as flag pre-fills. Each project's `cli` section is equivalent to a config-loaded set of flags applied to every invocation.

| Field | Type | Effect |
|---|---|---|
| `recipe` | string | Default recipe if `--recipe` not passed. |
| `exclude` | string[] | Default exclusions. |
| `verbose` / `json` | bool | Defaults for `--verbose` / `--json`. |
| `reportTo` | URL | Default for `--report-to`. |
| `apiKey` | string | Literal API key. **No `${VAR}` interpolation** — use the env-var or user-level config instead. |
| `fileTypes` | string[] | Restrict the run to these extensions. |
| `ignore` | string[] | Additional exclude patterns. |
| `ui.banner` | `'mini' \| 'lg' \| 'md' \| 'sm'` | Banner art above each command. Default `mini` — a compact boxed card (amber cup + version + tagline + `www.opensip.ai` + project path). Set `lg`/`md`/`sm` for the full ASCII wordmark. **No CLI flag** — persistent preference. |

```yaml
cli:
  recipe: default
  reportTo: 'https://opensip.ai/api'
  ui:
    banner: mini   # mini | lg | md | sm
```

**API key resolution precedence**: `--api-key` flag > `cli.apiKey` > `OPENSIP_API_KEY` env > `~/.opensip-tools/config.yml`. Project-level wins over the env var, so a committed-into-repo key takes effect even if the env var is set.

CLI flags always override config — `--no-json` overrides a `cli.json: true` setting.

## `plugins`

Plugin lists and discovery preferences. **Read out-of-band** (not in the Zod schema). Marker discovery, scoped sim discovery, and explicit/project-pinned package lists layer:

| Field | Effect |
|---|---|
| `plugins.fit` | Arbitrary-scope fitness packs pinned into `.runtime/plugins/fit/`. Managed by `plugin add/remove/sync`. |
| `plugins.sim` | Arbitrary-scope simulation packs pinned into `.runtime/plugins/sim/`. |
| `plugins.packageScopes` | Additional npm scopes to scan for `<scope>/scenarios-*` simulation packages. `@opensip-tools` is always scanned. |
| `plugins.checkPackages` | Exact fitness package names to load from project `node_modules` in addition to marker-based `fit-pack` discovery. |
| `plugins.scenarioPackages` | Exact simulation package names to load from project `node_modules`; when set, replaces the `<scope>/scenarios-*` scan. Marker-based `sim-pack` discovery still runs alongside. |
| `plugins.autoDiscoverScenarios` | `false` disables the `<scope>/scenarios-*` scan for sim. Default `true`. Ignored when `scenarioPackages` is set. |

```yaml
plugins:
  fit: ['@my-org/checks-internal']
  packageScopes: ['@acme']
```

**Marker-based discovery** — packages declaring `opensipTools.kind: "fit-pack"` or `"sim-pack"` in `package.json` — is always on and **not configurable from this file**. The marker is the publication-scope-independent path; this config governs only explicit package lists and the sim `scenarios-*` scope scan. See [plugin loader](../80-implementation/02-plugin-loader.md).

## `dashboard`

| Field | Type | Effect |
|---|---|---|
| `editor` | `'vscode' \| 'cursor'` | Renders an "Open in editor" deep link in the Code Paths Function Card (`vscode://file/...` or `cursor://file/...`). Absent → "Copy path" button. |

```yaml
dashboard:
  editor: vscode
```

Read out-of-band like `plugins:`.

## `graph`

Per-rule knobs for the `graph` tool. Read out-of-band by `loadGraphConfig` ([`graph-config.ts`](../../../packages/graph/engine/src/cli/graph-config.ts)), not by the fitness Zod schema. Every field is optional; an omitted field uses the rule's in-rule default. The loader projects only the field types — it does not strictly validate, so a malformed value is dropped (the rule then uses its default).

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
| `entryPointHashes` | string[] | — | Override the inferred entry-point list with explicit body hashes. |
| `severityOverrides` | map (rule-slug → `'error' \| 'warning'`) | `{}` | Per-rule severity clamp. An applied opt-in: a listed rule's emitted signals are clamped to the named severity. Only `'error'` / `'warning'` values are accepted; other values are dropped. |

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
# ~/.opensip-tools/config.yml
apiKey: '<your-opensip-cloud-key>'
cloud:
  sync: false               # optional: machine-wide opt-out of cloud signal sync
  endpoint: https://...     # optional: https override of the built-in cloud URL
```

Cross-project, flat keys. `apiKey` is the OpenSIP Cloud key (for `--report-to`
and cloud signal sync). The optional `cloud` block is the machine-wide
privacy control: `sync: false` disables cloud signal sync for every project run
from this account (it layers over each project's `cli.cloud:`; a `false` in
either place wins). Use `opensip-tools configure` to write the key;
`opensip-tools uninstall --user` removes the entire `~/.opensip-tools/` directory.

---

## A complete example

```yaml
# acme-api/opensip-tools.config.yml

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
  disabledChecks: ['experimental-check']

cli:
  recipe: default
  reportTo: 'https://opensip.ai/api'
  # apiKey is read from OPENSIP_API_KEY env or ~/.opensip-tools/config.yml — avoid committing a literal key.

plugins:
  fit:
    - '@opensip-tools/checks-universal'
    - '@opensip-tools/checks-typescript'
```

Every section is optional; add or remove as needed.

---

## What's next

- [**JSON output schema**](./04-json-output-schema.md) — the `SignalEnvelope` shape that runs emit.
- [**Targets and scope**](../20-fit/02-targets-and-scope.md) — how targets interact with check scopes.
- [**Plugin loader**](../80-implementation/02-plugin-loader.md) — how `plugins.<domain>:` is consumed.
