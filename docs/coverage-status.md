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
| `@opensip-tools/fitness` | 54.7 | 88.9 | 77.4 | 54.7 | gap |
| `@opensip-tools/simulation` | 51.0 | 69.8 | 57.1 | 51.0 | gap |
| `@opensip-tools/checks-typescript` | 25.2 | 78.6 | 1.1 | 25.2 | gap |
| `@opensip-tools/checks-universal` | 33.0 | 88.5 | 3.3 | 33.0 | gap |
| `@opensip-tools/cli` | 0 | 0 | 0 | 0 | not measured |

## What 50% function coverage means for `checks-*`

The single-check language packs (go, python, java, cpp) report 50%
function coverage despite 100% statement coverage. This is correct: the
unit tests exercise the pure `analyze` / `parse` functions exhaustively,
but the `Check` object built by `defineCheck()` carries closures
(`run`, `getMatcher`, `getScope`) that are only invoked by the fitness
framework during a real `fit` run — never in unit tests. Those closures
are exercised end-to-end by the CLI's e2e suite.

## Fitness gaps

The fitness engine sits at 54.7% because the orchestration layer is
extensively tested via the e2e suite (which the per-package coverage
report cannot see). Specifically not unit-tested:

- `recipes/service.ts` (recipe execution orchestrator)
- `recipes/parallel-execution.ts` / `sequential-execution.ts`
- `recipes/callback-processor.ts`
- `framework/command-executor.ts` (shells out)
- `framework/cacheable-exec.ts` (caches command results)
- `framework/ignore-processing.ts` (directive filtering)
- `framework/severity-resolver.ts` (per-check severity overrides)
- `definitions/dump-literals.ts` (dump-format diagnostics)
- `framework/ast-utilities.ts` (legacy framework AST helpers)

These are exercised by `packages/cli/src/__tests__/e2e.test.ts` (23
tests) and the DART parity scan (121 fitness checks against a real
codebase). Adding direct unit tests for the orchestrator would
substantially duplicate the e2e suite without catching new bugs.

What **is** unit-tested in fitness:

- `framework/define-check.ts` (factory)
- `framework/file-cache.ts`, `framework/file-accessor.ts`
- `framework/path-matcher.ts`, `framework/result-builder.ts`
- `framework/severity-mapping.ts`
- `framework/registry.ts`, `recipes/registry.ts`
- `recipes/check-resolution.ts`, `recipes/check-config.ts`
- `recipes/built-in-recipes.ts`, `recipes/retry.ts`
- `signalers/loader.ts`, `targets/loader.ts`
- `targets/resolver.ts`, `targets/target-registry.ts`
- `gate.ts`, `sarif.ts`

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

`checks-typescript` (66 checks) and `checks-universal` (88 checks)
each have a single smoke test verifying metadata (id/slug/tags
uniqueness, analysisMode validity). Adding per-check `analyze()`
detection tests would lift each pack's coverage to 90%+ but represents
~150 individual tests.

The checks **are** exercised end-to-end:
- The DART parity scan runs 121 of these checks against real source
  on every commit. Detection regressions would surface there.
- `e2e.test.ts` runs `fit --recipe quick-smoke` and `fit --check
  no-console-log`, which load and execute checks through the full
  framework path.

Adding per-check unit tests is the next coverage investment. They
should follow the shape of the language-pack smoke tests
(`packages/fitness/checks-{go,python,java,cpp}/src/__tests__/`):
exercise `analyze()` directly with a small fixture and assert the
violation count + severity.

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
