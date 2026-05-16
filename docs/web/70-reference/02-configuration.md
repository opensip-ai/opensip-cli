---
status: current
last_verified: 2026-05-15
title: "Configuration"
audience: [users, ci-integrators, plugin-authors]
purpose: "The opensip-tools.config.yml schema, every field, defaults, and where each is read."
source-files:
  - packages/fitness/engine/src/signalers/schema.ts
  - packages/core/src/config-resolution.ts
  - packages/cli/src/commands/init.ts
related-docs:
  - ../00-orientation/03-system-context.md
  - ../20-the-fit-loop/02-targets-and-scope.md
  - ../40-runtime/02-plugin-loader.md
---
# Configuration

opensip-tools reads two config files. One per project (committed); one per user (cross-project, gitignored).

| File | Scope | Holds |
|---|---|---|
| `<project>/opensip-tools.config.yml` | Project | Targets, plugins, fitness config, CLI defaults |
| `~/.opensip-tools/config.yml` | User | OpenSIP Cloud API key |

This doc walks the project file. The user file holds one secret and is documented inline below.

The Zod schema lives at [`packages/fitness/engine/src/signalers/schema.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.4/packages/fitness/engine/src/signalers/schema.ts).

---

## Top-level shape

```yaml
globalExcludes: []                          # readonly string[] — repo-wide glob excludes
targets: {}                                 # name → TargetDefinition (kebab-case keys)
checkOverrides: {}                          # check-slug → target-name(s)
fitness: {}                                 # FitnessConfig
simulation: {}                              # SimulationConfig
cli: {}                                     # CliDefaults
plugins: {}                                 # PluginsConfig (per-domain pin lists)
```

Every section is optional. A missing section becomes `{}` (the schema preprocesses YAML `null` → `{}` so empty sections still parse cleanly).

---

## `globalExcludes`

```yaml
globalExcludes:
  - '**/node_modules/**'
  - '**/dist/**'
  - '**/build/**'
  - '**/.next/**'
  - '**/coverage/**'
  - '**/__snapshots__/**'
  - '**/*.generated.ts'
```

Glob patterns excluded from every target's resolved file list. Replaces the earlier `.fitnessignore` file. Default: `[]` (no extra excludes — though the resolver always adds `node_modules`, `dist`, and `.git` internally as a safety net).

---

## `targets`

```yaml
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
```

Map of kebab-case target names to `TargetDefinition`s. Each definition:

| Field | Type | Required | Effect |
|---|---|---|---|
| `description` | string | yes | Human-readable description (≥ 1 char). |
| `include` | string[] | yes | Glob patterns (≥ 1 entry). |
| `exclude` | string[] | no | Globs subtracted from include. |
| `languages` | string[] | no | Semantic — matched against check `scope.languages`. |
| `concerns` | string[] | no | Semantic — matched against check `scope.concerns`. |
| `tags` | string[] | no | Free-form tags for grouping. |

Target names must match `^[a-z0-9]+(-[a-z0-9]+)*$` (kebab-case, no leading or trailing dashes).

See [`20-the-fit-loop/02-targets-and-scope.md`](/docs/opensip-tools/20-the-fit-loop/02-targets-and-scope/) for the resolution semantics.

---

## `checkOverrides`

```yaml
checkOverrides:
  no-console-log: backend
  no-todos: ['backend', 'frontend']
  complex-function: ['backend', 'pipelines']
```

Per-check target overrides. A check listed here runs against the named target(s) regardless of its declared scope. Use this when a third-party check's scope doesn't match your project's reality.

The value is either a single target name (string) or a list of names. Empty lists are not allowed — Zod requires `min(1)`.

---

## `fitness`

```yaml
fitness:
  defaultTarget: backend           # default target if a check has no scope
  maxParallel: 8                    # max concurrent checks
  timeout: 30000                    # per-check timeout in ms
  failOnErrors: 1                   # exit 1 if errors >= this count
  failOnWarnings: 0                 # exit 1 if warnings >= this count (0 = ignore warnings)
  disabledChecks:                   # slugs to disable
    - 'experimental-check'
  schedules: []                     # CronSchedule[] (cloud-side, currently unused locally)
```

| Field | Type | Default | Effect |
|---|---|---|---|
| `defaultTarget` | string | — | Target used when a check has no `scope`. |
| `maxParallel` | int ≥ 1 | `os.availableParallelism()` | Cap on parallel checks. |
| `timeout` | int ≥ 1000 | `30_000` | Per-check timeout in ms. |
| `failOnErrors` | int ≥ 0 | `1` | Threshold for `shouldFail` flag. 0 = never fail; 1 = fail on first error. |
| `failOnWarnings` | int ≥ 0 | `0` | Threshold for warnings. 0 = ignore warnings entirely. |
| `disabledChecks` | string[] | `[]` | Slugs to skip (a recipe's `includeDisabled` can opt back in). |
| `schedules` | object[] | `[]` | Reserved for cloud-side scheduled runs. |

The `failOnErrors` / `failOnWarnings` thresholds gate the exit code. By default a single error fails the run; setting `failOnErrors: 5` lets a run pass if it has fewer than 5 errors, useful during a debt-burn-down (though `--gate-compare` is the more principled alternative).

---

## `simulation`

```yaml
simulation:
  schedules: []
```

Currently only `schedules`, which is reserved for cloud-side scheduling. The simulation engine reads no other fields from this section; future versions may add `defaultRecipe`, `maxParallel`, etc.

---

## `cli`

CLI-wide defaults that act as flag pre-fills. Each project's `cli` section is equivalent to a config-loaded set of flags applied to every invocation.

```yaml
cli:
  recipe: default                  # --recipe default
  exclude: ['noisy-check']          # --exclude noisy-check
  verbose: false                    # default for --verbose
  json: false                       # default for --json
  reportTo: 'https://opensip.ai/api' # --report-to URL
  apiKey: '${OPENSIP_API_KEY}'      # --api-key (env-var interpolation)
  fileTypes: ['ts', 'py']           # restrict to these extensions
  ignore: []                        # extra --exclude entries
```

| Field | Type | Effect |
|---|---|---|
| `recipe` | string | Default recipe if `--recipe` not passed. |
| `exclude` | string[] | Default exclusions. |
| `verbose` | bool | Default for `--verbose`. |
| `json` | bool | Default for `--json`. |
| `reportTo` | URL | Default for `--report-to`. |
| `apiKey` | string | Default for `--api-key`. Supports env-var interpolation. |
| `fileTypes` | string[] | Restrict the run to these extensions. |
| `ignore` | string[] | Additional exclude patterns. |

CLI flags always override config — passing `--no-json` overrides a `cli.json: true` setting.

---

## `plugins`

```yaml
plugins:
  fit:
    - '@opensip-tools/checks-universal'
    - '@opensip-tools/checks-typescript'
    - '@opensip-tools/checks-python'
    - '@my-org/checks-internal'

  sim:
    - '@my-org/sim-scenarios'

  checkPackages:                  # explicit override — no auto-discovery
    - '@opensip-tools/checks-universal'
```

Project-pinned plugin lists. When present, **only** these packages are loaded — auto-discovery in `node_modules` is disabled for the listed domain. The `plugin add/remove/sync` commands manage these lists.

| Field | Effect |
|---|---|
| `plugins.fit` | Fitness check packs to load. |
| `plugins.sim` | Simulation scenario packs. |
| `plugins.checkPackages` | When set, **strict** — only these packages load, even excluding the bundled defaults. |
| `plugins.autoDiscoverChecks` | When `false`, disables `node_modules` walk for fit checks. Default `true`. Ignored when `checkPackages` is set. |

See [`40-runtime/02-plugin-loader.md`](/docs/opensip-tools/40-runtime/02-plugin-loader/) for the loader semantics.

---

## User-level config

```yaml
# ~/.opensip-tools/config.yml
apiKey: '<your-opensip-cloud-key>'
```

One field. The OpenSIP Cloud API key for `--report-to`. Cross-project — every project on the machine shares this key.

The `opensip-tools configure` command is the supported way to write this file. The `uninstall` command deletes the entire `~/.opensip-tools/` directory.

---

## A complete example

```yaml
# acme-api/opensip-tools.config.yml

globalExcludes:
  - '**/node_modules/**'
  - '**/dist/**'
  - '**/coverage/**'
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

  infra:
    description: AWS CDK
    include: ['infra/**/*.ts']
    exclude: ['infra/**/*.test.ts']
    languages: ['typescript']
    concerns: ['infrastructure']

checkOverrides:
  no-print-outside-pipelines: pipelines

fitness:
  maxParallel: 8
  timeout: 30000
  failOnErrors: 1
  disabledChecks:
    - 'experimental-check'

cli:
  recipe: default
  reportTo: 'https://opensip.ai/api'
  apiKey: '${OPENSIP_API_KEY}'

plugins:
  fit:
    - '@opensip-tools/checks-universal'
    - '@opensip-tools/checks-typescript'
    - '@opensip-tools/checks-python'
```

This is what a real project's config looks like. Add or remove entries as needed; every section is optional.

---

## What's next

- **[`03-json-output-schema.md`](/docs/opensip-tools/70-reference/03-json-output-schema/)** — the `CliOutput` shape that the runs emit.
- **[`../20-the-fit-loop/02-targets-and-scope.md`](/docs/opensip-tools/20-the-fit-loop/02-targets-and-scope/)** — how targets interact with check scopes.
- **[`../40-runtime/02-plugin-loader.md`](/docs/opensip-tools/40-runtime/02-plugin-loader/)** — how `plugins.<domain>:` is consumed.
