---
status: current
last_verified: 2026-06-15
release: v0.1.0
title: "Recipes and checks"
audience: [contributors, plugin-authors]
purpose: "What a recipe is, what a check is, and how they compose. The two primary author-facing primitives in fit."
source-files:
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/fitness/engine/src/framework/check-config.ts
  - packages/fitness/engine/src/framework/check-types.ts
  - packages/fitness/engine/src/recipes/types.ts
  - packages/fitness/engine/src/recipes/registry.ts
  - packages/fitness/engine/src/recipes/built-in-recipes.ts
  - packages/fitness/engine/src/recipes/service.ts
related-docs:
  - ../10-concepts/01-fitness-loop.md
  - ./02-targets-and-scope.md
  - ./03-ignore-directives.md
  - ../50-extend/01-plugin-authoring.md
---
# Recipes and checks

Two primitives. A **check** is the rule. A **recipe** is the lineup. Authors write checks; teams configure recipes.

> **What you'll understand after this:**
> - The three analysis modes a check can use (and when each is appropriate).
> - Required fields on a check vs. optional ones.
> - The four selector kinds a recipe uses to pick checks.
> - Per-check parameter overrides via the recipe's `config:` map.
> - Where built-in recipes come from.

---

## Anatomy of a check

A check is the result of `defineCheck()`. The configuration shape is in [`packages/fitness/engine/src/framework/check-config.ts`](../../../packages/fitness/engine/src/framework/check-config.ts); the validator is Zod-driven, so misconfigured checks throw at definition time, not at run time.

### Required fields

```ts
defineCheck({
  id: '0c2c8ca6-3c8c-4c8c-9c8c-1c8c2c8c3c8c', // UUID v4 — stable across renames
  slug: 'no-console-log',                       // kebab-case, human-readable
  description: 'Disallow console.log',          // one-line summary
  tags: ['quality', 'logging'],                 // ≥ 1 tag required
  // exactly one of: analyze, analyzeAll, command
  analyze: (content, filePath) => [/* CheckViolation[] */],
});
```

`id` is a UUID. The slug is what the user sees and what they pass to `--check <slug>`; the id is what the framework keys by internally. The split exists so a check can be renamed (slug change) without invalidating baselines that reference it by id.

`tags` is required and must contain at least one entry. Tags drive recipe selection (`{ type: 'tags', include: ['quality'] }`) and the dashboard's grouping. Common tags: `quality`, `security`, `architecture`, `testing`, `documentation`, `performance`.

`description` is the one-line summary shown in `--list`. Keep it under 80 characters. Optional `longDescription` is shown in the dashboard and supports multi-line prose.

### The three analysis modes

Exactly one of `analyze`, `analyzeAll`, or `command` is required. The validator throws if you set zero or more than one.

#### `analyze` — per-file

```ts
analyze: (content: string, filePath: string) => CheckViolation[]
```

The framework iterates over the matched files. For each file, it reads the content, runs the language adapter's content filter, then calls `analyze(content, filePath)`. Synchronous return. Best for regex-shaped rules.

```ts
defineCheck({
  id: '...',
  slug: 'no-console-log',
  description: 'No console.log in production code',
  tags: ['quality'],
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => {
    const violations: CheckViolation[] = [];
    content.split('\n').forEach((line, idx) => {
      if (/console\.log\b/.test(line)) {
        violations.push({
          line: idx + 1,
          message: 'console.log is forbidden in production',
          severity: 'error',
        });
      }
    });
    return violations;
  },
});
```

#### `analyzeAll` — multi-file

```ts
analyzeAll: (files: FileAccessor) => Promise<CheckViolation[]>
```

The framework hands you a `FileAccessor` over the matched file list. You control the iteration. Asynchronous. Use this when one file's violation depends on another file's content — circular import detection, cross-module API consistency, dead-export elimination.

```ts
defineCheck({
  id: '...',
  slug: 'no-circular-imports',
  description: 'No circular import chains',
  tags: ['architecture'],
  analyzeAll: async (files) => {
    const graph = await buildImportGraph(files);
    const cycles = detectCycles(graph);
    return cycles.map(cycle => ({
      line: 1,
      filePath: cycle[0],
      message: `Circular import: ${cycle.join(' → ')}`,
      severity: 'error',
    }));
  },
});
```

`FileAccessor` exposes `paths`, `read(path)`, `readMany(paths)`, and `readAll()`. Reads are cached; reading the same file twice within one check is free.

#### `command` — external tool

```ts
command: {
  bin: 'tsc',
  args: ['--noEmit'],
  parseOutput(stdout, stderr, exitCode, files, cwd) { /* CheckViolation[] */ }
}
```

The framework spawns the binary, captures stdout/stderr and the exit code, and hands them to your parser. Use this to wrap external linters, type-checkers, or static analyzers that already produce structured output.

