---
status: current
last_verified: 2026-06-07
release: v0.2.1
title: "Targets and scope"
audience: [contributors, plugin-authors]
purpose: "How the framework decides which files a check runs against. Targets, scope, glob expansion, and the marketplace shape."
source-files:
  - packages/fitness/engine/src/targets/types.ts
  - packages/fitness/engine/src/targets/loader.ts
  - packages/targeting/src/resolve.ts
  - packages/fitness/engine/src/targets/target-registry.ts
  - packages/fitness/engine/src/framework/scope-resolver.ts
  - packages/fitness/engine/src/framework/path-matcher.ts
  - packages/fitness/engine/src/framework/file-type-filter.ts
related-docs:
  - ./01-recipes-and-checks.md
  - ./03-ignore-directives.md
  - ../50-extend/05-language-adapters.md
  - ../70-reference/03-configuration.md
---
# Targets and scope

A check produces violations against files. The set of files is computed at run time from three things: the project's *targets*, the check's *scope*, and the global *exclusions*. This doc walks the resolution.

> **What you'll understand after this:**
> - The four ways a check can declare what files it cares about.
> - How a target's `languages`/`concerns` match a check's scope.
> - How `globalExcludes` and per-check overrides interact.
> - Why targets exist instead of just glob patterns inline.

---

## The two sides of the matching problem

A polyglot project has many file kinds. A check has one purpose. The matching problem is: given a project and a check, which files does this check inspect?

The naive answer is "the check declares its own globs": `include: ['services/api/**/*.ts'], exclude: ['**/*.test.ts']`. That works in a single project; it doesn't work for a marketplace check pack. A pack like `@opensip-cli/checks-typescript` doesn't know your project's directory layout — it can't hardcode `services/api/`.

So opensip-cli splits the declaration:

- **The project** declares *targets*. "I have a `backend` directory at `services/api/**/*.ts`. I have a `tests` directory at `**/*.test.ts`. I have an `infra` directory at `infra/**/*.ts`."
- **The check** declares *scope* — semantic, not literal. "I apply to TypeScript backend code." It doesn't know the project's globs; it knows what kind of code it's for.
- **The framework** matches scopes to targets at run time, expands globs, applies exclusions, and produces the file list.

This is the marketplace shape. A check author writes `scope: { languages: ['typescript'], concerns: ['backend'] }` once and the same check runs in your project (`services/api/`), my project (`apps/server/`), and a third project that hasn't been written yet.

---

## How a check declares its files

Four mechanisms, in order of preference:

### 1. `scope:` — semantic (preferred)

```ts
defineCheck({
  // ...
  scope: {
    languages: ['typescript'],
    concerns: ['backend'],
  },
});
```

The framework finds every target whose `languages` overlaps `['typescript']` *and* whose `concerns` overlaps `['backend']`. Empty arrays mean "match any" — `scope: { languages: [], concerns: [] }` is the universal scope (the shape used by every check in `@opensip-cli/checks-universal`).

This is the recommended shape for marketplace check packs.

### 2. `fileTypes:` — extension-based

```ts
defineCheck({
  // ...
  fileTypes: ['ts', 'tsx'],
});
```

The framework filters the matched file list to files with these extensions. Layered on top of `scope:` — if both are set, both apply. Useful when a check's scope is broader than what the file extensions imply (e.g. an `architecture` check that should still only run against TypeScript files).

### 3. Per-check target override (config-side)

```yaml
# opensip-cli.config.yml
checkOverrides:
  no-console-log: backend
  no-todos: ['backend', 'frontend']
```

A user can pin a check to a specific target by slug, regardless of what the check declared. This is the escape hatch when a third-party check's scope doesn't match your project's reality. `checkOverrides` is a top-level key alongside `targets:` and `globalExcludes:`. Lives in [`TargetsConfig.checkOverrides`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/fitness/engine/src/targets/types.ts).

### 4. No declaration at all

A check that declares neither `scope:` nor `fileTypes:` matches *every* file the targets registry resolves to. That's almost never what you want — most checks should declare scope. The framework permits it for genuinely cross-cutting checks (e.g. "every package has a README"), where the matched files are the targets' own and not language-specific.

---

## Anatomy of a target

The shape lives in [`packages/fitness/engine/src/targets/types.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/fitness/engine/src/targets/types.ts):

```ts
interface TargetConfig {
  readonly name: string;                      // kebab-case, e.g. 'backend'
  readonly description: string;
  readonly include: readonly string[];        // globs (rooted at project)
  readonly exclude: readonly string[];        // globs subtracted from include
  readonly context?: readonly string[];       // doc paths shown to assessment runs
  readonly tags?: readonly string[];          // free-form
  readonly languages?: readonly string[];     // 'typescript' | 'rust' | ...
  readonly concerns?: readonly string[];      // 'backend' | 'frontend' | 'infra' | ...
}
```

A target answers two questions:

1. **What files are in it?** (`include` minus `exclude`.)
2. **What kinds of code does it represent?** (`languages` and `concerns` — the semantic dimensions.)

The first is for execution; the second is for matching.

### Example: the `acme-api` targets

`globalExcludes` is a top-level key alongside `targets:`; targets are a map of kebab-case name → definition (no separate `registry:` wrapper):

```yaml
globalExcludes:
  - '**/node_modules/**'
  - '**/dist/**'
  - '**/.next/**'

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
    description: AWS CDK stack
    include: ['infra/**/*.ts']
    exclude: ['infra/**/*.test.ts']
    languages: ['typescript']
    concerns: ['infrastructure']

  tests:
    description: All test files
    include: ['**/*.test.ts', '**/*_test.py']
    languages: ['typescript', 'python']
    concerns: ['tests']
```

Now a check with `scope: { languages: ['typescript'], concerns: ['backend'] }` matches `backend` (overlap on `typescript`+`backend`). It does *not* match `infra` (different concern) or `tests` (different concern). It does *not* match `pipelines` (different language).

A universal check with `scope: { languages: [], concerns: [] }` matches all four targets.

---

## How the resolution actually runs

[`packages/fitness/engine/src/framework/scope-resolver.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/fitness/engine/src/framework/scope-resolver.ts) is where it happens. The flow:

