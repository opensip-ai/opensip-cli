---
status: current
last_verified: 2026-06-15
release: v0.1.3
title: "Project-local plugins"
audience: [plugin-authors, getting-started]
purpose: "The fastest path to extend opensip: drop .mjs files under opensip-cli/{fit,sim}/ — checks, recipes, scenarios."
source-files:
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/fitness/engine/src/recipes/types.ts
  - packages/simulation/engine/src/index.ts
related-docs:
  - ./01-plugin-authoring.md
  - ./03-publishable-packs.md
  - ../20-fit/01-recipes-and-checks.md
  - ../30-sim/01-scenarios-and-recipes.md
---
# Project-local plugins

The fastest path to extend opensip: drop a `.mjs` file under `<project>/opensip-cli/fit/{checks,recipes}/` or `<project>/opensip-cli/sim/{scenarios,recipes}/`. The scan is recursive, so category folders like `opensip-cli/fit/checks/docs/no-fixme.mjs` are valid; namespaces include the relative path. The loader picks it up on the next run. No publishing, no install, no config entry.

This page covers all three project-local shapes: a check, a recipe, and a sim scenario. Each is ~30 lines.

## A project-local check

```js
// <project>/opensip-cli/fit/checks/no-fixme.mjs
import { defineCheck } from '@opensip-cli/fitness';

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

`opensip fit-list` shows it. `opensip fit` runs it against every TypeScript file in matched targets.

The id is a UUID v4. Generate one with `node -e "console.log(crypto.randomUUID())"`. It must be stable across renames — no central registry, but the framework uses the id to key baselines, so changing it breaks gates.

**The five fields you'll touch most:**

| Field | When to set |
|---|---|
| `slug` | Always. Kebab-case, human-readable. |
| `description` | Always. One-line summary shown in `--list`. |
| `tags` | Always. At least one tag — recipes select by tag. |
| `scope` | Almost always. Tells the framework what kind of code this check is for. |
| `contentFilter` | Set to `'strip-strings-and-comments'` for regex-shaped checks; default `'raw'` is for text scanners. |

For walking the TypeScript AST instead of regex, see [Ban an API pattern](../60-guides/02-ban-an-api-pattern.md) for the AST shape, and [`@opensip-cli/lang-typescript`](../../../packages/languages/lang-typescript/src/index.ts) for the helper exports.

## A project-local recipe

```js
// <project>/opensip-cli/fit/recipes/quick-smoke.mjs
import { defineRecipe } from '@opensip-cli/fitness';

// Recipes load only from a `recipes` array export — not a default export.
export const recipes = [defineRecipe({
  name: 'quick-smoke',
  displayName: 'Quick smoke',
  description: 'Fast PR feedback — universal checks only',
  checks: { type: 'tags', include: ['universal'] },
  execution: { mode: 'parallel', timeout: 10_000, stopOnFirstFailure: false },
  reporting: { format: 'table' },
})];
```

`opensip fit-recipes` lists it. `opensip fit --recipe quick-smoke` runs it.

The four selectors: `{ type: 'all' }`, `{ type: 'tags', include: [...] }`, `{ type: 'pattern', include: [...] }`, `{ type: 'explicit', checkIds: [...] }`. See [recipes and checks](../20-fit/01-recipes-and-checks.md).

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

## A project-local sim scenario

```js
// <project>/opensip-cli/sim/scenarios/checkout-burst.mjs
import { defineLoadScenario } from '@opensip-cli/simulation';

// Scenarios load only from a `scenarios` array export — not a default export.
export const scenarios = [defineLoadScenario({
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
})];
```

Same shape for `defineChaosScenario` — each pinned to its own kind. See [scenarios and recipes](../30-sim/01-scenarios-and-recipes.md).

## When to graduate

The `.mjs` shape works fine through ~10-15 checks. Past that you'll want types, shared helpers, colocated tests, and a way to publish. That's when you graduate to a publishable workspace pack — see [Publishable packs](./03-publishable-packs.md).

## Where to go next

| You want to … | Go to … |
|---|---|
| Graduate to a publishable pack | [Publishable packs](./03-publishable-packs.md) |
| Write a full Tool plugin (own subcommand) | [Full Tool plugins](./06-full-tool-plugins.md) |
| Walk a guided "first check" tutorial | [Write your first check](../60-guides/01-write-your-first-check.md) |
| Reference: recipe selectors and check fields | [Recipes and checks](../20-fit/01-recipes-and-checks.md) |