```ts
defineCheck({
  id: '...',
  slug: 'tsc-strict',
  description: 'TypeScript strict-mode passes',
  tags: ['quality', 'typescript'],
  command: {
    bin: 'tsc',
    args: ['--noEmit', '--strict'],
    expectedExitCodes: [0, 1, 2],
    parseOutput(stdout, _stderr, _exitCode, _files, _cwd) {
      return stdout.split('\n')
        .filter(line => /^[^:]+:\d+:\d+ - error/.test(line))
        .map(parseDiagnosticLine);
    },
  },
});
```

`expectedExitCodes` lists the exit codes that count as "ran successfully" (even if violations were found). An exit code outside that list is treated as the binary having crashed; the check is reported as errored, not failed.

### Optional fields you'll use most

| Field | What it does |
|---|---|
| `scope: { languages, concerns }` | Marketplace-ready target matching. See [`02-targets-and-scope.md`](./02-targets-and-scope.md). |
| `fileTypes: ['ts', 'tsx']` | Filter matched files to these extensions. |
| `contentFilter: 'raw' \| 'strip-strings' \| 'strip-strings-and-comments'` | Language-adapter filter mode (default `raw`). |
| `confidence: 'high' \| 'medium' \| 'low'` | Metadata for downstream consumers (dashboards, cloud reporters). |
| `disabled: true` | Skip this check by default. Recipes can opt back in via `includeDisabled`. |
| `timeout: 30_000` | Per-check timeout in milliseconds. Overrides the recipe-level default. |
| `provider: 'eslint'` | Provider name for external-tool checks; appears in `Signal.provider`. |
| `itemType: 'modules'` | Display label in the results table when the unit being scanned isn't files. |

### What `defineCheck` returns

A `Check` object ([`packages/fitness/engine/src/framework/check-types.ts:45`](../../../packages/fitness/engine/src/framework/check-types.ts)):

```ts
interface Check {
  readonly config: CheckConfig;
  readonly run: (cwd: string, options?: RunOptions) => Promise<CheckResult>;
  readonly getScope: () => ResolvedScope;
  readonly getMatcher: (cwd: string) => PathMatcher;
}
```

The recipe service calls `run(cwd, { signal })` once per check. You'll rarely interact with this directly — the engine and the recipe service handle it. But it's exported, so an embedding context (a custom CI plugin, a future GUI) can run a single check programmatically.

---

## Anatomy of a recipe

A recipe is what `--recipe <name>` selects. It's a named configuration that says: "run *these* checks, in *this* mode, with *this* output."

### `defineRecipe()`

```ts
import { defineRecipe } from '@opensip-cli/fitness';

export default defineRecipe({
  name: 'quick-smoke',
  displayName: 'Quick smoke',
  description: 'Fast PR feedback — universal checks only',
  checks: { type: 'tags', include: ['universal'] },
  execution: { mode: 'parallel', timeout: 10_000 },
  reporting: { format: 'table' },
});
```

The full input shape is in [`packages/fitness/engine/src/recipes/types.ts`](../../../packages/fitness/engine/src/recipes/types.ts):

```ts
interface FitnessRecipeDefinition {
  readonly name: string;             // unique among recipes
  readonly displayName: string;      // human-readable
  readonly description: string;
  readonly checks: CheckSelector;
  readonly execution?: Partial<FitnessExecutionOptions>;
  readonly reporting?: Partial<FitnessReportingOptions>;
  readonly tags?: readonly string[];
  readonly includeDisabled?: readonly string[];  // re-enable specific disabled checks
}
```

### The four selector kinds

`CheckSelector` is a discriminated union. Pick one:

```ts
{ type: 'all', exclude?: string[] }
{ type: 'tags', include: string[], exclude?: string[] }
{ type: 'pattern', include: string[], exclude?: string[] }     // glob over slug
{ type: 'explicit', checkIds: string[] }
```

| Kind | When to use |
|---|---|
| `all` | The default recipe. "Every check we know about, minus exclusions." |
| `tags` | Most production recipes. "Run the checks tagged `security` and `quality`." |
| `pattern` | Slug patterns. "Run every check matching `fit:no-*`." |
| `explicit` | Locked-down recipes. "Exactly these slugs, no more." |

A check is included if (a) the selector matches it and (b) it isn't `disabled` (unless its slug is in `includeDisabled`).

### Per-check parameter overrides

Some checks accept parameters: a complexity check might want `maxComplexity: 25`; a TODO scanner might want `urgentTags: ['FIXME', 'XXX']`. These flow through the recipe's `config:` map, which is part of the `CheckSelector` shape:

```ts
defineRecipe({
  name: 'strict',
  displayName: 'Strict',
  description: 'Aggressive thresholds',
  checks: {
    type: 'all',
    config: {
      'complex-function': { maxComplexity: 15 },
      'todo-scanner':     { urgentTags: ['FIXME', 'XXX', 'HACK'] },
    },
  },
});
```

