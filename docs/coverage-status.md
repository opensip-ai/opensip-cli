# Coverage Status

Snapshot taken 2026-05-14 against v3.0.0.

## Per-package coverage

| Package | Stmts | Branch | Funcs | Lines | Status |
|---|---:|---:|---:|---:|---|
| `@opensip-tools/cli-shared` | 99.5 | 98.6 | 100 | 99.5 | ✅ |
| `@opensip-tools/core` | 94.7 | 89.4 | 98.7 | 94.7 | ✅ |
| `@opensip-tools/lang-typescript` | 92.7 | 89.8 | 86.2 | 92.7 | ✅ |
| `@opensip-tools/lang-rust` | 83.3 | 85.7 | 87.5 | 83.3 | close |
| `@opensip-tools/lang-go` | 90.2 | 86.3 | 87.5 | 90.2 | ✅ |
| `@opensip-tools/lang-python` | 92.3 | 84.9 | 91.7 | 92.3 | ✅ |
| `@opensip-tools/lang-java` | 93.2 | 85.5 | 87.5 | 93.2 | ✅ |
| `@opensip-tools/lang-cpp` | 93.8 | 82.1 | 88.9 | 93.8 | ✅ |
| `@opensip-tools/checks-go` | 100 | 100 | 50 | 100 | ✅ |
| `@opensip-tools/checks-python` | 100 | 100 | 50 | 100 | ✅ |
| `@opensip-tools/checks-java` | 100 | 100 | 50 | 100 | ✅ |
| `@opensip-tools/checks-cpp` | 100 | 84.6 | 50 | 100 | ✅ |
| `@opensip-tools/fitness` | 83.1 | 81.9 | 88.8 | 83.1 | close |
| `@opensip-tools/simulation` | 51.0 | 69.8 | 57.1 | 51.0 | gap |
| `@opensip-tools/checks-typescript` | 44.6 | 58.7 | 43.9 | 44.6 | gap |
| `@opensip-tools/checks-universal` | 60.5 | 65.7 | 62.6 | 60.5 | gap |
| `@opensip-tools/cli` | 0 | 0 | 0 | 0 | not measured |

## What 50% function coverage means for `checks-*`

The single-check language packs (go, python, java, cpp) report 50%
function coverage despite 100% statement coverage. This is correct: the
unit tests exercise the pure `analyze` / `parse` functions exhaustively,
but the `Check` object built by `defineCheck()` carries closures
(`run`, `getMatcher`, `getScope`) that are only invoked by the fitness
framework during a real `fit` run — never in unit tests. Those closures
are exercised end-to-end by the CLI's e2e suite.

## Fitness — substantially covered (83%)

Direct unit tests now drive the orchestrator:

- **`recipes/service.ts`** (89%) — `service.test.ts` exercises start /
  abort / disabledChecks / includeViolations / onCheckStart-Complete-
  Catalog callbacks / explicit + tags + all selectors / sequential
  execution / error containment / `createAdHocRecipe`. Covers parallel
  and sequential paths.
- **`framework/file-cache.ts`** (94%) — file-cache.test.ts
- **`framework/file-accessor.ts`** (99%) — file-accessor.test.ts
- **`framework/path-matcher.ts`** (96%) — path-matcher.test.ts
- **`framework/define-check.ts`** (65%) — analyze + analyzeAll +
  command modes via define-check.test.ts
- **`framework/result-builder.ts`** (100%)
- **`framework/severity-mapping.ts`** (100%)
- **`framework/strip-literals.ts`** (90%) — strip-literals.test.ts
- **`framework/ast-utilities.ts`** (100%)
- **`framework/scope-resolver.ts`** (79%) — scope-resolver.test.ts
- **`framework/command-executor.ts`** (79%) — command-executor.test.ts
  (skips the bin-not-found and unexpected-exit-code paths via real shell)
- **`framework/register-helpers.ts`** (100%)
- **`recipes/registry.ts`** (100%)
- **`recipes/built-in-recipes.ts`** (100%)
- **`recipes/check-resolution.ts`** (96%)
- **`recipes/retry.ts`** (100%)
- **`signalers/loader.ts`** (100%)
- **`targets/loader.ts`** (94%)
- **`targets/resolver.ts`** (100%)
- **`targets/target-registry.ts`** (100%)
- **`gate.ts`** (99%), **`sarif.ts`** (53% — render path tested via e2e)

What's left in fitness (the remaining 17%):
- `framework/cacheable-exec.ts` — caches external command output;
  exercised end-to-end by the e2e suite when a command-mode check runs
- `framework/ignore-processing.ts` — `@fitness-ignore-*` directive
  application; exercised via the directive-inventory tests + e2e
- `framework/directive-parsing.ts` — the parser is partially covered
- `recipes/parallel-execution.ts` / `sequential-execution.ts` /
  `callback-processor.ts` — exercised through the FitnessRecipeService
  tests but with all callback variants the coverage isn't 100%

## Simulation gaps

Simulation is the experimental tool. Recipes framework (the v3
addition) is at 100%. The kind-specific `define`/`executor` files for
`load`, `chaos`, `invariant`, and `fix-evaluation` carry partial
coverage — most paths run via the `define-*.test.ts` files, but the
full execution engine (`framework/execution/orchestration-engine.ts`,
`assertion-handlers.ts`) is dedicated experimental code without
production users yet. A scenario harness will land alongside the first
production scenario.

## Check pack gaps

`checks-typescript` (66 checks) and `checks-universal` (88 checks) now
have parametric coverage tests (`all-checks-execute.test.ts`) that drive
every check's `run()` method against a curated fixture corpus. This
exercises the analyze paths each check declares, lifting coverage from
25%/33% to 44%/60%.

The remaining gap is content-specific: each check has detection branches
that fire only on very specific code patterns (e.g. drizzle-orm table
definitions with `.primaryKey()`, React effect hooks with stale-deps,
etc.). To reach 90% per pack, each check needs a dedicated fixture.
The follow-on work is incremental — every new check should ship with
a per-check fixture file.

The checks are also exercised end-to-end:
- The DART parity scan runs 121 of these checks against real source
  on every commit. Detection regressions surface there.
- `e2e.test.ts` runs `fit --recipe quick-smoke` and `fit --check
  no-console-log`, which load and execute checks through the full
  framework path.

## How to run coverage

```bash
# One package
pnpm --filter=@opensip-tools/<name> exec vitest run --coverage

# All packages
for p in cli-shared core fitness simulation checks-typescript \
         checks-universal checks-go checks-python checks-java \
         checks-cpp lang-typescript lang-rust lang-go lang-python \
         lang-java lang-cpp; do
  pnpm --filter=@opensip-tools/$p exec vitest run --coverage \
    2>&1 | grep "All files"
done
```

Coverage uses v8 (built into Node 22). No additional install needed.
