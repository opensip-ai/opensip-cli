---
status: current
last_verified: 2026-06-07
release: v2.8.0
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
  - packages/fitness/engine/src/plugins/check-package-discovery.ts
  - packages/core/src/plugins/marker-discovery.ts
  - packages/core/src/plugins/types.ts
related-docs:
  - ./05-language-adapters.md
  - ../20-fit/01-recipes-and-checks.md
  - ../50-extend/01-plugin-authoring.md
  - ../70-reference/02-package-catalog.md
---
# Check pack architecture

A check pack is an npm package that contributes one or more `Check` objects. Seven pack packages ship today; an arbitrary number of third-party packs can be added by `plugin add`, by declaring `opensipTools.kind: "fit-pack"` in `package.json`, or by exact name in `plugins.checkPackages`. The pack contract is simple, the marketplace shape is intentional, and the discovery layer (covered in [`80-implementation/02-plugin-loader.md`](/docs/opensip-tools/80-implementation/02-plugin-loader/)) takes care of the rest.

> **What you'll understand after this:**
> - The `FitPluginExports` shape every pack implements.
> - The seven bundled packs and what each contains.
> - How scope filters keep checks from running on the wrong files.
> - The pattern for parameterizing a check from the recipe layer.
> - The author's pattern for shipping a third-party pack.

---

## The pack contract

A check pack's main entry implements the `FitPluginExports` contract — one required export and two optional ones:

```ts
// packages/fitness/checks-universal/src/index.ts
import type { Check, CheckDisplayEntry, FitnessRecipe } from '@opensip-tools/fitness';

export const checks: readonly Check[];                                     // required
export const checkDisplay?: Readonly<Record<string, CheckDisplayEntry>>;   // optional
export const recipes?: readonly FitnessRecipe[];                           // optional
```

`Check`, `CheckDisplayEntry`, and `FitnessRecipe` all live in `@opensip-tools/fitness` — the kernel doesn't know about checks or fitness display vocabulary. `CheckDisplayEntry` was moved out of the kernel and is owned by fitness (ADR-0009); check packs import it from `@opensip-tools/fitness`.

`checks` is the flat list of every `defineCheck()` result the pack provides (the only required export). `checkDisplay` is an optional map from slug → `[icon, displayName]` that the CLI uses for table rendering and dashboard grouping; slugs without an entry fall back to kebab-to-title-case. `recipes` is an optional list of `defineRecipe()` results the pack bundles. There is **no** `metadata` export — package name and version come from the pack's `package.json`.

Plus a discoverable package.json shape:

```json
{
  "name": "@opensip-tools/checks-universal",
  "opensipTools": { "kind": "fit-pack" },
  "main": "dist/index.js"
}
```

Discovery uses **two paths**, both run on every fit invocation; results are merged and deduplicated by package name:

- **Marker** — any package whose `package.json` declares `opensipTools.kind: "fit-pack"` is discovered regardless of npm scope or name pattern. This is the canonical path for first-party and third-party packs.
- **Explicit list** — `plugins.checkPackages:` in `opensip-tools.config.yml` names packages by exact name. Use for packages that do not declare the marker yet. Marker discovery still runs alongside it.

See [`80-implementation/02-plugin-loader.md`](/docs/opensip-tools/80-implementation/02-plugin-loader/) for the resolution rules.

The [`collectCheckObjects`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.1/packages/fitness/engine/src/framework/check-types.ts) helper (re-exported from `@opensip-tools/fitness`) walks a barrel's exports recursively, narrowing each value to a `Check` via `isCheck` and deduplicating by reference. Each pack's `src/index.ts` calls it on `allChecks` (the re-export of `src/checks/index.ts`) so new checks are picked up by simply re-exporting them from the category barrel — no central registration list to update.

---

## The seven bundled packs

| Pack | Path | Scope |
|---|---|---|
| `@opensip-tools/checks-universal` | `packages/fitness/checks-universal/` | Cross-language checks (text/regex/file shape), e.g. file-length, TODO scanners, security secret detection. ~90 checks. |
| `@opensip-tools/checks-typescript` | `packages/fitness/checks-typescript/` | TypeScript-specific: complex-function via AST, dead-code detection, dependency rules, react/hook patterns. ~50 checks. |
| `@opensip-tools/checks-python` | `packages/fitness/checks-python/` | Python-specific. Today ships `no-bare-except`. |
| `@opensip-tools/checks-java` | `packages/fitness/checks-java/` | Java-specific. Today ships `no-printstacktrace`. |
| `@opensip-tools/checks-go` | `packages/fitness/checks-go/` | Go-specific. Today ships `no-fmt-print`. |
| `@opensip-tools/checks-cpp` | `packages/fitness/checks-cpp/` | C/C++ via clang-tidy passthrough (`clang-tidy-passthrough`). |
| `@opensip-tools/checks-rust` | `packages/fitness/checks-rust/` | Rust-specific. Today ships `rust-no-dbg-macro`. |

The per-language packs are intentionally minimal at v2.0 — one canonical check each, exercised by the per-language CI fixtures and by the language adapters' integration tests. They expand as patterns prove worth standardizing across teams.

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
import { getCheckConfig } from '@opensip-tools/fitness';

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

