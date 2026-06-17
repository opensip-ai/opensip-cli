---
status: current
last_verified: 2026-06-15
release: v0.1.4
title: "Show me each loop"
audience: [getting-started]
purpose: "One sample per tool — fit check, sim scenario, graph rule — so you can see the shape of the work before reading the architecture docs."
source-files:
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/fitness/engine/src/recipes/types.ts
  - packages/simulation/engine/src/kinds/load/define.ts
  - packages/graph/engine/src/cli/graph-modes.ts
related-docs:
  - ./00-quick-start.md
  - ../50-extend/01-plugin-authoring.md
  - ../20-fit/01-recipes-and-checks.md
  - ../30-sim/01-scenarios-and-recipes.md
  - ../40-graph/01-stages-and-catalog.md
---
# Show me each loop

opensip-cli ships three first-party tools. Each answers a different question shape:

| Tool | Question | Unit of work |
|---|---|---|
| `fit` | "Is the codebase clean?" | A **check** — runs once per file, returns violations. |
| `sim` | "Does it behave correctly under stress?" | A **scenario** — drives traffic against your service and asserts on the result. |
| `graph` | "What is reachable from where?" | A **rule** over the static call graph — authored with `defineRule` (parallel to `defineCheck`); ten ship in the box. |

One concrete sample of each, below. After you've seen them, [quick start](./00-quick-start.md) shows you how to run them.

---

## `fit` — a check

A check is one file. Drop it under `opensip-cli/fit/checks/` and the platform finds it on the next run.

```js
// opensip-cli/fit/checks/no-fixme.mjs
import { defineCheck } from '@opensip-cli/fitness';

export default defineCheck({
  id: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  slug: 'no-fixme-comments',
  description: 'No FIXME comments left in source',
  tags: ['quality', 'documentation'],
  scope: { languages: ['typescript'], concerns: [] },
  contentFilter: 'raw',
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

`analyze(content, filePath)` runs once per file. Return an array of violations. Empty array = passed. Recipes under `opensip-cli/fit/recipes/` compose checks into named lineups for CI. Deeper detail: [plugin authoring](../50-extend/01-plugin-authoring.md) and [recipes and checks](../20-fit/01-recipes-and-checks.md).

```text
> opensip fit --check no-fixme-comments
  ✗ no-fixme-comments   312 files,   2 violations
  0 Passed, 1 Failed (2 Errors, 0 Warnings) | Duration 0.4s

> echo $?
1
```

Exit code drives CI. That's the whole contract.

---

## `sim` — a scenario

A scenario describes a load (or chaos) workload and the assertions that should hold against the result. Drop it under `opensip-cli/sim/scenarios/`.

```js
// opensip-cli/sim/scenarios/checkout-burst.mjs
import { defineLoadScenario } from '@opensip-cli/simulation';

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

The two scenario kinds — `defineLoadScenario`, `defineChaosScenario` — each emit the same `RunnableScenario` shape with a different `kind:` discriminator. Recipes compose scenarios the same way fit recipes compose checks. Deeper detail: [scenarios and recipes](../30-sim/01-scenarios-and-recipes.md).

> Simulation is opt-in. The scenarios run against targets you own or control.

---

## `graph` — a rule on the call graph

`graph` is an architectural *peer* of `fit`: rules are authored with
`defineRule` — the call-graph analogue of `defineCheck` — selected through the
same shared recipe substrate, and their findings land in sessions and the
dashboard exactly like fitness checks. The difference is the *input*: where a
check sees `(content, filePath)`, a rule sees the engine **dataset** (the
catalog, the indexes, and a derived feature layer). The engine builds your
project's static call graph in a staged pipeline (discover → walk → resolve →
index → derive features → render); ten built-in rules consume that dataset and
emit findings.

```text
> opensip graph
  Graph
  Catalog: 4,128 functions, 23,201 edges   Project: ~/work/my-app
  ────────────────────────────────────────────────────────────

  ✓ orphan-subtree              0 violations
  ✗ duplicated-function-body    3 violations
  ✓ no-side-effect-path         0 violations
  ✗ test-only-reachable         1 violation
  ✓ always-throws-branch        0 violations
  ✗ large-function              2 violations
  ...

  ... | Duration 2.5s   (incremental rebuild)
```

The ten rules, in two groups. Reachability and duplication:

- **`orphan-subtree`** — functions reachable from nothing (no entry point, no test).
- **`duplicated-function-body`** — distinct functions whose bodies hash the same (refactor candidates).
- **`no-side-effect-path`** — code paths that should have side effects but don't (e.g. a logged-out branch that doesn't log).
- **`test-only-reachable`** — code only reached from test files (likely dead in production).
- **`always-throws-branch`** — branches that always throw, suggesting an unreachable code path.

Structural (fed by the engine feature layer):

- **`large-function`** — functions whose body exceeds a configured line count.
- **`wide-function`** — functions taking too many parameters.
- **`high-blast-untested`** — functions with a high blast radius that no test reaches (fixable by adding a test).
- **`cycle`** — functions participating in a call cycle (a strongly-connected component); cross-package cycles are flagged at higher severity.
- **`unexpected-coupling`** — package dependency cycles (two packages that import each other, A→B→A). Bounded and breakable; statistical "coupling outlier" rankings stay a dashboard insight, not a gate.

Per-function metrics (size, fan-out, blast radius, test coverage) are computed once by the engine feature layer; rules query them, and the dashboard's graph view surfaces them as the same findings — one source of truth, no client-side recomputation.

Like `fit`, `graph` ships with a gate flow: `--gate-save` captures today's catalog as a baseline, `--gate-compare` fails the run when new violations appear. Five language adapters ship: TypeScript, Python, Rust, Go, Java. Deeper detail: [stages and catalog](../40-graph/01-stages-and-catalog.md) and [rules and gating](../40-graph/02-rules-and-gating.md).

---

## Same CLI, same gate model, three different questions

All three tools share the surface:

```bash
opensip fit     # codebase cleanliness
opensip sim     # runtime behavior under load
opensip graph   # call-graph shape
```

Each exits `0` when the bar holds, non-zero when it doesn't. Each emits SARIF for CI annotations. Each has a baseline/compare gate so you can adopt incrementally. The CLI doesn't know what any of them do internally — they're tools registered against a shared dispatcher. Same model lets a future `audit` or `lint` tool slot in without CLI changes.

## What's next

| If you want to … | Go to … |
|---|---|
| Run the first smoke test right now | [Quick start](./00-quick-start.md) |
| Understand the design philosophy | [What is opensip-cli](./01-what-is-opensip-cli.md) |
| Author a fit check or recipe | [Plugin authoring](../50-extend/01-plugin-authoring.md) |
| Go deep on one loop | [Fit](../20-fit/01-recipes-and-checks.md) · [Sim](../30-sim/01-scenarios-and-recipes.md) · [Graph](../40-graph/01-stages-and-catalog.md) |
