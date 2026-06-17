---
status: current
last_verified: 2026-06-15
release: v0.1.5
title: "Publishable packs"
audience: [plugin-authors]
purpose: "Author and publish fit packs or sim scenario packs: workspace package skeleton, discovery contracts, and the migration recipe from loose .mjs files."
source-files:
  - packages/core/src/plugins/types.ts
  - packages/core/src/plugins/marker-discovery.ts
  - packages/fitness/engine/src/framework/define-check.ts
related-docs:
  - ./02-project-local-plugins.md
  - ./04-check-pack-architecture.md
  - ../60-guides/04-adopt-in-a-monorepo.md
---
# Publishable packs

A pack is a check directory (or sim-scenario directory) promoted to its own npm package. Use this when you want to ship the same checks across multiple projects — or to keep a project-local pack tidy as it grows past loose `.mjs` files.

## Where the pack lives in your repo

The opensip-cli platform reserves three paths inside your repo's `opensip-cli/` directory:

- `opensip-cli/fit/` — project-local fitness checks + recipes. Starts as loose `.mjs` files under `checks/` and `recipes/` (what `init` scaffolds). Can graduate to a workspace npm package — the directory *itself* becomes the package — when coverage grows.
- `opensip-cli/sim/` — same shape for simulation scenarios + recipes.
- `opensip-cli/.runtime/` — tool-managed plugin install + session state (gitignored).

The platform doesn't load anything from these paths *directly* — discovery flows through `node_modules/` walking. When `opensip-cli/fit/` is a workspace package, your workspace's symlink puts it in `node_modules/` where the marker walker finds it. The directory layout is a *recommended convention*, not a platform requirement.

## The marker (recommended discovery path)

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

For a **fit pack** the `fit-pack` marker is name-pattern-independent — your pack
can use any npm scope you own (`@acme/fit`, `@my-internal-org/checks-platform`,
anything); the marker is what makes the platform find it. A **sim pack** is
discovered by a name pattern instead — name it `<scope>/scenarios-*` (see
below).

### Discovery paths

Listed in recommendation order:

- **fit: the `fit-pack` marker (recommended)** — declare `opensipTools.kind: "fit-pack"` in your pack's `package.json`. Free choice of scope and name. No config entry.
- **sim: the `scenarios-*` name pattern (recommended)** — name your pack
  `<scope>/scenarios-*` (e.g. `@acme/scenarios-load`). `plugins.packageScopes`
  extends the scopes scanned beyond `@opensip-cli`.
- **explicit listing** — name individual packages in `plugins.checkPackages` (fit) or `plugins.scenarioPackages` (sim) from project `node_modules`. For fit, an explicit list is ADDED to marker discovery; for sim it pins the set.
- **Project-pinned install** — `opensip plugin add --domain fit @scope/pack` or `--domain sim @scope/pack` installs into `.runtime/plugins/<domain>/` and records `plugins.fit:` / `plugins.sim:` so teammates can reproduce it with `plugin sync`.

## When to graduate from loose `.mjs`

Concrete pain signals, not arbitrary thresholds:

- Your loose `.mjs` count under `opensip-cli/fit/checks/` exceeds ~10–20 files and PR diffs are getting noisy.
- Multiple checks share helper logic and you're copy-pasting it between files.
- You want TypeScript instead of `.mjs` — type-checked analyzer code and autocomplete on the `defineCheck(...)` shape.
- You want tests colocated with each check.
- You want CI to run `pnpm typecheck` over the pack to catch authoring mistakes the platform doesn't notice (a slug typo in a recipe selector, a missing required field on a check).

If none of those apply, stay with loose `.mjs`. The graduation is worthwhile only when the loose-file shape starts to cost more than it saves.

## Layout after graduation

