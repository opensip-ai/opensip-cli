---
status: current
last_verified: 2026-05-27
release: v2.0.x
title: "Configuration"
audience: [getting-started, ci-integrators, plugin-authors]
purpose: "The opensip-tools.config.yml schema, every field, defaults, and where each is read."
source-files:
  - packages/fitness/engine/src/signalers/schema.ts
  - packages/core/src/config-resolution.ts
  - packages/cli/src/commands/init.ts
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

The Zod schema lives at [`packages/fitness/engine/src/signalers/schema.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.1/packages/fitness/engine/src/signalers/schema.ts).

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
```

Every section is optional; a missing section becomes `{}`.

The validated schema (`SignalersConfigSchema`) covers `globalExcludes`, `targets`, `checkOverrides`, `fitness`, `simulation`, and `cli`. **`plugins:` and `dashboard:` are read out-of-band** by separate parsers ([`readProjectPluginsList`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.1/packages/core/src/plugins/discover.ts) and `extractDashboardEditor` in [`dashboard.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.1/packages/fitness/engine/src/cli/dashboard.ts)) so they can evolve independently of the fitness schema.

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

Map of kebab-case target names to `TargetDefinition`. See [targets and scope](/docs/opensip-tools/20-fit/02-targets-and-scope/) for resolution semantics.

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
| `schedules` | object[] | `[]` | Reserved for cloud-side scheduled runs. |

```yaml
fitness:
  maxParallel: 8
  timeout: 30000
  failOnErrors: 1
  disabledChecks: ['experimental-check']
```

Setting `failOnErrors: 5` lets a run pass with fewer than 5 errors — useful during debt burn-down, though `--gate-compare` is the more principled alternative.

## `simulation`

Currently only `schedules: []`, reserved for cloud-side scheduling. The simulation engine reads no other fields from this section; future versions may add `defaultRecipe`, `maxParallel`, etc.

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

Plugin lists and discovery preferences. **Read out-of-band** (not in the Zod schema). Three complementary discovery paths layer:

| Field | Effect |
|---|---|
| `plugins.fit` | Arbitrary-scope fitness packs pinned into `.runtime/plugins/fit/`. Managed by `plugin add/remove/sync`. |
| `plugins.sim` | Arbitrary-scope simulation packs pinned into `.runtime/plugins/sim/`. |
| `plugins.packageScopes` | Additional npm scopes to scan for `<scope>/checks-*` and `<scope>/scenarios-*` packages. `@opensip-tools` is always scanned. |
| `plugins.checkPackages` | When set, **strict** — only these packages load via the name-pattern path. Marker-based discovery still runs alongside. |
| `plugins.autoDiscoverChecks` | `false` disables the scope scan for fit checks. Default `true`. Ignored when `checkPackages` is set. |

```yaml
plugins:
  fit: ['@my-org/checks-internal']
  packageScopes: ['@acme']
```

**Marker-based discovery** — packages declaring `opensipTools.kind: "fit-pack"` or `"sim-pack"` in `package.json` — is always on and **not configurable from this file**. The marker is the publication-scope-independent path; this config governs only the name-pattern and explicit-pin paths. See [plugin loader](/docs/opensip-tools/80-implementation/02-plugin-loader/).

## `dashboard`

| Field | Type | Effect |
|---|---|---|
| `editor` | `'vscode' \| 'cursor'` | Renders an "Open in editor" deep link in the Code Paths Function Card (`vscode://file/...` or `cursor://file/...`). Absent → "Copy path" button. |

```yaml
dashboard:
  editor: vscode
```

Read out-of-band like `plugins:`.

---

## User-level config

```yaml
# ~/.opensip-tools/config.yml
apiKey: '<your-opensip-cloud-key>'
```

One field — the OpenSIP Cloud API key for `--report-to`. Cross-project. Use `opensip-tools configure` to write it; `opensip-tools uninstall --user` removes the entire `~/.opensip-tools/` directory.

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

- [**JSON output schema**](/docs/opensip-tools/70-reference/04-json-output-schema/) — the `CliOutput` shape that runs emit.
- [**Targets and scope**](/docs/opensip-tools/20-fit/02-targets-and-scope/) — how targets interact with check scopes.
- [**Plugin loader**](/docs/opensip-tools/80-implementation/02-plugin-loader/) — how `plugins.<domain>:` is consumed.
