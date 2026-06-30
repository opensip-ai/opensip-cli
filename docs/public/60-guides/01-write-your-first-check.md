---
status: current
last_verified: 2026-06-15
release: v0.1.18
title: "Write your first check"
audience: [getting-started, plugin-authors]
purpose: "Task-led walkthrough: from `opensip init` to a passing CI gate, with one custom check you authored, in ~15 minutes."
source-files:
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/cli/src/commands/init.ts
related-docs:
  - ../00-start/02-show-me-the-loops.md
  - ../50-extend/01-plugin-authoring.md
  - ../20-fit/01-recipes-and-checks.md
  - ./03-wire-into-ci.md
---
# Write your first check

By the end of this page you'll have: an installed CLI, an `opensip-cli.config.yml`, one custom check you wrote, a recipe that runs it, and a passing-or-failing exit code that CI can gate on. ~15 minutes if you're new to the tool; less if you've seen the [show-me page](../00-start/02-show-me-the-loops.md).

## 1. Scaffold a project

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
cd your-project
opensip init
```

`init` detects your language(s) and scaffolds:

```
your-project/
├── opensip-cli.config.yml
└── opensip-cli/
    ├── fit/
    │   ├── checks/example-check.mjs
    │   └── recipes/example-recipe.mjs
    └── sim/
        └── …
```

Confirm it works:

```bash
opensip fit --recipe example
# 1 Passed, 0 Failed | Duration 0.1s
```

If that exits 0, the platform is wired correctly. Delete or edit the example as you like — the rest of this page replaces it.

## 2. Write your check

Pick something your team cares about. We'll do *"no `FIXME` comments left in production code"* — small enough to fit on this page, real enough to demonstrate the moving parts.

Create `opensip-cli/fit/checks/no-fixme.mjs`:

```js
import { defineCheck } from '@opensip-cli/fitness';

export default defineCheck({
  // UUID v4 — stable across renames. Generate with:
  //   node -e "console.log(crypto.randomUUID())"
  id: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  slug: 'no-fixme-comments',
  description: 'No FIXME comments left in source',
  tags: ['quality', 'documentation'],
  scope: { languages: ['typescript'], concerns: [] },
  contentFilter: 'raw',  // see comments — don't strip them

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

Five fields you'll touch in every check:

- **`id`** — UUID v4, never changes. Baselines key on this; renaming the slug doesn't break gates.
- **`slug`** — kebab-case, human-readable. Users pass it to `--check <slug>`.
- **`description`** — one-line summary. Shown in `--list` and the dashboard.
- **`tags`** — recipes select checks by tag (`{ type: 'tags', include: ['quality'] }`).
- **`scope`** — what kind of code this is for. Filters which files the check runs against.

`analyze(content, filePath)` returns an array of violations. Empty = the check passed for that file.

## 3. Confirm it loads

```bash
opensip fit --list
```

Your check appears in the list. If it doesn't, check:

- File is under `opensip-cli/fit/checks/` (nested category directories are fine; the `.mjs` extension matters — it's how the loader identifies plugins)
- `export default defineCheck(...)` (default export — not a named one)
- No syntax errors (`node opensip-cli/fit/checks/no-fixme.mjs` will surface them)

## 4. Run it

```bash
opensip fit --check no-fixme-comments
```

Output:

```text
  ✗ no-fixme-comments   312 files,   2 violations
  0 Passed, 1 Failed (2 Errors, 0 Warnings) | Duration 0.4s

> echo $?
1
```

Add `--verbose` to see each violation's file + line:

```bash
opensip fit --check no-fixme-comments --verbose
```

If you wanted to *clean up* the violations first and gate on *new* ones only, this is where the baseline flow kicks in — see [wire into CI](./03-wire-into-ci.md) and [adopt in a monorepo](./04-adopt-in-a-monorepo.md).

## 5. Add it to a recipe

A recipe is a named lineup of checks plus execution options. Create `opensip-cli/fit/recipes/quality.mjs`:

```js
export const recipes = [{
  id: 'URCP_quality',
  name: 'quality',
  displayName: 'Quality',
  description: 'Code-quality checks',
  checks: { type: 'tags', include: ['quality'] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
```

`checks: { type: 'tags', include: ['quality'] }` picks every check tagged `quality` — including your new `no-fixme-comments` check and any built-in checks with that tag. Other selectors:

- `{ type: 'all' }` — every enabled check
- `{ type: 'pattern', include: ['no-*'] }` — slug glob
- `{ type: 'explicit', checkIds: ['no-fixme-comments', …] }` — exact slug list

Run the recipe:

```bash
opensip fit --recipe quality
```

## 6. Lock in a CI gate

Run once to capture the current state as the baseline:

```bash
opensip fit --recipe quality --gate-save
```

From now on, in CI:

```bash
opensip fit --recipe quality --gate-compare
```

`--gate-compare` exits 0 if no *new* violations appeared (existing ones are tolerated), non-zero otherwise. That's the incremental-adoption flow — you don't have to fix the baseline before turning the gate on.

The full GitHub Actions example is in [wire into CI](./03-wire-into-ci.md).

## Where to go next

| You want to … | Go to … |
|---|---|
| Ban a specific API in your codebase | [Ban an API pattern](./02-ban-an-api-pattern.md) |
| Add the GitHub Actions step | [Wire into CI](./03-wire-into-ci.md) |
| Graduate from `.mjs` files to a TypeScript workspace pack | [Adopt in a monorepo](./04-adopt-in-a-monorepo.md) |
| Reference the full check API | [Plugin authoring](../50-extend/01-plugin-authoring.md) |
| See every built-in check | [Checks reference](../70-reference/05-checks-index.md) |