## The display map

The `CHECK_DISPLAY` map ([`packages/fitness/checks-universal/src/display/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.1/packages/fitness/checks-universal/src/display/index.ts) and analogues) maps a check slug to `[icon, displayName]`:

```ts
export const CHECK_DISPLAY: Record<string, CheckDisplayEntry> = {
  'no-console-log': ['🚫', 'No console.log'],
  'complex-function': ['📊', 'Complex function'],
  // ...
};
```

The icon is shown in the results table; the display name is the human-readable label in the dashboard. Without an entry, the renderer falls back to kebab-to-title-case (`'no-console-log' → 'No Console Log'`) — fine, but less pleasant than the curated form.

The CLI merges every loaded pack's `checkDisplay` into one registry. Last loader wins on key collision, mirroring the pack-load order. A third-party pack can override a first-party check's display by registering the same slug in its own `checkDisplay`.

This is *display only* — overriding a slug's display doesn't override the check itself. To replace a built-in check, the third-party pack registers a check with the same slug; the framework's last-writer-wins registry takes over.

---

## How discovery actually finds a pack

The chain:

1. The user runs `opensip-tools plugin add @my-co/checks-internal`.
2. The CLI's `plugin add` command runs `npm install` into `<project>/opensip-tools/.runtime/plugins/fit/` and appends `@my-co/checks-internal` to `plugins.fit:` in `opensip-tools.config.yml`.
3. On the next `opensip-tools fit` run, the fitness Tool's `ensureChecksLoaded()` calls into the discoverer.
4. The discoverer reads `plugins.fit:`, walks `.runtime/plugins/fit/node_modules/`, finds `@my-co/checks-internal/`, and dynamically imports its main entry.
5. The pack's `checks` export is registered into the in-memory check registry; its optional `checkDisplay` is merged into the display registry and its optional `recipes` into the recipe registry.
6. Recipes that select these checks (by tag, slug, or `all`) now run them.

No CLI restart, no kernel change. The whole shape is a marketplace.

---

## What you ship in a third-party pack

Minimum viable pack:

```
@my-co/checks-internal/
├── package.json                # opensipTools.kind: 'fit-pack' (or pinned in config)
├── dist/index.js               # exports: checks (+ optional checkDisplay, recipes)
└── README.md                   # author affordance
```

```ts
// dist/index.js
import { defineCheck } from '@opensip-tools/fitness';

const noTodoBeforeDeploy = defineCheck({
  id: 'a1b2c3d4-...',
  slug: 'no-todo-before-deploy',
  description: 'Reject TODOs in files modified after the freeze date',
  tags: ['quality', 'release'],
  scope: { languages: [], concerns: [] },
  // ...
});

export const checks = [noTodoBeforeDeploy];
export const checkDisplay = { 'no-todo-before-deploy': ['⏰', 'No TODO before deploy'] };
```

Package name and version come from the pack's `package.json` — there is no `metadata` export to maintain in lockstep.

Peer-depend on `@opensip-tools/fitness` and `@opensip-tools/core` so a project at any compatible major version can install your pack:

```json
{
  "peerDependencies": {
    "@opensip-tools/fitness": "^2.0.0",
    "@opensip-tools/core": "^2.0.0"
  }
}
```

Publish to npm, install via `plugin add`, ship.

For the full walkthrough — boilerplate, testing, publishing — see [`50-extend/01-plugin-authoring.md`](/docs/opensip-tools/50-extend/01-plugin-authoring/).

---

## Required: pass/fail fixtures

Every shipped check must prove **both directions** — that it fires on bad code
*and* stays silent on clean code — or CI fails. Each first-party check pack runs
a `fixture-coverage.test.ts` meta-test (built on
`@opensip-tools/fitness/internal`) that, for every shipped check, loads a clean
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
> `@opensip-tools/fitness/internal` for a one-line per-check assertion.

---

## Where the example lands

`acme-api`'s loaded check inventory:

- `@opensip-tools/checks-universal` — file-length-limit, no-todo-comments, no-hardcoded-secrets, the cyclomatic complexity check, …
- `@opensip-tools/checks-typescript` — circular-import detection, no-default-export-in-routes, the typescript-specific patterns.
- `@opensip-tools/checks-python` — `no-bare-except`.
- Project-local `<project>/opensip-tools/fit/checks/` — three custom checks.

The dashboard groups by category (universal pack's display map provides the icons), shows pack-of-origin in the verbose view, and highlights checks with project-level overrides. The CLI's `fit-list` command shows the full inventory: 155 checks across the bundled packs, source-tagged.

---

## What's next

- **[`../10-concepts/05-architecture-gate.md`](/docs/opensip-tools/10-concepts/05-architecture-gate/)** — the regression-detection workflow built on top of check output.
- **[`../50-extend/01-plugin-authoring.md`](/docs/opensip-tools/50-extend/01-plugin-authoring/)** — full walkthrough of authoring a pack from scratch.
- **[`../70-reference/02-package-catalog.md`](/docs/opensip-tools/70-reference/02-package-catalog/)** — every pack's package, key exports, layer.