```
@my-co/checks-internal/
├── package.json                # declares opensipTools.kind: "fit-pack"
├── tsconfig.json
├── src/
│   ├── index.ts                # exports: checks (display folded on), recipes
│   ├── checks/
│   │   ├── architecture/no-cycle.ts
│   │   ├── architecture/no-cycle.test.ts     # tests colocated
│   │   ├── observability/log-on-catch.ts
│   │   ├── architecture/index.ts             # category barrel
│   │   └── index.ts                          # top-level checks barrel
│   ├── shared/                               # internal helpers
│   ├── recipes/                              # canonical recipes shipped with the pack
│   │   └── default.ts
│   └── display/                              # icon/display-name map
├── dist/                                     # built artifact
└── README.md
```

Two structural details make this scale cleanly past a few dozen checks:

- **Category barrels are mechanical aggregation.** Each `checks/<category>/index.ts`
  re-exports the checks in that category, and `checks/index.ts` re-exports the
  category barrels. No runtime logic belongs there.
- **`index.ts` is the thin public surface.** It imports all check exports from
  `checks/index.ts`, folds the per-pack display map onto them with
  `collectCheckObjects(...)` + `applyCheckDisplay(...)`, and exports the pack's
  `checks` array. It stays small even as the pack grows.
- **The split exists because in a single-file model every new check would touch
  the public surface.** With the split, adding a check normally touches the new
  check file, its category barrel, the display map, and tests; the root
  `index.ts` remains stable.

This pattern works at scale in the opensip codebase's 151 built-in fitness
checks across seven packs. Small packs can keep everything in one `index.ts`;
the split only pays off once re-skimming the public surface on every change
becomes a tax. Sim packs can use the same idea with `scenarios/index.ts` barrels
and `defineLoadScenario(...)` / `defineChaosScenario(...)` exports.

## `package.json`

```json
{
  "name": "@my-co/checks-internal",
  "version": "1.0.0",
  "main": "dist/index.js",
  "type": "module",
  "opensipTools": { "kind": "fit-pack" },
  "peerDependencies": {
    "@opensip-cli/fitness": "^0.1.5",
    "@opensip-cli/core": "^0.1.5"
  },
  "scripts": {
    "build": "tsc"
  },
  "files": ["dist"]
}
```

Peer-depend on `@opensip-cli/fitness` and `@opensip-cli/core` — the consumer brings their own version.

## `src/index.ts`

```ts
import { applyCheckDisplay, type Check, type CheckDisplayEntry, type FitnessRecipe } from '@opensip-cli/fitness';

import { noFixme } from './checks/no-fixme.js';
import { infraMustHaveTags } from './checks/infra-must-have-tags.js';
import { quickSmoke } from './recipes/quick-smoke.js';

// Display (icon + name) travels ON each check (§5.3): keep an authoring map and
// fold it onto the checks here. There is no separate `checkDisplay` export.
const CHECK_DISPLAY: Readonly<Record<string, CheckDisplayEntry>> = {
  'no-fixme-comments': ['📝', 'No FIXME comments'],
  'infra-must-have-tags': ['🏷️', 'Infrastructure tags required'],
};

export const checks: readonly Check[] = applyCheckDisplay([noFixme, infraMustHaveTags], CHECK_DISPLAY);

export const recipes: readonly FitnessRecipe[] = [quickSmoke];
```

Pack metadata (name, version, description) is read from `package.json` by the platform — don't duplicate those fields as a runtime export.

## `src/checks/no-fixme.ts`

