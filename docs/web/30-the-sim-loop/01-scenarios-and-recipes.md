---
status: current
last_verified: 2026-05-15
title: "Scenarios and recipes (sim)"
audience: [contributors, plugin-authors]
purpose: "What a sim scenario is, the four kinds, and how recipes compose them. The author-facing primitives in the simulation tool."
source-files:
  - packages/simulation/engine/src/index.ts
  - packages/simulation/engine/src/types/kind-types.ts
  - packages/simulation/engine/src/kinds/load/define.ts
  - packages/simulation/engine/src/kinds/chaos/define.ts
  - packages/simulation/engine/src/kinds/invariant/define.ts
  - packages/simulation/engine/src/kinds/fix-evaluation/define.ts
  - packages/simulation/engine/src/recipes/types.ts
  - packages/simulation/engine/src/recipes/define-recipe.ts
related-docs:
  - ../20-the-fit-loop/01-recipes-and-checks.md
  - ./02-execution-model.md
  - ../60-surfaces/02-plugin-authoring.md
---
# Scenarios and recipes (sim)

The `sim` command is the simulation tool. Where `fit` answers "is the codebase clean?", `sim` answers "does it behave correctly under stress?" Same architecture (Tool, Recipe, Engine, Renderer), different primitives.

> ⚠️ `sim` is **experimental**. The author-facing API (the four `define*Scenario` entry points) shifts more aggressively than `fit`'s. Pin to a major version in your check pack; expect occasional breaking changes in minors.

> **What you'll understand after this:**
> - The four scenario kinds and what each models.
> - The shared runtime contract that lets one engine run all four.
> - How sim recipes compose scenarios.
> - When to reach for sim vs. fit.

---

## The four scenario kinds

opensip-tools sim recognizes four kinds today, each with its own author-facing entry point in [`packages/simulation/engine/src/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/index.ts):

| Kind | Entry point | Models |
|---|---|---|
| **load** | `defineLoadScenario` | Personas + ramp + sustain phase. Asserts SLOs (latency, throughput, error rate). |
| **chaos** | `defineChaosScenario` | Base load + injected failures (kill, latency, partition). Asserts recovery. |
| **invariant** | `defineInvariantScenario` | Seed state → act → assert a property holds. Property-based testing shape. |
| **fix-evaluation** | `defineFixEvaluationScenario` | Replay a corpus of signals against a fix-generating agent → score with predicates. |

Each kind has its own `define.ts`, `executor.ts`, and `result.ts` under [`packages/simulation/engine/src/kinds/<kind>/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/kinds/). They share a common runtime contract (`RunnableScenario`, `ScenarioExecutorResult`) so the engine can execute any kind through the same dispatcher.

