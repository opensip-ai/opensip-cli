---
status: current
last_verified: 2026-06-14
release: v0.1.18
title: "Check pack architecture"
audience: [contributors, plugin-authors]
purpose: "How check packs are structured, the bundled seven, scope filters, parameterization, and the marketplace shape."
source-files:
  - packages/fitness/checks-universal/src/index.ts
  - packages/fitness/checks-typescript/src/index.ts
  - packages/fitness/checks-python/src/index.ts
  - packages/fitness/checks-java/src/index.ts
  - packages/fitness/checks-go/src/index.ts
  - packages/fitness/checks-cpp/src/index.ts
  - packages/fitness/checks-rust/src/index.ts
  - packages/fitness/engine/src/cli/fit/check-loader.ts
  - packages/config/src/capability-preferences.ts
  - packages/core/src/plugins/marker-discovery.ts
  - packages/core/src/plugins/types.ts
related-docs:
  - ./05-language-adapters.md
  - ../20-fit/01-recipes-and-checks.md
  - ../50-extend/01-plugin-authoring.md
  - ../70-reference/02-package-catalog.md
---
# Check pack architecture

A check pack is an npm package that contributes one or more `Check` objects. Seven pack packages ship today; an arbitrary number of third-party packs can be added by `opensip fit plugin add`, by declaring the `fit-pack` marker plus target-domain epoch in `package.json`, or by exact name in `plugins.checkPackages`. The pack contract is simple, the marketplace shape is intentional, and the discovery layer (covered in [`80-implementation/02-plugin-loader.md`](../80-implementation/02-plugin-loader.md)) takes care of the rest.

> **What you'll understand after this:**
> - The `FitPluginExports` shape every pack implements.
> - The seven bundled packs and what each contains.
> - How scope filters keep checks from running on the wrong files.
> - The pattern for parameterizing a check from the recipe layer.
> - The author's pattern for shipping a third-party pack.

---

## The pack contract

A check pack's main entry implements the `FitPluginExports` contract — one required export and one optional one:

```ts
// packages/fitness/checks-universal/src/index.ts
import type { Check, FitnessRecipe } from '@opensip-cli/fitness';

export const checks: readonly Check[];              // required
export const recipes?: readonly FitnessRecipe[];    // optional
```

`Check` and `FitnessRecipe` live in `@opensip-cli/fitness` — the kernel doesn't know about checks or fitness vocabulary.

