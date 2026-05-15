# Coverage Status

Snapshot taken 2026-05-15 against v3.0.0.

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
| `@opensip-tools/fitness` | 83.2 | 81.9 | 88.8 | 83.2 | close |
| `@opensip-tools/simulation` | 69.8 | 82.0 | 77.1 | 69.8 | gap |
| `@opensip-tools/checks-typescript` | 70.4 | 69.4 | 79.9 | 70.4 | close |
| `@opensip-tools/checks-universal` | 73.6 | 68.8 | 80.2 | 73.6 | close |
| `@opensip-tools/cli` | 0 | 0 | 0 | 0 | not measured |

Workspace test count: **1410** passing across 17 packages.

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

- `recipes/service.ts` (89%) — `service.test.ts` (28 tests)
- `framework/file-cache.ts` (94%), `framework/file-accessor.ts` (99%)
- `framework/path-matcher.ts` (96%), `framework/result-builder.ts` (100%)
- `framework/define-check.ts` (65%) — analyze + analyzeAll + command modes
- `framework/severity-mapping.ts` (100%), `framework/strip-literals.ts` (90%)
- `framework/ast-utilities.ts` (100%), `framework/scope-resolver.ts` (79%)
- `framework/command-executor.ts` (79%), `framework/register-helpers.ts` (100%)
- `recipes/registry.ts` (100%), `recipes/built-in-recipes.ts` (100%)
- `recipes/check-resolution.ts` (96%), `recipes/retry.ts` (100%)
- `signalers/loader.ts` (100%), `targets/loader.ts` (94%)
- `targets/resolver.ts` (100%), `targets/target-registry.ts` (100%)
- `gate.ts` (99%), `sarif.ts` (53% — render path tested via e2e)

What's left in fitness (~17%): `cacheable-exec.ts` (caches external
command output), `ignore-processing.ts` (`@fitness-ignore-*` directive
application), `directive-parsing.ts` (parser is partially covered),
parts of `parallel-execution.ts` / `sequential-execution.ts` /
`callback-processor.ts` exercised through the FitnessRecipeService
tests but not every callback variant.

## Simulation — 70% (lifted from 51%)

New tests:
- `framework/__tests__/assertions.test.ts` (51 tests) — every
  ASSERTIONS factory + evaluators
- `framework/__tests__/personas.test.ts` (19 tests) — persona
  helpers + every PERSONAS preset
- `framework/__tests__/result-builder.test.ts` (21 tests) —
  ScenarioResultBuilder, metric resolution, `mergeMetrics`
- `framework/execution/__tests__/execution-engine.test.ts` (30 tests)
  — `validateAssertions`, `getMetricValue` (every branch),
  `updateLatencyMetrics`, `sleepWithAbort` (resolve / pre-aborted /
  mid-sleep abort), `scenarioAborted`, `ScenarioAbortedError`
- `cli/__tests__/sim.test.ts` (9 tests) — `executeSim` recipe
  lookup + `--kind` filter + shouldFail propagation
- `__tests__/tool.test.ts` (8 tests) — `simulationTool` metadata,
  `register()` mounting the sim subcommand, action routing
- `__tests__/scenario-execution.test.ts` (4 tests) — load and
  chaos scenarios run end-to-end

Recipes module is at 100%. Remaining gaps: the kind-specific
`define`/`executor` files for `load`, `chaos`, `invariant`, and
`fix-evaluation` carry partial coverage; the full execution engine
runs in the load + chaos tests but invariant and fix-evaluation
require richer scenario harnesses (relatesToInvariant doc anchors
+ async setup/assert + signal payloads). Those land alongside the
first production scenarios.

## Check pack gaps

`checks-typescript` (62%, up from 25%) and `checks-universal` (72%,
up from 33%) have parametric coverage tests
(`all-checks-execute.test.ts`) that drive every check's `run()`
method against a curated fixture corpus. The fixtures exercise:

- Common detection markers: `EXAMPLE_TODO`, `console.log`,
  hardcoded secrets, `eval`, `process.env.X`, dangerous regex,
  silent early returns
- TS-AST patterns: drizzle-orm `pgTable` + `relations` +
  migrations, typed-inject containers, React components with
  `.map` without memo, async waterfall, dispose pattern,
  TypeORM entities, Zod schemas, lifecycle leaks, n+1 queries,
  TOCTOU races, throws-without-docs, fastify routes without schema
- Universal patterns: directive-audit (TS / ESLint / fitness /
  semgrep), PII logging, lockfile dependency-security-audit,
  webhook handlers, OpenAPI sync, frontend forms, CSP/CORS,
  test convention violations, env-var direct access

Each check's analyze function still has internal branches that
fire only on very specific code shapes (e.g. drizzle-orm tables
with composite keys, TypeORM `@Entity` classes missing standard
columns of a particular kind, very specific frontend list rendering
patterns). To reach 90% per pack, each check needs a dedicated
fixture matching its specific detection.

The checks are also exercised end-to-end:
- The DART parity scan runs 121 of these checks against real source
  on every commit. Detection regressions surface there.
- `e2e.test.ts` runs `fit --recipe quick-smoke` and `fit --check
  no-console-log`, which load and execute checks through the full
  framework path.

Adding per-check unit tests is the next coverage investment. The
parametric pattern means new fixtures lift coverage immediately
without per-check test maintenance.

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