```
1. Load TargetsConfig from opensip-cli.config.yml.
2. Pre-glob every target's include patterns once, producing a
   pattern → matched-paths map. This avoids re-running the same
   glob multiple times when targets share patterns.
3. Per check:
     a. If checkOverrides[slug] is set → use those target names.
     b. Else, find every target whose languages overlap check.scope.languages
        AND concerns overlap check.scope.concerns (empty arrays = match-any).
     c. Combine the matched targets' file lists; deduplicate.
     d. Apply target-level excludes (already applied during pre-glob).
     e. Apply globalExcludes from TargetsConfig.
     f. If check.fileTypes is set, filter to those extensions.
4. Hand the resolved list to the check's ExecutionContext.
```

Pre-globbing is the optimization that makes resolution fast on large repos. With ~50 targets and ~100 checks, naive resolution would run the same glob hundreds of times. Pre-globbing runs each unique pattern once and reuses the results.

The `COMMON_IGNORE` set inside the resolver always includes `node_modules`, `dist`, and `.git` to keep glob traversal bounded — a misconfigured target that accidentally includes `**/*` won't blow up.

---

## Global excludes

`globalExcludes` is the top-level project-wide subtractor (it sits at the root of `opensip-cli.config.yml`, not under `targets:`). Every target's resolved file list passes through it. Common entries:

```yaml
globalExcludes:
  - '**/node_modules/**'
  - '**/dist/**'
  - '**/build/**'
  - '**/.next/**'
  - '**/.turbo/**'
  - '**/coverage/**'
  - '**/__snapshots__/**'
  - '**/*.generated.ts'
```

Use this rather than repeating the same exclusions on every target. The historical `.fitnessignore` file from earlier versions has been retired — `globalExcludes` replaces it.

---

## The `PathMatcher`

[`packages/fitness/engine/src/framework/path-matcher.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/fitness/engine/src/framework/path-matcher.ts) is the per-check matcher object. It compiles include/exclude globs once and answers `match(filePath)` queries with a single pass through the compiled `Minimatch` instances.

You won't usually instantiate one. The framework constructs it for each check inside `executeUnifiedCheck()` and exposes `ctx.matchFiles()` to the check. If you're writing an `analyzeAll`-mode check that needs additional filtering on top of the resolved file list, the matcher is available via `check.getMatcher(cwd)`.

---

## Where the example lands

For `acme-api` running the default recipe:

1. The framework loads four targets (`backend`, `pipelines`, `infra`, `tests`) and pre-globs all four. ~250 TypeScript files, ~80 Python files, ~30 infra TypeScript files, ~150 test files. (Some overlap with `tests` and `backend` — deduplicated.)
2. For `no-console-log` (`scope: { languages: ['typescript'], concerns: ['backend'] }`), only the `backend` target matches. The 47-file resolved list excludes `services/api/**/*.test.ts` (target exclude) and anything under `services/api/dist/` (`globalExcludes`).
3. For `cyclomatic-complexity` from the universal pack (`scope: { languages: [], concerns: [] }`), all four targets match. The combined list is ~510 files (deduplicated).
4. For `no-print-outside-pipelines` (a custom check declaring `scope: { languages: ['python'], concerns: ['data-pipeline'] }` plus `checkOverrides.no-print-outside-pipelines: ['pipelines']` for explicitness), only the `pipelines` target matches.

Each resolved list is passed to its check's `ExecutionContext.matchFiles()`. The check iterates and produces signals.

---

## Why this is targets-as-data and not targets-as-code

Targets could have been a programmable API: `defineTarget({ name: 'backend', includes: () => ... })`. They're declarative YAML instead, deliberately:

1. **Configurability.** A user can add a target without writing code. A target is a glob set with metadata — no need for a `.ts` file.
2. **Auditable.** A reviewer reading a PR sees `services/api/**/*.ts` in the YAML. They don't have to chase a function call.
3. **Tool-agnostic.** A future linter integration, IDE plugin, or coverage tool could read the same `targets:` section to know what counts as "backend code." The data isn't locked in TypeScript.

The trade-off: complex targets (e.g. "include any file in a directory that has a `Dockerfile`") aren't expressible. For those, write an `analyzeAll`-mode check that does its own filtering — the targets layer is for the common case.

---

## What's next

- **[`03-ignore-directives.md`](/docs/opensip-cli/20-fit/03-ignore-directives/)** — inline source-level suppression that survives the resolver and lands in the framework's filter step.
- **[`04-output-gate-sarif.md`](/docs/opensip-cli/20-fit/04-output-gate-sarif/)** — what happens to the violations a check produces.
- **[`../50-extend/05-language-adapters.md`](/docs/opensip-cli/50-extend/05-language-adapters/)** — how a check's `contentFilter` setting dispatches through a per-language adapter.
- **[`../70-reference/03-configuration.md`](/docs/opensip-cli/70-reference/03-configuration/)** — the full `targets:` schema in `opensip-cli.config.yml`.
