---
status: current
last_verified: 2026-05-26
release: v1.3.x
title: "Plugin authoring"
audience: [plugin-authors]
purpose: "Write your own check, recipe, scenario, check pack, or full Tool plugin. End-to-end."
source-files:
  - packages/core/src/tools/types.ts
  - packages/core/src/plugins/types.ts
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/fitness/engine/src/recipes/types.ts
  - packages/simulation/engine/src/index.ts
related-docs:
  - ../00-orientation/02-vocabulary.md
  - ../10-mental-model/02-tool-plugin-model.md
  - ../20-the-fit-loop/01-recipes-and-checks.md
  - ../60-subsystems/02-check-packs.md
  - ../60-subsystems/01-language-adapters.md
---
# Plugin authoring

You can extend opensip-tools five ways, listed in increasing order of effort and capability:

1. **Add a project-local check** — drop a `.mjs` file under `<project>/opensip-tools/fit/checks/`.
2. **Add a project-local recipe** — drop a `.mjs` file under `<project>/opensip-tools/fit/recipes/`.
3. **Add a project-local sim scenario** — under `<project>/opensip-tools/sim/scenarios/`.
4. **Ship a check pack or sim pack** — npm package declaring `opensipTools.kind: "fit-pack"` (or `"sim-pack"`) in `package.json`. Free choice of npm scope and name.
5. **Ship a full Tool** — npm package with `opensipTools.kind === 'tool'`.

This doc walks each shape with full code.

---

## 1. A project-local check

The fastest path. Drop a file, it's loaded next run. No publishing, no install.

```js
// <project>/opensip-tools/fit/checks/no-fixme.mjs
import { defineCheck } from '@opensip-tools/fitness';

export default defineCheck({
  id: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  slug: 'no-fixme-comments',
  description: 'No FIXME comments left in source',
  tags: ['quality', 'documentation'],
  scope: { languages: ['typescript'], concerns: [] },
  contentFilter: 'raw',  // we WANT to see the comment text
  analyze(content, filePath) {
    const violations = [];
    content.split('\n').forEach((line, idx) => {
      if (/\bFIXME\b/.test(line)) {
        violations.push({
          line: idx + 1,
          message: `FIXME comment found: ${line.trim()}`,
          severity: 'warning',
        });
      }
    });
    return violations;
  },
});
```

Run `opensip-tools fit-list` and your check appears. Run `opensip-tools fit` and it executes against every TypeScript file in your matched targets.

The id must be a valid UUID v4. Generate one with `node -e "console.log(crypto.randomUUID())"` or any UUID generator. It only needs to be stable across renames — no central registry.

**The five fields you'll touch most:**

| Field | When to set |
|---|---|
| `slug` | Always. Kebab-case, human-readable. |
| `description` | Always. One-line summary shown in `--list`. |
| `tags` | Always. At least one tag — recipes select by tag. |
| `scope` | Almost always. Tells the framework what kind of code this check is for. |
| `contentFilter` | Set to `'strip-strings-and-comments'` for regex-shaped checks; default `'raw'` is for text scanners. |

---

## 2. A project-local recipe

```js
// <project>/opensip-tools/fit/recipes/quick-smoke.mjs
import { defineRecipe } from '@opensip-tools/fitness';

export default defineRecipe({
  name: 'quick-smoke',
  displayName: 'Quick smoke',
  description: 'Fast PR feedback — universal checks only',
  checks: { type: 'tags', include: ['universal'] },
  execution: { mode: 'parallel', timeout: 10_000, stopOnFirstFailure: false },
  reporting: { format: 'table' },
});
```

`opensip-tools fit-recipes` lists it. `opensip-tools fit --recipe quick-smoke` runs it.

The four selectors: `{ type: 'all' }`, `{ type: 'tags', include: [...] }`, `{ type: 'pattern', include: [...] }`, `{ type: 'explicit', checkIds: [...] }`. See [`20-the-fit-loop/01-recipes-and-checks.md`](../20-the-fit-loop/01-recipes-and-checks.md).

To override check parameters, add a `config:` map to the selector:

```js
checks: {
  type: 'all',
  config: {
    'complex-function': { maxComplexity: 15 },
  },
},
```

The check reads its slice via `getCheckConfig<T>('complex-function')`.

---

## 3. A project-local sim scenario

