---
status: current
last_verified: 2026-06-07
release: v1.0.0
title: "Scenarios and recipes (sim)"
audience: [contributors, plugin-authors]
purpose: "What a sim scenario is, the two kinds, and how recipes compose them. The author-facing primitives in the simulation tool."
source-files:
  - packages/simulation/engine/src/index.ts
  - packages/simulation/engine/src/types/kind-types.ts
  - packages/simulation/engine/src/framework/execution/target.ts
  - packages/simulation/engine/src/framework/execution/fault-spec.ts
  - packages/simulation/engine/src/types/workload.ts
  - packages/simulation/engine/src/kinds/load/define.ts
  - packages/simulation/engine/src/kinds/chaos/define.ts
  - packages/simulation/engine/src/recipes/types.ts
  - packages/simulation/engine/src/recipes/define-recipe.ts
related-docs:
  - ../20-fit/01-recipes-and-checks.md
  - ./02-execution-model.md
  - ../50-extend/01-plugin-authoring.md
---
# Scenarios and recipes (sim)

The `sim` command is the simulation tool. Where `fit` answers "is the codebase clean?", `sim` answers "does it behave correctly under stress?" Same architecture (Tool, Recipe, Engine, Renderer), different primitives.

> ⚠️ `sim` is **experimental**. The author-facing API (the `define*Scenario` entry points) shifts more aggressively than `fit`'s. Pin to a major version in your check pack; expect occasional breaking changes in minors.

> **`sim` is a standalone driver — you bring the target.** Every scenario
> supplies a `target`: an async function the harness calls once per request
> (it resolves on success, throws on failure). Point it **only at a service you
> own or control** — never at a third party. Driving load or faults at someone
> else's endpoint is abuse. Use `httpTarget({ url })` for HTTP, or any async
> function for gRPC / in-process / shell-out targets.

> **What you'll understand after this:**
> - The two scenario kinds and what each models.
> - The shared runtime contract that lets one engine run both.
> - How sim recipes compose scenarios.
> - When to reach for sim vs. fit.

---

## The scenario kinds

