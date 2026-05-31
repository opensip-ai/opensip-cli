---
status: current
last_verified: 2026-05-27
release: v2.0.x
title: "Show me each loop"
audience: [getting-started]
purpose: "One sample per tool — fit check, sim scenario, graph rule — so you can see the shape of the work before reading the architecture docs."
source-files:
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/fitness/engine/src/recipes/types.ts
  - packages/simulation/engine/src/kinds/load/define.ts
  - packages/graph/engine/src/cli/run.ts
related-docs:
  - ./01-quick-start.md
  - ../50-extend/01-plugin-authoring.md
  - ../20-fit/01-recipes-and-checks.md
  - ../30-sim/01-scenarios-and-recipes.md
  - ../40-graph/01-stages-and-catalog.md
---
# Show me each loop

opensip-tools ships three first-party tools. Each answers a different question shape:

| Tool | Question | Unit of work |
|---|---|---|
| `fit` | "Is the codebase clean?" | A **check** — runs once per file, returns violations. |
| `sim` | "Does it behave correctly under stress?" | A **scenario** — drives traffic against your service and asserts on the result. |
| `graph` | "What is reachable from where?" | A **rule** over the static call graph — five ship in the box; not user-extensible the same way. |

One concrete sample of each, below. After you've seen them, [quick start](./01-quick-start.md) shows you how to run them.

---

## `fit` — a check

A check is one file. Drop it under `opensip-tools/fit/checks/` and the platform finds it on the next run.

```js
// opensip-tools/fit/checks/no-fixme.mjs
import { defineCheck } from '@opensip-tools/fitness';

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

`analyze(content, filePath)` runs once per file. Return an array of violations. Empty array = passed. Recipes (`opensip-tools/fit/recipes/*.mjs`) compose checks into named lineups for CI. Deeper detail: [plugin authoring](../50-extend/01-plugin-authoring.md) and [recipes and checks](../20-fit/01-recipes-and-checks.md).

```text
> opensip-tools fit --check no-fixme-comments
  ✗ no-fixme-comments   312 files,   2 violations
  0 Passed, 1 Failed (2 Errors, 0 Warnings) | Duration 0.4s

> echo $?
1
```

Exit code drives CI. That's the whole contract.

---

## `sim` — a scenario

A scenario describes a load (or chaos, invariant, or fix-evaluation) workload and the assertions that should hold against the result. Drop it under `opensip-tools/sim/scenarios/`.

```js
// opensip-tools/sim/scenarios/checkout-burst.mjs
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

The four scenario kinds — `defineLoadScenario`, `defineChaosScenario`, `defineInvariantScenario`, `defineFixEvaluationScenario` — each emit the same `RunnableScenario` shape with a different `kind:` discriminator. Recipes compose scenarios the same way fit recipes compose checks. Deeper detail: [scenarios and recipes](../30-sim/01-scenarios-and-recipes.md).

> Simulation is opt-in and experimental in v2.0.x. The shapes are stable; the runtime mechanics are still being hardened.

---

## `graph` — a rule on the call graph

`graph` is different from `fit` and `sim` in one important way: **you don't author rules; you run the bundled ones.** The engine builds your project's static call graph in five stages (discover → walk → resolve → index → render); six rules consume that graph and emit findings.

```text
> opensip-tools graph
  Graph
  Catalog: 4,128 functions, 23,201 edges   Project: ~/work/my-app
  ────────────────────────────────────────────────────────────

  ✓ orphan-subtree              0 violations
  ✗ duplicated-function-body    3 violations
  ✓ no-side-effect-path         0 violations
  ✗ test-only-reachable         1 violation
  ✓ always-throws-branch        0 violations
  ◦ high-blast-function         7 noted

  3 Passed, 2 Failed | Duration 2.5s   (incremental rebuild)
```

The six rules:

- **`orphan-subtree`** — functions reachable from nothing (no entry point, no test).
- **`duplicated-function-body`** — distinct functions whose bodies hash the same (refactor candidates).
- **`no-side-effect-path`** — code paths that should have side effects but don't (e.g. a logged-out branch that doesn't log).
- **`test-only-reachable`** — code only reached from test files (likely dead in production).
- **`always-throws-branch`** — branches that always throw, suggesting an unreachable code path.
- **`high-blast-function`** — the functions with the widest change-impact (blast radius), surfaced as an informational insight at `note` severity, not a gate.

Like `fit`, `graph` ships with a gate flow: `--gate-save` captures today's catalog as a baseline, `--gate-compare` fails the run when new violations appear. Five language adapters ship in v2.0: TypeScript, Python, Rust, Go, Java. Deeper detail: [stages and catalog](../40-graph/01-stages-and-catalog.md) and [rules and gating](../40-graph/02-rules-and-gating.md).

---

## Same CLI, same gate model, three different questions

All three tools share the surface:

```bash
opensip-tools fit     # codebase cleanliness
opensip-tools sim     # runtime behavior under load
opensip-tools graph   # call-graph shape
```

Each exits `0` when the bar holds, non-zero when it doesn't. Each emits SARIF for CI annotations. Each has a baseline/compare gate so you can adopt incrementally. The CLI doesn't know what any of them do internally — they're tools registered against a shared dispatcher. Same model lets a future `audit` or `lint` tool slot in without CLI changes.

## What's next

| If you want to … | Go to … |
|---|---|
| Run the four-command smoke right now | [Quick start](./01-quick-start.md) |
| Understand the design philosophy | [What is opensip-tools](./00-what-is-opensip-tools.md) |
| Author a fit check or recipe | [Plugin authoring](../50-extend/01-plugin-authoring.md) |
| Go deep on one loop | [Fit](../20-fit/01-recipes-and-checks.md) · [Sim](../30-sim/01-scenarios-and-recipes.md) · [Graph](../40-graph/01-stages-and-catalog.md) |