```ts
import { defineCheck } from '@opensip-cli/fitness';

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

## Workspace integration

For a monorepo workspace pack, add `opensip-cli/*` to your workspace globs so pnpm/npm symlinks the package into `node_modules/`:

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "opensip-cli/*"   # opensip-cli-related workspace packages
```

Add the pack as a root devDependency so the workspace symlink lands in `node_modules/`:

```json
// root package.json
{
  "devDependencies": {
    "@your-scope/fit": "workspace:*"
  }
}
```

Then `pnpm i`. Marker-based discovery picks up the workspace symlink on the next `opensip fit` run.

For a TS-based pack you also need to build (`pnpm -F @your-scope/fit build`) so the `main` field resolves to real JS. The runtime doesn't currently load TypeScript directly; it loads the entry point your `package.json#main` points at.

If you don't have a monorepo, publish your pack to a private npm registry under your own scope and install it as a regular devDependency. The marker still drives discovery — no `packageScopes` config entry needed.

## Migration recipe — loose `.mjs` → workspace pack

A step-by-step you can follow when you've decided to graduate:

1. **Pick the pack name and location.** For a workspace-only pack, `@your-scope/fit` works. For a publishable pack, use your own scope and pick one of the [discovery paths](#discovery-paths) above.
2. **Add the directory as a workspace member.** Append `opensip-cli/*` to your `pnpm-workspace.yaml` (or yarn/npm equivalent).
3. **Write `package.json`** with `opensipTools.kind: "fit-pack"`, `main: "./dist/index.js"`, peer-dep on `@opensip-cli/fitness` and `@opensip-cli/core`.
4. **Convert each `.mjs` to a TypeScript module.** One `<slug>.ts` per check under `src/checks/`, each exporting a `defineCheck(...)` object. **Keep the same slug values** as the loose files used — recipes select by tag/slug, and `--check <slug>` invocations keep working across the move.
5. **Create `src/register-checks.ts`** that imports every check and exports `allChecks` as a `readonly Check[]`.
6. **Create `src/index.ts`** that folds the per-pack display map onto `allChecks` via `applyCheckDisplay` and exports the result as `checks`.
7. **Add the pack as a root devDependency.** pnpm will symlink it into `node_modules/` where marker discovery finds it.
8. **Delete the original loose `.mjs` files** under `opensip-cli/fit/checks/` once the workspace pack is running cleanly and the same slugs are firing.

**Recipes during the move.** A recipe that lived at `opensip-cli/fit/recipes/<name>.mjs` can either stay there (the platform's project-local recipe walker continues to load it from the reserved path) or move into the pack as `src/recipes/<name>.ts` and be re-exported through `index.ts` alongside `checks`. Moving it into the pack is the cleaner end-state — single source of truth, versioned with the checks it references — but doing so is optional and can happen after the check migration lands.

## Reference example

The opensip codebase uses this pattern at production scale. The split is visible directly in the public layout:

- [`packages/fitness/checks-typescript/`](https://github.com/opensip-ai/opensip-cli/tree/main/packages/fitness/checks-typescript) — TypeScript-specific checks under `src/checks/<category>/`, category barrels, and a thin `src/index.ts` public surface.
- [`packages/fitness/checks-universal/`](https://github.com/opensip-ai/opensip-cli/tree/main/packages/fitness/checks-universal) — cross-language checks using the same category-barrel and display-map pattern.

Either is a working reference for the pattern when graduating your own pack.

## Publish + consume

```bash
# In your pack:
npm publish --access public      # or wire it up to GitHub OIDC trusted publishing

# In a consuming project:
opensip plugin add @my-co/checks-internal
```

`plugin add` installs to `<project>/opensip-cli/.runtime/plugins/fit/node_modules/` and appends to `plugins.fit:` in `opensip-cli.config.yml`. Next `opensip fit` run, your checks load.

## Testing

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

For a tighter unit test, call the analyzer directly — `defineCheck` keeps the original `analyze`/`analyzeAll`/`command` callable on the source module, so a unit test imports that function and feeds it a string of source code.

## Where to go next

| You want to … | Go to … |
|---|---|
| Understand the platform side: pack contract, scope filters, discovery internals | [Check pack architecture](/docs/opensip-cli/50-extend/04-check-pack-architecture/) |
| Author a Tool with its own subcommand | [Full Tool plugins](/docs/opensip-cli/50-extend/06-full-tool-plugins/) |
| Walk the monorepo adoption flow end-to-end | [Adopt in a monorepo](/docs/opensip-cli/60-guides/04-adopt-in-a-monorepo/) |
| Browse all 151 built-in checks for inspiration | [Checks reference](/docs/opensip-cli/70-reference/05-checks-index/) |
