---
status: current
last_verified: 2026-05-15
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
  - ../50-subsystems/02-check-packs.md
  - ../50-subsystems/01-language-adapters.md
---
# Plugin authoring

You can extend opensip-tools five ways, listed in increasing order of effort and capability:

1. **Add a project-local check** — drop a `.mjs` file under `<project>/opensip-tools/fit/checks/`.
2. **Add a project-local recipe** — drop a `.mjs` file under `<project>/opensip-tools/fit/recipes/`.
3. **Add a project-local sim scenario** — under `<project>/opensip-tools/sim/scenarios/`.
4. **Ship a check pack** — npm package whose name starts with `@opensip-tools/checks-*` (auto-discovered) or is pinned in `plugins.checkPackages:`.
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

The four selectors: `{ type: 'all' }`, `{ type: 'tags', include: [...] }`, `{ type: 'pattern', include: [...] }`, `{ type: 'explicit', checkIds: [...] }`. See [`20-the-fit-loop/01-recipes-and-checks.md`](/docs/opensip-tools/20-the-fit-loop/01-recipes-and-checks/).

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

Same shape for `defineChaosScenario`, `defineInvariantScenario`, `defineFixEvaluationScenario` — each pinned to its own kind. See [`30-the-sim-loop/01-scenarios-and-recipes.md`](/docs/opensip-tools/30-the-sim-loop/01-scenarios-and-recipes/).

---

## 4. A check pack (publishable)

A check pack is a check directory promoted to its own npm package. Use this when you want to ship the same checks across multiple projects.

### Layout

```
@my-co/checks-internal/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                # exports: checks, checkDisplay, metadata
│   ├── checks/
│   │   ├── no-fixme.ts
│   │   ├── infra-must-have-tags.ts
│   │   └── …
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
  "peerDependencies": {
    "@opensip-tools/fitness": "^1.0.0",
    "@opensip-tools/core": "^1.0.0"
  },
  "scripts": {
    "build": "tsc"
  },
  "files": ["dist"]
}
```

**No `opensipTools.kind` marker for check packs** — discovery is name-based. Two paths:

- **Publish into `@opensip-tools/checks-*`** — auto-discovered by name prefix when installed in `node_modules`.
- **Use any other scope** (e.g. `@my-co/checks-internal`) — the consumer must list it in `plugins.checkPackages:` (or `plugins.fit:`). `opensip-tools plugin add @my-co/checks-internal` does this in one step.

Peer-depend on `@opensip-tools/fitness` and `@opensip-tools/core` — the consumer brings their own version.

### `src/index.ts`

```ts
import type { Check, CheckDisplayEntry } from '@opensip-tools/core';
import { isCheck } from '@opensip-tools/fitness';

import { noFixme } from './checks/no-fixme.js';
import { infraMustHaveTags } from './checks/infra-must-have-tags.js';

export const checks: readonly Check[] = [noFixme, infraMustHaveTags];

export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = {
  'no-fixme-comments': ['📝', 'No FIXME comments'],
  'infra-must-have-tags': ['🏷️', 'Infrastructure tags required'],
};

export const metadata = {
  name: '@my-co/checks-internal',
  version: '0.1.0',
  description: 'Internal checks for the my-co monorepo',
};
```

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
  it('flags a FIXME comment', () => {
    const violations = noFixme.config.execute({} as never, /* ... */);
    // Or use noFixme.run(cwd) for a higher-level integration test.
  });
});
```

The fitness package's own test fixtures (e.g. [`packages/fitness/engine/src/__tests__/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.5/packages/fitness/engine/src/__tests__/)) show patterns for both unit and integration tests.

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
import type { Command } from 'commander';
import { runAudit } from './audit.js';

export const tool: Tool = {
  metadata: {
    id: 'audit-sec',
    version: '0.1.0',
    description: 'Lightweight security audit',
  },
  commands: [{ name: 'audit-sec', description: 'Run the security audit' }],
  register(cli: ToolCliContext) {
    const program = cli.program as Command;
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

The Tool contract is the seam. The CLI walks `defaultToolRegistry`, discovers your package via the `opensipTools.kind: 'tool'` marker, and your Tool's `register()` mounts the command. See [`10-mental-model/02-tool-plugin-model.md`](/docs/opensip-tools/10-mental-model/02-tool-plugin-model/).

### Tools that use the kernel registries

A Tool that wants to reuse the fitness check registry (e.g. an `audit-fit` that runs a custom recipe) imports `@opensip-tools/fitness` and reuses `executeFit`, `defineRecipe`, etc. The fitness package re-exports these so a Tool author doesn't have to assemble a runner from scratch.

A Tool that's structurally different (a benchmark runner, a custom report generator) doesn't need to import `@opensip-tools/fitness` at all — it can be entirely self-contained, with its own logic and its own output shape, as long as it produces a renderable `CommandResult` for the CLI's render layer to consume.

---

## Tips that come up

- **Test every check with the same content filter the framework will use.** The strip behavior is per-language; a check that works on raw content might break on filtered content. Use the language adapter's `stripComments` directly in tests if needed.
- **Use `--debug` aggressively while authoring.** Your check's log lines (`ctx.log(...)`) appear in stderr; the run log file under `<project>/opensip-tools/.runtime/logs/<run-id>.jsonl` archives them.
- **Pin your peer-deps to majors, not minors.** Minor opensip-tools releases are non-breaking; pinning to a minor unnecessarily blocks consumers who are already on a newer minor.
- **Use the right discovery shape for the right export.** A package marked `opensipTools.kind: 'tool'` is treated as a Tool by the discovery walker — it must export `tool: Tool`. A check pack uses no marker and is discovered by name prefix or pinning. Mismatching the two leads to a load failure that's logged but not fatal.

---

## What's next

- **[`03-dashboard.md`](/docs/opensip-tools/60-surfaces/03-dashboard/)** — the HTML report's lifecycle (the renderer your check's findings end up in).
- **[`../70-reference/01-package-catalog.md`](/docs/opensip-tools/70-reference/01-package-catalog/)** — the packages you can depend on.
- **[`../80-conventions/01-coding-standards.md`](/docs/opensip-tools/80-conventions/01-coding-standards/)** — the style and structure conventions used throughout opensip-tools (handy if you're contributing back).