opensip sim recognizes two kinds, each with its own author-facing entry point in [`packages/simulation/engine/src/index.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/index.ts):

| Kind | Entry point | Models |
|---|---|---|
| **load** | `defineLoadScenario` | A BYO `target` driven at a `workload` (rps + optional ramp + concurrency). Asserts SLOs (latency percentiles, error rate, throughput). |
| **chaos** | `defineChaosScenario` | A BYO `target` under **client-side** fault injection (latency / abort / drop) at a probability, then a recovery window. Asserts steady-state + recovery SLOs. |

Each kind has its own `define.ts`, `executor.ts`, and `result.ts` under [`packages/simulation/engine/src/kinds/<kind>/`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/kinds/). They share a common runtime contract (`RunnableScenario`, `ScenarioExecutorResult`) so the engine can execute any kind through the same dispatcher.

Use the kind-specific entry points so each scenario declares its runtime shape
explicitly.

### `defineLoadScenario`

```ts
import { defineLoadScenario, httpTarget, ASSERTIONS } from '@opensip-cli/simulation';

export default defineLoadScenario({
  id: '...',                            // UUID
  name: 'api-checkout-burst',
  description: 'Sustain 200 RPS checkout traffic for 30s',
  tags: ['load', 'checkout'],
  // The BYO seam: point only at a service you own.
  target: httpTarget({ url: process.env.TARGET_URL }),
  workload: { rps: 200, rampUp: 5 },    // rps + optional concurrency/rampUp (seconds)
  duration: 30,                          // seconds
  assertions: [
    ASSERTIONS.lowLatency('p99', 200),   // p99 latency < 200ms
    ASSERTIONS.lowErrorRate(0.01),       // error rate < 1%
  ],
});
```

The driver issues real requests to the `target` at `workload.rps` (bounded by
`workload.concurrency`, ramping over `workload.rampUp`) for `duration` seconds,
measures real latency and success/failure per request, then evaluates each
assertion against the measured metrics. Pass/fail is the AND of all assertions.
Assertions are built with the `ASSERTIONS` factories over a fixed set of metric
keys (`p50/p95/p99_latency`, `error_rate`, `success_rate`, `requests_per_second`, …).

### `defineChaosScenario`

```ts
import { defineChaosScenario, httpTarget, fault, ASSERTIONS } from '@opensip-cli/simulation';

export default defineChaosScenario({
  id: 'checkout-resilient-under-fault',
  name: 'checkout-resilient-under-fault',
  description: 'Checkout stays within SLO under client-side faults, recovers after',
  tags: ['chaos', 'checkout'],

  // Same BYO target + workload the load kind takes.
  target: httpTarget({ url: process.env.TARGET_URL }),
  workload: { rps: 50, rampUp: 5 },
  duration: 30,                       // steady-state (fault-active) window, seconds

  // Client-side fault contract: at probability 0.1, perturb a request with
  // either +800ms latency or a dropped request.
  fault: fault.of(
    [fault.latency({ ms: 800 }), fault.drop()],
    { probability: 0.1 },
  ),

  // Two assertion sets — one per phase the executor runs.
  steadyStateAssertions: [ASSERTIONS.lowErrorRate(0.05), ASSERTIONS.lowLatency('p95', 1500)],
  recoveryAssertions:    [ASSERTIONS.lowErrorRate(0.01), ASSERTIONS.lowLatency('p95', 500)],
  recoveryWindow: 10_000,             // ms after faults lift
});
```

The chaos kind drives the same real load window with the fault model active,
then runs a recovery window with faults lifted. Steady-state assertions evaluate
against the fault-active window; recovery assertions against the recovery window.
Pass/fail is the AND of both verdicts.

**Client-side vs server-side faults (the honesty boundary).** The shipped faults
(`latency`, `abort`, `drop`) perturb the harness's *own* interaction with the
target — they are real, but client-side. The harness **cannot** kill your pod or
sever your database from the outside. To exercise **server-side** faults (inject
500s, drop a dependency, add network latency), point the `target` at a
**fault-injectable endpoint you control** — e.g. a [Toxiproxy](https://github.com/Shopify/toxiproxy)
proxy in front of your service, a chaos-mesh'd staging environment, or a
test-flagged endpoint — and let the harness drive and measure around it. The
harness ships no fault injector and no demo server.

---

## The shared runtime contract

Both entry points produce a `RunnableScenario` ([`packages/simulation/engine/src/framework/runnable-scenario.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/framework/runnable-scenario.ts)) — a struct carrying the scenario's id, name, description, kind, tags, and a `run(abortSignal)` method that returns `Promise<ScenarioExecutorResult>`. The engine's dispatcher reads the kind discriminator and hands the scenario to the appropriate executor:

```
RunnableScenario { kind: 'load', run(signal)  } ─► loadExecutor  ─► LoadScenarioExecutorResult
RunnableScenario { kind: 'chaos', run(signal) } ─► chaosExecutor ─► ChaosScenarioExecutorResult
```

The result types are kind-specific (a load result has `p99LatencyMs` and percentiles; a chaos result has steady-state + recovery metrics and per-phase chaos events). The recipe layer projects each kind's result into a common `ScenarioResult` shape so the renderer doesn't need to know the kind.

Kind-specific authoring plus a shared runtime contract keeps the engine extensible: adding a scenario kind means adding a directory under `kinds/`, exporting a new entry point from `index.ts`, and updating the dispatcher.

---

## Sim recipes

A sim recipe is the same shape as a fit recipe: a named selection of scenarios + execution options + reporting options. Defined in [`packages/simulation/engine/src/recipes/types.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/recipes/types.ts) and constructed via [`defineRecipe`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/recipes/define-recipe.ts).

```ts
import { defineSimulationRecipe } from '@opensip-cli/simulation';

export default defineSimulationRecipe({
  name: 'pre-deploy',
  displayName: 'Pre-deploy',
  description: 'Load + chaos suite before each deploy',
  scenarios: { type: 'tags', include: ['load', 'chaos'] },
  execution: { mode: 'sequential', timeout: 300_000 },
});
```

(The fitness-side helper is named `defineRecipe`. Sim's helper is namespaced as `defineSimulationRecipe` so a project that imports both into one module doesn't have to alias.)

Selectors are similar to fit's but with a slightly different set: `all`, `tags`, `kind`, `explicit` ([`packages/simulation/engine/src/recipes/types.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/recipes/types.ts)). Sim swaps fit's `pattern` selector for a `kind` selector that filters by scenario kind (`load` / `chaos`).