The legacy `defineScenario` ([`packages/simulation/engine/src/framework/define-scenario.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/framework/define-scenario.ts)) is a deprecated alias that routes to `defineLoadScenario`. New code uses the kind-specific entry points.

### `defineLoadScenario`

```ts
import { defineLoadScenario } from '@opensip-tools/simulation';

export default defineLoadScenario({
  id: '...',                            // UUID
  name: 'api-checkout-burst',
  description: 'Sustain 200 RPS checkout traffic for 30s',
  tags: ['load', 'checkout'],
  personas: [{ name: 'shopper', weight: 1.0, action: async () => { /* ... */ } }],
  duration: { value: 30, unit: 'seconds' },
  rampUp: { value: 5, unit: 'seconds' },
  targetRps: 200,
  assertions: [
    { name: 'p99-under-200ms', assert: (r) => r.p99LatencyMs < 200 },
    { name: 'error-rate-under-1pct', assert: (r) => r.errorRate < 0.01 },
  ],
});
```

The framework runs the personas at the configured RPS for the duration, collects latency and error stats, then evaluates each assertion against the result. Pass/fail is the AND of all assertions.

### `defineChaosScenario`

```ts
import { defineChaosScenario } from '@opensip-tools/simulation';

export default defineChaosScenario({
  id: '...',
  name: 'kill-database-recovers-in-10s',
  description: 'After killing the database for 5s, the API recovers within 10s',
  tags: ['chaos', 'database'],
  baseLoad: { /* a LoadScenarioConfig fragment */ },
  injection: {
    target: 'database',
    fault: { kind: 'kill', duration: { value: 5, unit: 'seconds' } },
    delayBeforeInjection: { value: 10, unit: 'seconds' },
  },
  recovery: { recoverWithin: { value: 10, unit: 'seconds' } },
  assertions: [/* ... */],
});
```

The chaos kind composes a load scenario with a failure injection. The executor runs the base load, injects the fault at the configured time, and measures whether the system recovers within the recovery window.

### `defineInvariantScenario`

```ts
import { defineInvariantScenario } from '@opensip-tools/simulation';

export default defineInvariantScenario({
  id: '...',
  name: 'inventory-never-negative',
  description: 'After any sequence of orders and refunds, inventory ≥ 0',
  tags: ['invariant', 'inventory'],
  seed: async () => ({ inventory: { sku123: 100 } }),
  act: async (state) => {
    // Run a randomized sequence of operations.
    for (const op of randomOps(20)) {
      state = await applyOp(state, op);
    }
    return state;
  },
  assert: (finalState) => {
    return Object.values(finalState.inventory).every((v) => v >= 0);
  },
});
```

The invariant kind is the property-based-testing shape. Seed produces an initial state; `act` mutates it through a (typically randomized) sequence of operations; `assert` verifies the property holds. Failure produces a counterexample.

### `defineFixEvaluationScenario`

```ts
import { defineFixEvaluationScenario } from '@opensip-tools/simulation';

export default defineFixEvaluationScenario({
  id: '...',
  name: 'corpus-eval-no-console-log',
  description: 'Agent fixes 95% of no-console-log violations from the corpus',
  tags: ['fix-eval', 'no-console-log'],
  corpus: { signalRuleId: 'fit:no-console-log', sampleSize: 100 },
  agent: { /* agent provider config */ },
  predicates: [
    { name: 'fix-applies-cleanly', predicate: /* ... */ },
    { name: 'tests-still-pass', predicate: /* ... */ },
    { name: 'lint-still-clean', predicate: /* ... */ },
  ],
  scoreThreshold: 0.95,
});
```

The fix-evaluation kind replays a corpus of past signals against a fix-generating agent and scores the agent's output with predicates. This is the shape that integrates with OpenSIP's autoresearch / continuous-learning loop, and it's the most experimental — its API surface and the corpus-fetch contract are still evolving.

---

## The shared runtime contract

Despite four entry points, every scenario produces a `RunnableScenario` ([`packages/simulation/engine/src/framework/runnable-scenario.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/framework/runnable-scenario.ts)) — a struct carrying the scenario's id, name, kind, and an `execute(ctx)` method. The engine's dispatcher reads the kind discriminator and hands the scenario to the appropriate executor:

```
RunnableScenario { kind: 'load', execute(ctx)    } ─► loadExecutor      ─► LoadScenarioExecutorResult
RunnableScenario { kind: 'chaos', execute(ctx)   } ─► chaosExecutor     ─► ChaosScenarioExecutorResult
RunnableScenario { kind: 'invariant', execute()  } ─► invariantExecutor ─► InvariantScenarioExecutorResult
RunnableScenario { kind: 'fix-evaluation', exec()} ─► fixEvalExecutor   ─► FixEvaluationScenarioExecutorResult
```

The result types are kind-specific (a load result has `p99LatencyMs`; an invariant result has `counterexample`). The recipe layer projects each kind's result into a common `ScenarioResult` shape so the renderer doesn't need to know the kind.

This shape — kind-specific authoring + shared runtime contract — is why the simulation engine can be one package today and four+ packages tomorrow without a rewrite. A new scenario kind is a new directory under `kinds/`, a new entry point exported from `index.ts`, and an updated dispatcher.