`checks` is the flat list of every `defineCheck()` result the pack provides (the only required export). `recipes` is an optional list of `defineRecipe()` results the pack bundles (co-discovered through the same package walk and routed to fitness's recipe domain). There is **no** `checkDisplay` export and **no** `metadata` export — display travels ON each check, and package name + version come from the pack's `package.json`.

**Display (icon + name) travels on the check (§5.3).** Each check carries optional `config.icon` and `config.displayName`. Set them directly in `defineCheck({ ..., icon: '🔒', displayName: 'No Hardcoded Secrets' })`, or keep a per-pack `CHECK_DISPLAY` authoring map (`slug → [icon, displayName]`) and fold it onto the pack's checks at the barrel with `applyCheckDisplay(checks, CHECK_DISPLAY)` (exported from `@opensip-cli/fitness`). Slugs with no display fall back to kebab-to-title-case + a default icon. There is no merged-display registry; the CLI/dashboard read `check.config.displayName`/`icon` from the per-run check registry.

Plus a discoverable package.json shape:

```json
{
  "name": "@opensip-cli/checks-universal",
  "opensipTools": {
    "kind": "fit-pack",
    "targetDomain": "fit-pack",
    "targetDomainApiVersion": 1
  },
  "main": "dist/index.js"
}
```

Discovery uses **two paths**, both run on every fit invocation; results are merged and deduplicated by package name:

- **Marker** — any package whose `package.json` declares `opensipTools.kind: "fit-pack"`, `targetDomain: "fit-pack"`, and a numeric `targetDomainApiVersion` is discovered regardless of npm scope or name pattern. This is the canonical path for first-party and third-party packs.
- **Explicit list** — `plugins.checkPackages:` in `opensip-cli.config.yml` names packages by exact name. Use for packages that do not declare the marker yet. Marker discovery still runs alongside it.

See [`80-implementation/02-plugin-loader.md`](../80-implementation/02-plugin-loader.md) for the resolution rules.

The [`collectCheckObjects`](../../../packages/fitness/engine/src/framework/check-types.ts) helper (re-exported from `@opensip-cli/fitness`) walks a barrel's exports recursively, narrowing each value to a `Check` via `isCheck` and deduplicating by reference. Each pack's `src/index.ts` calls it on `allChecks` (the re-export of `src/checks/index.ts`) so new checks are picked up by simply re-exporting them from the category barrel — no central registration list to update.

---

## The seven bundled packs

| Pack | Path | Scope |
|---|---|---|
| `@opensip-cli/checks-universal` | `packages/fitness/checks-universal/` | Cross-language checks (text/regex/file shape), e.g. file-length, TODO scanners, security secret detection. 108 checks. |
| `@opensip-cli/checks-typescript` | `packages/fitness/checks-typescript/` | TypeScript-specific: complex-function via AST, dead-code detection, dependency rules, react/hook patterns. 52 checks. |
| `@opensip-cli/checks-python` | `packages/fitness/checks-python/` | Python-specific. Today ships 2 checks. |
| `@opensip-cli/checks-java` | `packages/fitness/checks-java/` | Java-specific. Today ships `no-printstacktrace`. |
| `@opensip-cli/checks-go` | `packages/fitness/checks-go/` | Go-specific. Today ships `no-fmt-print`. |
| `@opensip-cli/checks-cpp` | `packages/fitness/checks-cpp/` | C/C++ via clang-tidy passthrough (`clang-tidy-passthrough`). |
| `@opensip-cli/checks-rust` | `packages/fitness/checks-rust/` | Rust-specific. Today ships `rust-no-dbg-macro`. |

The per-language packs vary by maturity: TypeScript has the deepest pack, Python has two checks, and Go/Java/C++/Rust each ship a canonical first-party check. They expand as patterns prove worth standardizing across teams.

Each pack is structured the same way. Inside `src/checks/`, checks live under category directories: `architecture/`, `quality/`, `security/`, `testing/`, `documentation/`, `resilience/`, `performance/`. The categories aren't enforced by the kernel — they're a convention for discoverability.

`checks-universal` is the largest and most actively expanded. The per-language packs grow as language-specific patterns prove worth standardizing.

---

## Scope filters: how a pack stays in its lane

A check that scans for `console.log` shouldn't run on `.py` files. A check that detects Python's mutable-default-argument anti-pattern shouldn't run on `.ts` files. Scope filters are how the framework enforces that.

A check declares its `scope`:

```ts
defineCheck({
  id: '...',
  slug: 'no-print',
  description: 'No print() outside designated areas',
  tags: ['python', 'quality'],
  scope: { languages: ['python'], concerns: [] },
  fileTypes: ['py'],
  // ...
});
```

At resolution time, the framework finds every target whose `languages` overlaps `['python']` and unions their file lists. Then `fileTypes: ['py']` is the second filter — only `.py` files survive. A target that contains a mix of `.py` and `.sql` files would have its `.sql` files filtered out at this step.

Universal packs use the empty-arrays form:

```ts
scope: { languages: [], concerns: [] }
```

Empty arrays mean "match any." A target's `languages: ['typescript']` overlaps `[]` (vacuously); the same for concerns. So a universal check matches every target.

The double filter (`scope` + `fileTypes`) is deliberate. `scope` is the *semantic* match (this is for backend TypeScript). `fileTypes` is the *physical* match (and only `.ts`/`.tsx` files). A check author writing for a marketplace can declare the semantic match and let projects choose their target globs; an author writing for a single project can pin file types directly.

---

## Parameterization

A check that's worth shipping is often worth parameterizing. The cyclomatic-complexity check ships with a default `maxComplexity: 25` — but a project might want 15, or 50, or different thresholds for different targets.

The pattern: read your slice of the recipe's `config:` map at run time.

```ts
import { getCheckConfig } from '@opensip-cli/fitness';

interface ComplexFunctionConfig {
  readonly maxComplexity?: number;
}

export const complexFunction = defineCheck({
  id: '...',
  slug: 'complex-function',
  description: 'Cap cyclomatic complexity',
  tags: ['quality', 'architecture'],
  scope: { languages: [], concerns: [] },
  analyze: (content, filePath) => {
    const { maxComplexity = 25 } = getCheckConfig<ComplexFunctionConfig>('complex-function');
    // ... use maxComplexity ...
  },
});
```

A recipe overrides:

```ts
defineRecipe({
  name: 'strict',
  // ...
  checks: {
    type: 'all',
    config: {
      'complex-function': { maxComplexity: 15 },
    },
  },
});
```

`getCheckConfig<T>(slug)` returns `T` (or `{}` if no override is set). The default-handling lives in the check itself — `getCheckConfig` doesn't know about defaults. This keeps the parameter semantics owned by the check, not by the recipe runner.

The recipe service projects the `config:` map into module-level state before execution, so `getCheckConfig` is synchronous. This is one of the rare module-level-state patterns in the codebase; it exists because checks are dispatched in parallel and threading the config through every check call would clutter the API.

---

## The display map — folded onto the check

A pack keeps an authoring `CHECK_DISPLAY` map ([`packages/fitness/checks-universal/src/display/index.ts`](../../../packages/fitness/checks-universal/src/display/index.ts) and analogues) of `slug → [icon, displayName]`:

```ts
export const CHECK_DISPLAY: Record<string, CheckDisplayEntry> = {
  'no-console-log': ['🚫', 'No console.log'],
  'complex-function': ['📊', 'Complex function'],
  // ...
};
```

…and folds it ONTO its checks at the barrel (§5.3), so display travels with each check rather than as a separate sidecar:

```ts
import { applyCheckDisplay, collectCheckObjects } from '@opensip-cli/fitness';
export const checks = applyCheckDisplay(collectCheckObjects(allChecks), CHECK_DISPLAY);
```

The icon is shown in the results table; the display name is the dashboard label. A check with no entry keeps no display and the renderer falls back to kebab-to-title-case (`'no-console-log' → 'No Console Log'`) + a default icon. There is no merged-display registry and no separate `checkDisplay` export: `getDisplayName`/`getIcon` resolve a slug against the per-run check registry (`check.config.displayName`/`icon`), so two concurrent runs read independent display. To replace a built-in check (display and all), register a check with the same slug — the framework's last-writer-wins registry takes over.

---

## How discovery actually finds a pack

The chain:

1. The user runs `opensip fit plugin add @my-co/checks-internal` (the `plugin` group is mounted under the `fit` primary, which binds the domain).
2. The CLI's `fit plugin add` command installs the package into `<project>/opensip-cli/.runtime/plugins/fit/` and appends `@my-co/checks-internal` to `plugins.fit:` in `opensip-cli.config.yml`.
3. On the next `opensip fit` run, the fitness Tool's `ensureChecksLoaded()` calls into the discoverer.
4. The discoverer reads `plugins.fit:`, walks `.runtime/plugins/fit/node_modules/`, finds `@my-co/checks-internal/`, and dynamically imports its main entry.
5. The pack's `checks` export is registered into the per-run check registry (each check carrying its folded-on display); its optional `recipes` export is co-routed to the recipe domain.
6. Recipes that select these checks (by tag, slug, or `all`) now run them.

No CLI restart, no kernel change. The whole shape is a marketplace.

---

## What you ship in a third-party pack

Minimum viable pack:

```
@my-co/checks-internal/
├── package.json                # opensipTools.kind: 'fit-pack' + targetDomain epoch (or pinned in config)
├── dist/index.js               # exports: checks (each carrying display) (+ optional recipes)
└── README.md                   # author affordance
```

```ts
// dist/index.js
import { defineCheck } from '@opensip-cli/fitness';

const noTodoBeforeDeploy = defineCheck({
  id: 'a1b2c3d4-...',
  slug: 'no-todo-before-deploy',
  description: 'Reject TODOs in files modified after the freeze date',
  tags: ['quality', 'release'],
  scope: { languages: [], concerns: [] },
  icon: '⏰',
  displayName: 'No TODO before deploy',
  // ...
});

export const checks = [noTodoBeforeDeploy];
```

Package name and version come from the pack's `package.json` — there is no `metadata` export to maintain in lockstep.

Peer-depend on `@opensip-cli/fitness` and `@opensip-cli/core` so a project on any compatible release line can install your pack (while opensip-cli is pre-1.0, `^0.1.0` locks to the `0.1.x` minor line):

```json
{
  "peerDependencies": {
    "@opensip-cli/fitness": "^0.1.18",
    "@opensip-cli/core": "^0.1.18"
  }
}
```

Publish to npm, install via `opensip fit plugin add`, ship.

For the full walkthrough — boilerplate, testing, publishing — see [`50-extend/01-plugin-authoring.md`](../50-extend/01-plugin-authoring.md).

---

## Required: pass/fail fixtures

Every shipped check must prove **both directions** — that it fires on bad code
*and* stays silent on clean code — or CI fails. Each first-party check pack runs
a `fixture-coverage.test.ts` meta-test (built on
`@opensip-cli/fitness/internal`) that, for every shipped check, loads a clean
and a violation fixture and asserts the clean one produces **0** findings for
that check and the violation one produces **≥1**.

Add fixtures co-located with the check, in a `__fixtures__/<slug>/` directory:

```
src/checks/<category>/
  my-check.ts
  my-check.test.ts
  __fixtures__/my-check/
    clean.ts        # 0 findings for my-check
    violation.ts    # >=1 finding for my-check
```

- **Per claimed language.** A check scoped to multiple `languages` needs one
  pair per language (`clean.ts`+`violation.ts`, `clean.py`+`violation.py`, …).
  A multi-extension *file-typed* check needs only one representative pair.
- **Config/docs/metadata checks** use the matching domain — a `package.json`
  check gets `clean.package.json`/`violation.package.json` (set a
  `FILENAME_OVERRIDES` entry), and a check needing sibling files or repo context
  uses `clean/` and `violation/` **directories** holding the minimal project.
- **Command-mode checks** (`analysisMode: 'command'`, e.g. clang-tidy/semgrep
  passthroughs) can't be exercised by a file — list them in
  `COMMAND_EXEMPTIONS` with a reason; they're covered by the packed-smoke lane.
- The `ALLOWLIST` is empty and ratcheted: a new check with no fixtures fails CI.
  A check that genuinely can't be fixture-driven goes in `KNOWN_UNFIXTURABLE`
  with a justification (and ideally a follow-up to fix it).

> **Harness note.** The coverage harness runs each check in-process under a
> minimal scope with no language adapter registered, so the adapter's
> `contentFilter` (string/comment stripping) is a no-op — write the trigger as
> real code and keep the clean fixture free of the trigger token entirely (even
> in comments/strings). The check's own `*.test.ts` covers content-filter
> behavior. First-party authors can call `runCheckOnFixture` from
> `@opensip-cli/fitness/internal` for a one-line per-check assertion.

---

## Where the example lands

`acme-api`'s loaded check inventory:

- `@opensip-cli/checks-universal` — file-length-limit, no-todo-comments, no-hardcoded-secrets, the cyclomatic complexity check, …
- `@opensip-cli/checks-typescript` — circular-import detection, no-default-export-in-routes, the typescript-specific patterns.
- `@opensip-cli/checks-python` — `no-bare-except`.
- Project-local `<project>/opensip-cli/fit/checks/` — three custom checks.

The dashboard groups by category (universal pack's display map provides the icons), shows pack-of-origin in the verbose view, and highlights checks with project-level overrides. The CLI's `fit list` command shows the full inventory: 151 checks across the bundled packs, source-tagged.

---

## What's next

- **[`../10-concepts/05-architecture-gate.md`](../10-concepts/05-architecture-gate.md)** — the regression-detection workflow built on top of check output.
- **[`../50-extend/01-plugin-authoring.md`](../50-extend/01-plugin-authoring.md)** — full walkthrough of authoring a pack from scratch.
- **[`../70-reference/02-package-catalog.md`](../70-reference/02-package-catalog.md)** — every pack's package, key exports, layer.