`sequential` mode is the typical shape for sim recipes — load scenarios contend for resources, so running them in parallel is rarely correct. `parallel` is available for scenarios that fan out across independent inputs.

The default recipe ([`packages/simulation/engine/src/recipes/built-in-recipes.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/recipes/built-in-recipes.ts)) selects every registered scenario in sequential order. Project-local recipes live under `<project>/opensip-cli/sim/recipes/*.mjs`.

---

## Where scenarios come from

Same three sources as checks:

1. **Built-in.** Currently empty — the engine ships kind support but no built-in scenarios. (Compare to `fit`, where `@opensip-cli/checks-universal` ships universal checks.) Because of this, running `sim` in a project with no project-local or npm-package scenarios fails closed with exit 2 (an empty run is not a pass — see the exit-code contract in the [CLI reference](/docs/opensip-cli/70-reference/01-cli-commands/#sim--run-simulation-scenarios)). Run `opensip init` to scaffold example scenarios first.
2. **Project-local.** `<project>/opensip-cli/sim/scenarios/*.mjs`. Loaded by the plugin discoverer at startup.
3. **npm-package.** Sim packs are discovered from project `node_modules` by **name-pattern** (ADR-0029): any package whose name matches `<scope>/scenarios-*` under the default `@opensip-cli` scope plus any configured `plugins.packageScopes`. There is no `opensipTools.kind: "sim-pack"` marker — sim marker discovery was retired in ADR-0029. Explicit `plugins.scenarioPackages:` pins can additionally name exact packages outside the pattern. For deterministic install/sync, `opensip plugin add --domain sim <pkg>` installs into `.runtime/plugins/sim/` and records the package under `plugins.sim:`. The package's main entry exports `scenarios: RunnableScenario[]` and optionally `recipes: SimulationRecipe[]`.

The registry ([`packages/simulation/engine/src/framework/registry.ts`](https://github.com/opensip-ai/opensip-cli/blob/v1.0.0/packages/simulation/engine/src/framework/registry.ts)) is last-writer-wins on id collision. Discovery surfaces conflicts in the CLI's startup logs.

---

## When to use sim vs. fit

| Question | Tool |
|---|---|
| "Does this code match a static rule?" (regex, AST, complexity) | **fit** |
| "Does this commit introduce a new violation?" | **fit** with `--gate-compare` |
| "Does this service handle 200 RPS without 5xx?" | **sim** (load) |
| "Does the system recover from a 5-second DB outage?" | **sim** (chaos) |

`fit` is fast and deterministic — no I/O beyond reading source files, scales to thousands of files in seconds. `sim` is slow and (intentionally) non-deterministic in the load and chaos kinds — it runs real workloads and measures wall-clock outcomes. They complement each other: `fit` runs on every PR, `sim` runs on a slower cadence (nightly, pre-deploy, weekly).

If you're not sure which one applies, ask whether the answer is in the source (fit) or in the running system (sim).

---

## What's next

- **[`02-execution-model.md`](/docs/opensip-cli/30-sim/02-execution-model/)** — how the sim engine actually runs scenarios. Dispatcher, executor lifecycle, result aggregation.
- **[`../20-fit/01-recipes-and-checks.md`](/docs/opensip-cli/20-fit/01-recipes-and-checks/)** — the fit-side analogue of this doc. Same shape, different primitives.
- **[`../50-extend/01-plugin-authoring.md`](/docs/opensip-cli/50-extend/01-plugin-authoring/)** — full walkthrough of authoring scenarios and recipes.