---

## Sim recipes

A sim recipe is the same shape as a fit recipe: a named selection of scenarios + execution options + reporting options. Defined in [`packages/simulation/engine/src/recipes/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/recipes/types.ts) and constructed via [`defineRecipe`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/recipes/define-recipe.ts).

```ts
import { defineRecipe } from '@opensip-tools/simulation';

export default defineRecipe({
  name: 'pre-deploy',
  displayName: 'Pre-deploy',
  description: 'Load + chaos suite before each deploy',
  scenarios: { type: 'tags', include: ['load', 'chaos'] },
  execution: { mode: 'sequential', timeout: 300_000 },
});
```

Selectors mirror fit's: `all`, `tags`, `pattern`, `explicit`. The `kind:` filter on the CLI (`opensip-tools sim --kind load`) layers on top — it intersects with the recipe's selector so you can run a recipe but only its load scenarios.

`sequential` mode is the typical shape for sim recipes — load scenarios contend for resources, so running them in parallel is rarely correct. `parallel` is available for invariant scenarios (which are usually pure) or fix-evaluation scenarios that fan out across independent inputs.

The default recipe ([`packages/simulation/engine/src/recipes/built-in-recipes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/recipes/built-in-recipes.ts)) selects every registered scenario in sequential order. Project-local recipes live under `<project>/opensip-tools/sim/recipes/*.mjs`.

---

## Where scenarios come from

Same three sources as checks:

1. **Built-in.** Currently empty — the engine ships kind support but no built-in scenarios. (Compare to `fit`, where `@opensip-tools/checks-universal` ships universal checks.)
2. **Project-local.** `<project>/opensip-tools/sim/scenarios/*.mjs`. Loaded by the plugin discoverer at startup.
3. **npm-package.** Any package listed in `plugins.sim:` in the project config. The package's main entry exports `scenarios: RunnableScenario[]` and optionally `recipes: SimulationRecipe[]`. Sim packs use explicit pinning only — there is no `@opensip-tools/sim-*` name-prefix auto-discovery today.

The registry ([`packages/simulation/engine/src/framework/registry.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/simulation/engine/src/framework/registry.ts)) is last-writer-wins on id collision. Discovery surfaces conflicts in the CLI's startup logs.

---

## When to use sim vs. fit

| Question | Tool |
|---|---|
| "Does this code match a static rule?" (regex, AST, complexity) | **fit** |
| "Does this commit introduce a new violation?" | **fit** with `--gate-compare` |
| "Does this service handle 200 RPS without 5xx?" | **sim** (load) |
| "Does the system recover from a 5-second DB outage?" | **sim** (chaos) |
| "Does the order book never go negative under any sequence of operations?" | **sim** (invariant) |
| "Does my fix-generating agent solve 95% of the corpus?" | **sim** (fix-evaluation) |

`fit` is fast and deterministic — no I/O beyond reading source files, scales to thousands of files in seconds. `sim` is slow and (intentionally) non-deterministic in the load and chaos kinds — it runs real workloads and measures wall-clock outcomes. They complement each other: `fit` runs on every PR, `sim` runs on a slower cadence (nightly, pre-deploy, weekly).

If you're not sure which one applies, ask whether the answer is in the source (fit) or in the running system (sim).

---

## What's next

- **[`02-execution-model.md`](/docs/opensip-tools/30-the-sim-loop/02-execution-model/)** — how the sim engine actually runs scenarios. Dispatcher, executor lifecycle, result aggregation.
- **[`../20-the-fit-loop/01-recipes-and-checks.md`](/docs/opensip-tools/20-the-fit-loop/01-recipes-and-checks/)** — the fit-side analogue of this doc. Same shape, different primitives.
- **[`../60-surfaces/02-plugin-authoring.md`](/docs/opensip-tools/60-surfaces/02-plugin-authoring/)** — full walkthrough of authoring scenarios and recipes.