Inside the check, read your slice via `getCheckConfig<T>(slug)` ([`packages/fitness/engine/src/recipes/check-config.ts`](../../../packages/fitness/engine/src/recipes/check-config.ts)):

```ts
import { getCheckConfig } from '@opensip-cli/fitness';

defineCheck({
  id: '...',
  slug: 'complex-function',
  description: 'Cap cyclomatic complexity',
  tags: ['quality'],
  analyze: (content, filePath) => {
    const { maxComplexity = 25 } = getCheckConfig<{ maxComplexity?: number }>('complex-function');
    // ...
  },
});
```

The recipe service projects the `config:` map onto the current `RunScope` (the per-invocation execution scope) before execution and clears it when the run finishes, so checks read it synchronously via `getCheckConfig()`. The lookup is scope-bound rather than module-bound — `getCheckConfig` resolves through `currentScope()` in `@opensip-cli/core`, which keeps the config slot identity stable even when two copies of `@opensip-cli/fitness` are loaded (the CLI's bundled copy and a plugin pack's resolved copy). Without an override, or when called outside a run scope, `getCheckConfig()` returns an empty object — checks should default-handle that.

### Execution options

```ts
interface FitnessExecutionOptions {
  readonly mode: 'parallel' | 'sequential';     // default: parallel
  readonly stopOnFirstFailure: boolean;         // default: false
  readonly timeout?: number;                     // default: 30_000 ms per check
  readonly maxParallel?: number;                 // default: os.availableParallelism()
  readonly retryOnFailure?: boolean;             // default: false
  readonly maxRetries?: number;                  // default: 1
  readonly successThreshold?: number;            // not currently used at runtime
}
```

`parallel` is the default and the right answer for almost every recipe. `sequential` is for cases where checks have side effects on disk (writing temp files, etc.) — rare.

`stopOnFirstFailure: true` short-circuits on the first failing check. Useful for `quick-smoke`-style recipes; counterproductive for the full recipe (you want to see every problem, not just the first).

`timeout` applies per check. A timed-out check returns a `timedOut` flag in its result; the recipe-level `passed` flag is computed across all results.

### Reporting options

```ts
interface FitnessReportingOptions {
  readonly format: 'table' | 'json' | 'unified';   // default: table
  readonly verbose: boolean;                         // default: false
}
```

These set the *recipe's* default reporting. The CLI flag `--json` overrides whatever the recipe says — the user always wins. The `unified` format is a compact mode for verbose terminal output; `table` is the default human-readable shape.

Recipe-owned file paths are not part of the supported reporting contract. If a recipe object carries a historical `outputPath` field, the CLI ignores it; use shell redirection with `--json`, `--report-to`, or `fit-baseline-export` for file artifacts.

---

## Where recipes come from

Three sources, loaded in order:

1. **Built-in.** [`packages/fitness/engine/src/recipes/built-in-recipes.ts`](../../../packages/fitness/engine/src/recipes/built-in-recipes.ts) defines `default` (every enabled check, parallel, table output) and a small handful of canonical recipes. These ship with `@opensip-cli/fitness` and are always available.
2. **Project-local.** `.js`/`.mjs` files recursively under `<project>/opensip-cli/fit/recipes/` are loaded by the plugin discoverer. Each module exports a `recipes` array. This is where most teams put their `quick-smoke`, `pre-merge`, and `nightly` recipes.
3. **npm-package.** Check packs (any package declaring `opensipTools.kind: "fit-pack"` or listed in `plugins.checkPackages:`) can export recipes alongside checks, by declaring `recipes:` in their entry. A pack-shipped recipe is registered the same way a project-local one is.

The recipe registry is last-writer-wins. A project-local `default` recipe overrides the built-in one; a pack-shipped recipe with a name conflict overrides whichever was registered first.

`opensip fit-recipes` lists every recipe currently registered, with check counts. `opensip fit --recipes` (the alias) does the same.

---

## Where the example lands

For the `acme-api` worked example:

- The `quick-smoke` recipe selects `{ type: 'tags', include: ['universal'] }` — only the universal pack's checks. CI's pre-merge job runs this.
- The `default` (built-in) recipe selects `{ type: 'all' }`. CI's nightly job runs this with `--gate-compare`.
- A custom `infra` recipe selects `{ type: 'pattern', include: ['fit:infra-*'] }` for the team that owns the CDK stack. They run it on PRs that touch `infra/`.

All three are in `acme-api/opensip-cli/fit/recipes/`. Nothing in the kernel knows about them; the loader picks them up at startup.

---

## What's next

- **[`02-targets-and-scope.md`](./02-targets-and-scope.md)** — how the framework decides which files a check runs against. Where `scope`, `fileTypes`, and the targets registry interact.
- **[`03-ignore-directives.md`](./03-ignore-directives.md)** — inline source-level suppression for individual violations.
- **[`../50-extend/01-plugin-authoring.md`](../50-extend/01-plugin-authoring.md)** — full walkthrough of authoring a check pack, a project-local check, and a custom recipe.