```js
// <project>/opensip-tools/sim/scenarios/checkout-burst.mjs
import { defineLoadScenario } from '@opensip-tools/simulation';

export default defineLoadScenario({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'checkout-burst',
  description: 'Sustain 200 RPS checkout traffic for 30s',
  tags: ['load', 'checkout'],
  duration: { value: 30, unit: 'seconds' },
  rampUp: { value: 5, unit: 'seconds' },
  targetRps: 200,
  personas: [
    {
      name: 'shopper',
      weight: 1.0,
      action: async () => {
        await fetch('http://localhost:3000/checkout', { method: 'POST', body: '{}' });
      },
    },
  ],
  assertions: [
    { name: 'p99-under-500ms', assert: (r) => r.p99LatencyMs < 500 },
    { name: 'error-rate-under-1pct', assert: (r) => r.errorRate < 0.01 },
  ],
});
```

Same shape for `defineChaosScenario`, `defineInvariantScenario`, `defineFixEvaluationScenario` — each pinned to its own kind. See [`30-the-sim-loop/01-scenarios-and-recipes.md`](../30-the-sim-loop/01-scenarios-and-recipes.md).

---

## 4. A check pack (publishable)

A check pack is a check directory promoted to its own npm package. Use this when you want to ship the same checks across multiple projects.

### Where should this package live in your repo?

The opensip-tools platform reserves three paths inside your repo's `opensip-tools/` directory:

- `opensip-tools/fit/` — project-local fitness checks + recipes. Starts as loose `.mjs` files under `checks/` and `recipes/` (what `init` scaffolds). Can graduate to a workspace npm package — the directory *itself* becomes the package — when coverage grows. See [Graduation path](#graduation-path) below.
- `opensip-tools/sim/` — same shape for simulation scenarios + recipes.
- `opensip-tools/.runtime/` — tool-managed plugin install + session state (gitignored).

The platform doesn't load anything from these paths *directly* — discovery flows through `node_modules/` walking. When `opensip-tools/fit/` is a workspace package, your workspace's symlink puts it in `node_modules/` where the marker walker finds it. The directory layout is a *recommended convention*, not a platform requirement.

#### Marker-based discovery (recommended)

Tag your pack's `package.json` with `opensipTools.kind`:

```json
{
  "name": "@your-scope/fit",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "opensipTools": { "kind": "fit-pack" }
}
```

Discovery is name-pattern-independent — your pack can use any npm scope you own (`@acme/fit`, `@my-internal-org/checks-platform`, anything). The marker is what makes the platform find it. Same pattern for sim packs with `"kind": "sim-pack"`.

#### Graduation path

When a pack outgrows a handful of `.mjs` files (shared helpers, tests, more than a dozen checks/scenarios), graduate `opensip-tools/<domain>/` from loose files to a workspace npm package:

1. Add a `package.json` declaring the marker, name, and entry point.
2. Add a `tsconfig.json` and switch the example files to TypeScript (or keep `.mjs` — both work; the runtime loads whatever the package's `main` resolves to).
3. Add an `index.ts` (or `index.js`) re-exporting `checks` and `recipes` from the per-file modules.
4. Add `opensip-tools/*` to your workspace globs so pnpm/npm symlinks the package into `node_modules/`:

   ```yaml
   # pnpm-workspace.yaml
   packages:
     - "apps/*"
     - "packages/*"
     - "opensip-tools/*"   # opensip-tools-related workspace packages
   ```

5. Add the pack as a root devDependency so the workspace symlink lands in `node_modules/`:

   ```json
   // root package.json
   {
     "devDependencies": {
       "@your-scope/fit": "workspace:*"
     }
   }
   ```

6. `pnpm install`. Marker-based discovery picks up the workspace symlink on the next `opensip-tools fit` run.

For a TS-based pack you also need to build (`pnpm -F @your-scope/fit build`) so the `main` field resolves to real JS. The runtime doesn't currently load TypeScript directly; it loads the entry point your `package.json#main` points at.

#### Single-package repo

If you don't have a monorepo, publish your pack to a private npm registry under your own scope and install it as a regular devDependency. The marker still drives discovery — no `packageScopes` config entry needed.

#### Reference example

The opensip codebase follows this layout: `opensip-tools/fit/` is a workspace package named `@opensip/fit` with `opensipTools.kind: "fit-pack"` in its `package.json`. Discovery picks it up via the marker; no `plugins.checkPackages` entry, no `plugins.packageScopes` entry. Same shape for `opensip-tools/sim/` as `@opensip/sim`.

### Graduating from loose `.mjs` to a workspace pack

The fastest path to add a check is dropping a `.mjs` file under `<project>/opensip-tools/fit/checks/` ([§1 above](#1-a-project-local-check)). The fastest path to *ship* a versioned, reusable set is a workspace pack (this section). Most consumers start with the loose-file shape and graduate to the pack shape once their coverage grows past what loose files comfortably hold. This subsection walks the bridge.

#### When to graduate

Concrete pain signals, not arbitrary thresholds:

- Your `opensip-tools/fit/checks/*.mjs` count exceeds ~10–20 files and PR diffs are getting noisy.
- Multiple checks share helper logic and you're copy-pasting it between files.
- You want TypeScript instead of `.mjs` — type-checked analyzer code and autocomplete on the `defineCheck(...)` shape.
- You want tests colocated with each check.
- You want CI to run `pnpm typecheck` over the pack to catch authoring mistakes the platform doesn't notice (a slug typo in a recipe selector, a missing required field on a check).

If none of those apply, stay with loose `.mjs`. The graduation is worthwhile only when the loose-file shape starts to cost more than it saves.

#### The shape after graduation

A workspace pack at `opensip-tools/packages/checks-<name>/` (per [Where should this package live in your repo?](#where-should-this-package-live-in-your-repo)) with a `src/` tree, a `package.json` declaring `@opensip-tools/fitness` and `@opensip-tools/core` as peer deps, and the public surface described in [Layout](#layout) directly below. Two structural details make this scale cleanly past a few dozen checks:

```
opensip-tools/packages/checks-<name>/
├── package.json
├── tsconfig.json
├── src/
│   ├── checks/
│   │   ├── architecture/no-cycle.ts
│   │   ├── architecture/no-cycle.test.ts     # tests colocated
│   │   ├── observability/log-on-catch.ts
│   │   └── …                                 # one file per check
│   ├── shared/                               # internal helpers
│   ├── recipes/                              # canonical recipes shipped with the pack
│   │   └── default.ts
│   ├── register-checks.ts                    # mechanical aggregation
│   └── index.ts                              # thin public surface
└── …
```

- **`register-checks.ts` is mechanical aggregation.** One `import` line per check, then one big `export const allChecks: readonly Check[] = [...]` array. No logic. It grows linearly with the check count and is easy to skim and diff.
- **`index.ts` is the thin public surface.** It imports `allChecks` from `register-checks.ts`, imports the recipes, and re-exports the shape the platform consumes (`checks`, `checkDisplay`, `metadata` — see [§4 `src/index.ts`](#srcindexts)). It stays small even as the pack grows past hundreds of checks.
- **The split exists because in a single-file model every new check would touch the public surface.** With the split, adding a check touches one file (`register-checks.ts`); `index.ts` is stable.

This is a pattern that has worked at scale — the opensip codebase uses it for 308 fitness checks and 192 sim scenarios. Small packs (a handful of checks) can keep everything in one `index.ts`; the split only pays off once re-skimming the public surface on every change becomes a tax.

Sim packs follow the identical pattern: `src/register-scenarios.ts` instead of `register-checks.ts`, `defineLoadScenario(...)` / `defineChaosScenario(...)` / `defineInvariantScenario(...)` / `defineFixEvaluationScenario(...)` calls instead of `defineCheck(...)`, but the aggregation shape is the same.

#### Migration recipe

A step-by-step you can follow when you've decided to graduate:

1. **Pick the pack name and location.** See [Where should this package live in your repo?](#where-should-this-package-live-in-your-repo). For a workspace-only pack, `@opensip-tools/checks-<yourname>` is the simplest naming choice (auto-discovered with no config). For a pack you might publish, use your own scope and pick one of the [three discovery paths](#discovery-three-paths).
2. **Add the directory as a workspace member.** Append `opensip-tools/packages/*` to your `pnpm-workspace.yaml` (or yarn/npm equivalent).
3. **Write `package.json`.** Follow [§4 `package.json`](#packagejson) — peer-dep on `@opensip-tools/fitness` and `@opensip-tools/core`. (For sim packs, also `@opensip-tools/simulation`.)
4. **Convert each `.mjs` to a TypeScript module.** One `<slug>.ts` per check under `src/checks/`, each exporting a `defineCheck(...)` object. **Keep the same slug values** as the loose files used — recipes select by tag/slug, and `--check <slug>` invocations keep working across the move.
5. **Create `src/register-checks.ts`** that imports every check and exports `allChecks` as a `readonly Check[]`.
6. **Create `src/index.ts`** that imports `allChecks` and exports it as `checks`, plus `checkDisplay` and `metadata` (see [§4 `src/index.ts`](#srcindexts)).
7. **Add the pack as a root devDependency.** `"@opensip-tools/checks-<yourname>": "workspace:*"` in the root `package.json`. pnpm will symlink it into `node_modules/@opensip-tools/` where the default discovery walker finds it. If you used your own scope, either add the scope to `plugins.packageScopes` or pin the package under `plugins.checkPackages` in `opensip-tools.config.yml` — whichever fits your monorepo's preferences.
8. **Delete the original loose `.mjs` files** under `opensip-tools/fit/checks/` once the workspace pack is running cleanly and the same slugs are firing.

**Recipes during the move.** A recipe that lived at `opensip-tools/fit/recipes/<name>.mjs` can either stay there (the platform's project-local recipe walker continues to load it from the reserved path) or move into the pack as `src/recipes/<name>.ts` and be re-exported through `index.ts` alongside `checks`. Moving it into the pack is the cleaner end-state — single source of truth, versioned with the checks it references — but doing so is optional and can happen after the check migration lands.

#### Reference example

The opensip codebase uses this pattern at production scale. The split is visible directly in the public layout:

- [`opensip-tools/packages/checks-opensip/`](https://github.com/opensip-ai/opensip/tree/main/opensip-tools/packages/checks-opensip) — 308 fitness checks under `src/checks/<category>/`, aggregated through `src/register-checks.ts`, with a thin `src/index.ts` as the public surface.
- [`opensip-tools/packages/scenarios-opensip/`](https://github.com/opensip-ai/opensip/tree/main/opensip-tools/packages/scenarios-opensip) — 192 sim scenarios with the equivalent `src/register-scenarios.ts` shape.

Either is a working reference to pattern after when graduating your own pack.

### Layout

```
@my-co/checks-internal/
├── package.json                # declares opensipTools.kind: "fit-pack"
├── tsconfig.json
├── src/
│   ├── index.ts                # exports: checks, recipes, checkDisplay
│   ├── checks/
│   │   ├── no-fixme.ts
│   │   ├── infra-must-have-tags.ts
│   │   └── …
│   ├── recipes/
│   │   └── quick-smoke.ts
│   └── display.ts
├── dist/                       # built artifact
└── README.md
```

### `package.json`

```json
{
  "name": "@my-co/checks-internal",
  "version": "0.1.0",
  "main": "dist/index.js",
  "type": "module",
  "opensipTools": { "kind": "fit-pack" },
  "peerDependencies": {
    "@opensip-tools/fitness": "^2.0.0",
    "@opensip-tools/core": "^2.0.0"
  },
  "scripts": {
    "build": "tsc"
  },
  "files": ["dist"]
}
```

The `opensipTools.kind` marker is what makes discovery work. For sim packs, use `"kind": "sim-pack"`.

<a id="discovery-four-paths"></a>**Four discovery paths**, in recommendation order:

- **Marker (recommended)** — declare `opensipTools.kind: "fit-pack"` (or `"sim-pack"`) in your pack's `package.json`. Free choice of scope and name. No config entry. Sim packs use `"sim-pack"`.
- **`@opensip-tools/checks-*` name pattern** — auto-discovered by the platform's default scope scan. Reserved for first-party packs published by the opensip-tools project. **Don't publish customer packs under this scope** — it's owned by the platform and a future first-party pack may collide.
- **`plugins.packageScopes` (compat)** — soft-deprecated. Useful for legacy third-party packs that follow `@scope/checks-*` naming without declaring the marker. New packs should use the marker pattern; `packageScopes` exists to keep older packs working without rewriting them. Same key is shared with `@scope/scenarios-*` for sim.
- **`plugins.checkPackages` explicit listing** — pin individual packages by name. `opensip-tools plugin add @scope/pack` does this in one step. Best fit when you want a deterministic, version-pinned set rather than scope-wide auto-discovery. Parallel key for sim is `plugins.scenarioPackages`.

Peer-depend on `@opensip-tools/fitness` and `@opensip-tools/core` — the consumer brings their own version.

### `src/index.ts`

```ts
import type { CheckDisplayEntry } from '@opensip-tools/core';
import type { Check, FitnessRecipe } from '@opensip-tools/fitness';

import { noFixme } from './checks/no-fixme.js';
import { infraMustHaveTags } from './checks/infra-must-have-tags.js';
import { quickSmoke } from './recipes/quick-smoke.js';

export const checks: readonly Check[] = [noFixme, infraMustHaveTags];

export const recipes: readonly FitnessRecipe[] = [quickSmoke];

export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = {
  'no-fixme-comments': ['📝', 'No FIXME comments'],
  'infra-must-have-tags': ['🏷️', 'Infrastructure tags required'],
};
```

Pack metadata (name, version, description) is read from `package.json` by the platform — don't duplicate those fields as a runtime export.

### `src/checks/no-fixme.ts`

```ts
import { defineCheck } from '@opensip-tools/fitness';

export const noFixme = defineCheck({
  id: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  slug: 'no-fixme-comments',
  description: 'No FIXME comments left in source',
  tags: ['quality', 'documentation'],
  scope: { languages: [], concerns: [] },
  contentFilter: 'raw',
  analyze(content, filePath) {
    const violations: { line: number; message: string; severity: 'warning' }[] = [];
    content.split('\n').forEach((line, idx) => {
      if (/\bFIXME\b/.test(line)) {
        violations.push({ line: idx + 1, message: `FIXME at ${filePath}`, severity: 'warning' });
      }
    });
    return violations;
  },
});
```

### Publish + consume

```bash
# In your pack:
npm publish --access public      # or wire it up to GitHub OIDC trusted publishing

# In a consuming project:
opensip-tools plugin add @my-co/checks-internal
```

`plugin add` installs to `<project>/opensip-tools/.runtime/plugins/fit/node_modules/` and appends to `plugins.fit:` in `opensip-tools.config.yml`. Next `opensip-tools fit` run, your checks load.

### Testing

Use vitest. The check is a plain function — call it with sample content and assert the violation list.

```ts
// src/checks/__tests__/no-fixme.test.ts
import { describe, it, expect } from 'vitest';
import { noFixme } from '../no-fixme.js';

describe('no-fixme', () => {
  it('flags a FIXME comment via the integration entry point', async () => {
    // Check.run(cwd, options?) walks the project's targets and runs the
    // analyzer over every matched file. It returns a CheckResult.
    const result = await noFixme.run(process.cwd());
    expect(result.passed).toBe(false);
  });
});
```

For a tighter unit test, call the analyzer directly — `defineCheck` keeps the original `analyze`/`analyzeAll`/`command` callable on the source module, so a unit test imports that function and feeds it a string of source code. The integration shape above is the one to reach for when you want the targets/scope wiring exercised end-to-end.

The fitness package's own test fixtures (e.g. [`packages/fitness/engine/src/__tests__/`](../../../packages/fitness/engine/src/__tests__/)) show patterns for both unit and integration tests.

---

## 5. A full Tool plugin

A Tool contributes its own subcommand. Use this when you want something fundamentally different from `fit` or `sim` — an `audit-sec`, a `bench`, a custom `report`. Anything that has its own argv shape and its own result type.

### Layout

```
@my-co/audit-sec/
├── package.json
├── src/
│   ├── index.ts                # exports: tool
│   ├── audit.ts                # the actual logic
│   └── …
├── dist/
└── README.md
```

### `package.json`

```json
{
  "name": "@my-co/audit-sec",
  "version": "0.1.0",
  "main": "dist/index.js",
  "type": "module",
  "opensipTools": { "kind": "tool" },
  "peerDependencies": {
    "@opensip-tools/contracts": "^1.0.0",
    "@opensip-tools/core": "^1.0.0"
  }
}
```

### `src/index.ts`

```ts
import type { Tool, ToolCliContext } from '@opensip-tools/core';
import type { CliProgram } from '@opensip-tools/contracts';
import { runAudit } from './audit.js';

export const tool: Tool = {
  metadata: {
    id: 'audit-sec',
    version: '0.1.0',
    description: 'Lightweight security audit',
  },
  commands: [{ name: 'audit-sec', description: 'Run the security audit' }],
  register(cli: ToolCliContext) {
    const program = cli.program as CliProgram;
    program
      .command('audit-sec')
      .description('Run the security audit')
      .option('--cwd <path>', 'Target directory', process.cwd())
      .option('--json', 'Output structured JSON', false)
      .action(async (opts) => {
        const result = await runAudit(opts.cwd);
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          await cli.render(result);
        }
        cli.setExitCode(result.passed ? 0 : 1);
      });
  },
};
```

That's the whole tool. `npm install @my-co/audit-sec` (or `opensip-tools plugin add @my-co/audit-sec`) and `opensip-tools audit-sec` works on the next invocation.

### What you don't need

- An entry-points declaration.
- A hook or middleware registration.
- A code change in `@opensip-tools/cli`.
- A code change in `@opensip-tools/core`.
- A schema migration.

The Tool contract is the seam. The CLI walks `defaultToolRegistry`, discovers your package via the `opensipTools.kind: 'tool'` marker, and your Tool's `register()` mounts the command. See [`10-mental-model/02-tool-plugin-model.md`](../10-mental-model/02-tool-plugin-model.md).

### Tools that use the kernel registries

A Tool that wants to reuse the fitness check registry (e.g. an `audit-fit` that runs a custom recipe) imports `@opensip-tools/fitness` and reuses `executeFit`, `defineRecipe`, etc. The fitness package re-exports these so a Tool author doesn't have to assemble a runner from scratch.

A Tool that's structurally different (a benchmark runner, a custom report generator) doesn't need to import `@opensip-tools/fitness` at all — it can be entirely self-contained, with its own logic and its own output shape, as long as it produces a renderable `CommandResult` for the CLI's render layer to consume.

---

## Don't extend `CliArgs`

`CliArgs` is the union shape that predates the per-command options
interfaces. It still exists in `@opensip-tools/contracts` because the
`*OptsToCliArgs` adapter functions in `@opensip-tools/fitness`,
`@opensip-tools/simulation`, and the CLI's `init` command continue to
bridge per-command options to the legacy executor signature
(`executeFit(args: CliArgs, …)`, `executeSim(args: CliArgs)`,
`executeInit(args: CliArgs & {…})`). It's marked `@deprecated`.

If you're authoring a new flag for a built-in command, add it to the
per-command interface instead:

| Command | Options interface |
|---|---|
| `fit`     | `FitOptions` |
| `sim`     | `ToolOptions` |
| `init`    | `InitOptions` |
| your tool | a new interface in your tool package, named after the command |

The boundary types live in `@opensip-tools/contracts`. New flags
should be additive on those interfaces, not on `CliArgs`. The
adapters bridge the two shapes today; over time they fold away as the
executors take per-command options directly.

Read this as: "the CLI subcommand has its own options shape, and that
shape is the source of truth. `CliArgs` is the union that exists for
historical reasons."

For your own Tool plugin, you don't need to touch `CliArgs` at all —
your `register(cli)` defines its own Commander options and your
action handler receives them as the first argument. Use a typed
`CliProgram` (re-exported from `@opensip-tools/contracts`) if you
want a lint-clean `cli.program as CliProgram` cast without taking a
direct `commander` dependency in your package.

---

## Tips that come up

- **Test every check with the same content filter the framework will use.** The strip behavior is per-language; a check that works on raw content might break on filtered content. Use the language adapter's `stripComments` directly in tests if needed.
- **Use `--debug` aggressively while authoring.** Your check's log lines (`ctx.log(...)`) appear in stderr; the day-level log file under `<project>/opensip-tools/.runtime/logs/<YYYY-MM-DD>.jsonl` archives them. Filter by `runId` with `jq` if multiple runs landed in the same file.
- **Pin your peer-deps to majors, not minors.** Minor opensip-tools releases are non-breaking; pinning to a minor unnecessarily blocks consumers who are already on a newer minor.
- **Use the right discovery shape for the right export.** A package marked `opensipTools.kind: 'tool'` is treated as a Tool by the discovery walker — it must export `tool: Tool`. A check pack uses no marker and is discovered by name prefix or pinning. Mismatching the two leads to a load failure that's logged but not fatal.

---

## What's next

- **[`03-dashboard.md`](./03-dashboard.md)** — the HTML report's lifecycle (the renderer your check's findings end up in).
- **[`../80-reference/01-package-catalog.md`](../80-reference/01-package-catalog.md)** — the packages you can depend on.
- **[`../90-conventions/01-coding-standards.md`](../90-conventions/01-coding-standards.md)** — the style and structure conventions used throughout opensip-tools (handy if you're contributing back).
