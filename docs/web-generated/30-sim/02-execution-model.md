---
status: current
last_verified: 2026-06-03
release: v2.6.x
title: "Sim execution model"
audience: [contributors]
purpose: "How the sim engine runs scenarios. Dispatcher, executor lifecycle, result aggregation, exit semantics."
source-files:
  - packages/simulation/engine/src/cli/sim.ts
  - packages/simulation/engine/src/recipes/service.ts
  - packages/simulation/engine/src/framework/runnable-scenario.ts
  - packages/simulation/engine/src/framework/scenario-executor-result.ts
  - packages/simulation/engine/src/kinds/load/executor.ts
  - packages/simulation/engine/src/kinds/chaos/executor.ts
  - packages/simulation/engine/src/kinds/invariant/executor.ts
  - packages/simulation/engine/src/kinds/fix-evaluation/executor.ts
related-docs:
  - ./01-scenarios-and-recipes.md
  - ../10-concepts/01-fitness-loop.md
---
# Sim execution model

The sim engine has the same architectural shape as fit's recipe engine — selector → list → dispatch → run → aggregate → render — but the per-scenario executor is kind-specific. This doc walks the run.

> **What you'll understand after this:**
> - The four executors (load, chaos, invariant, fix-evaluation) and what each does.
> - How sequential vs. parallel execution affects scenarios that share state.
> - The shape of the per-kind executor result.
> - How the run aggregates into a `SimDoneResult`.

---

## The lifecycle

```
opensip-tools sim --recipe <name>
  → simulationTool.action(opts)
       → executeSim(args)                                                   ↓
            → loadProjectConfig + plugin sync                                │
            → resolve recipe (or default)                                    │
            → expand selector → scenario list                                │
            → for each scenario (in mode order):                             │
                 ┌─────────────────────────────────────────────────────┐    │
                 │  await scenario.run(ctx)   /* polymorphic */        │    │
                 │                                                     │    │
                 │  Extension points (not runtime dispatch — the       │    │
                 │  RunnableScenario produced by define*Scenario       │    │
                 │  already carries the kind-bound run() method):      │    │
                 │      kind 'load'           → kinds/load/executor    │    │
                 │      kind 'chaos'          → kinds/chaos/executor   │    │
                 │      kind 'invariant'      → kinds/invariant/...    │    │
                 │      kind 'fix-evaluation' → kinds/fix-evaluation   │    │
                 └─────────────────────────────────────────────────────┘    │
            → aggregate results into SimDoneResult                           │
       → render (Ink or JSON)                                                │
       → set exit code (1 if any scenario failed)                            ▼
                                                                       shell prompt
```

All four executors live under [`packages/simulation/engine/src/kinds/<kind>/executor.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/kinds/). Each accepts a kind-specific config (validated at `define*Scenario` time) and a `ScenarioContext` (signal/abort, logger, persona context for load/chaos).

---

## The four executors

### Load executor

[`packages/simulation/engine/src/kinds/load/executor.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/kinds/load/executor.ts)

The load executor's job:

1. **Ramp up.** Increase active personas from 0 to the steady-state count over `rampUp` duration.
2. **Sustain.** Keep the personas running at `targetRps` for `duration`.
3. **Collect.** Per-request: latency, success/failure. Per-second: in-flight count, error rate.
4. **Assert.** Run each `assertion` against the collected stats. The scenario passes iff every assertion passes.

The result type is `LoadScenarioExecutorResult` — carries `p50LatencyMs`, `p99LatencyMs`, `errorRate`, `requestCount`, plus the `assertionResults`.

A load scenario that's interrupted (signal abort, timeout) returns whatever stats it collected up to the abort. Partial results are honored; the scenario is still marked failed because not all assertions could be evaluated.

### Chaos executor

[`packages/simulation/engine/src/kinds/chaos/executor.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/kinds/chaos/executor.ts)

The chaos executor delegates the tick loop to the same shared `runLoadWindow` driver the load kind uses ([`packages/simulation/engine/src/framework/execution/run-load-window.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/framework/execution/run-load-window.ts)) and supplies an `injectChaos` callback per the Template Method pattern. The full sequence:

1. Run the steady-state window via `runLoadWindow(config, ctx, { windowMs: duration*1000, injectChaos })`. The callback fires per-request: at `chaos.probability` it returns a `chaos-event` outcome (recording a `ChaosEvent`); otherwise it returns `null` and the loop falls through to the default 95% success roll.
2. Run the recovery window via `runLoadWindow(config, ctx, { windowMs: recoveryWindow })` — no `injectChaos` hook means chaos is off and only the default success roll applies.
3. Evaluate the `steadyStateAssertions` against the steady window's metrics.
4. Evaluate the `recoveryAssertions` against the recovery window's metrics.

The result type is `ChaosScenarioExecutorResult` — load metrics plus the steady-state and recovery verdicts. Pass/fail is the AND of every steady-state and recovery assertion.

The bundled `ChaosType` set ([`packages/simulation/engine/src/types/base-types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/types/base-types.ts)) is `'latency' | 'error' | 'timeout' | 'rate-limit' | 'connection-drop' | 'data-corruption'`. Each type has its own `*ChaosConfig` payload (e.g. `LatencyChaosConfig` with `minMs`/`maxMs`; `ErrorChaosConfig` with `statusCode`/`message`). `target` is a free-form pattern matched against the request's service or endpoint — there's no fixed `database`/`cache`/`service` enum.

### Invariant executor

[`packages/simulation/engine/src/kinds/invariant/executor.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/kinds/invariant/executor.ts)

The invariant executor drives a workflow-integration lifecycle, not a property-based test loop:

1. Build an `InvariantContext` backed by the configured drivers (`deps`). Defaults are throw-on-call stubs; tests inject fakes via `deps`.
2. Run `setup(ctx)` — seed tenants, register fakes, configure the world.
3. Run `act(ctx)` — emit signals, dispatch agents, advance reconcilers.
4. Run `assert(ctx)` — call `ctx.expectStage`, `ctx.expectOutcome`, `assertEquals`, `assertThat`, etc. Each assertion is recorded into `state.assertions`.
5. Each phase's status (`pass`/`fail`/`error`/`aborted`) and duration are captured into the `phases` log.

All three callbacks have signature `(ctx: InvariantContext) => Promise<void>` — none takes or returns state. There is no random operation sequence, no counterexample capture, no RNG seed preservation; the model is "set up the world, act on it, observe via expectations."

The result type is `InvariantScenarioExecutorResult` ([`packages/simulation/engine/src/framework/scenario-executor-result.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/framework/scenario-executor-result.ts)): `outcome.phases` (per-phase status + duration) and `outcome.assertions` (the assertion records the assert phase produced). Pass/fail = every assertion held AND every phase ended in `pass`.

### Fix-evaluation executor

[`packages/simulation/engine/src/kinds/fix-evaluation/executor.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/kinds/fix-evaluation/executor.ts)

> **Deferred — not yet available.** The harness below is the intended design; it is **not wired** today. Running a fix-evaluation scenario returns an explicit *"unavailable — fix-evaluation harness deferred"* placeholder (`outcome.harnessAvailable: false`), never a real verdict. The steps below describe the planned behavior.

The most complex and the most experimental:

1. Fetch the corpus — a sample of past signals matching `corpus.signalRuleId`, drawn from cloud storage or a local fixture.
2. For each signal: invoke the configured agent to generate a fix, score the output with each `predicate` ([`packages/simulation/engine/src/kinds/fix-evaluation/predicates/`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/kinds/fix-evaluation/predicates/)).
3. Aggregate: how many signals scored above threshold for each predicate.
4. Pass/fail: aggregate score ≥ `scoreThreshold` for all predicates.

The result type is `FixEvaluationScenarioExecutorResult` — carries `corpusSize`, `fixesGenerated`, per-predicate score breakdowns, and a `scoreSummary` for the whole evaluation.

The fix-evaluation executor is where opensip-tools sim integrates with OpenSIP Cloud's continuous-learning loop: a corpus replay is what tells the cloud whether a new agent prompt or model is better than the current one. This integration is deliberately optional — the executor works against local corpora too, and a fix-evaluation scenario that runs without cloud access still produces useful local results.

---

## Sequential vs. parallel

The recipe's `execution.mode` decides ordering:

- **`sequential`** — one scenario at a time. The default for sim recipes. Required for load and chaos scenarios that drive the same target system: running them in parallel would create cross-contamination (latency injected for chaos #1 affects load #2's measurements).
- **`parallel`** — N scenarios at once, bounded by `maxParallel`. Safe for invariant scenarios (each invariant is pure) and for fix-evaluation scenarios that fan out across independent corpus items.

The recipe service ([`packages/simulation/engine/src/recipes/service.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/simulation/engine/src/recipes/service.ts)) dispatches based on mode. Sequential dispatch awaits each scenario's result before starting the next; parallel uses a `Promise.all`-with-concurrency wrapper similar to fit's parallel dispatcher.

The `--kind` CLI filter (`opensip-tools sim --kind invariant`) narrows the recipe-selected scenarios to a single kind **before they run** — filtered-out scenarios (including `load` and `chaos`, which have real side effects) are never executed, only to be hidden afterward. It applies on top of the recipe's own selector: if your recipe selects `{ type: 'all' }` and you pass `--kind invariant`, you run the invariant subset and nothing else. An unknown `--kind` is a configuration error, raised before any scenario runs.

---

## The aggregated result

After every scenario runs, the recipe service produces a `SimDoneResult` ([`packages/contracts/src/command-results.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/contracts/src/command-results.ts)):

```ts
interface SimDoneResult {
  type: 'sim-done';
  recipeName: string;
  cwd: string;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  scenarios: {
    scenarioId: string;
    scenarioName: string;
    kind: 'load' | 'chaos' | 'invariant' | 'fix-evaluation';
    passed: boolean;
    durationMs: number;
    error?: string;
  }[];
  durationMs: number;
  shouldFail?: boolean;        // any scenario failed
}
```

This is the union member that the renderer consumes (the `App.tsx` dispatcher in [`packages/cli/src/ui/`](https://github.com/opensip-ai/opensip-tools/blob/v2.6.1/packages/cli/src/ui/) switches on `result.type`). It's also the shape `--json` serializes.

Per-kind details (the load p99, the invariant counterexample, the chaos recovery time) are *not* in `SimDoneResult.scenarios[]`. They're in the executor result, which lives in the run's session record on disk under `<project>/opensip-tools/.runtime/sessions/{timestamp}-sim-{recipe?}.json`. The dashboard reads the session record to show full per-kind detail; the CLI summary stays compact.

---

## Exit semantics

Same shape as fit:

| Code | Meaning |
|---|---|
| `0` | Every scenario passed. |
| `1` | At least one scenario failed (assertion violation, predicate failure, timeout). |
| `2` | Runtime error before scenarios could run (config invalid, plugin failed to load, agent provider unreachable). |

CI integrations can gate on the exit code or parse the JSON output — same as fit.

---

## What this doesn't do

A few intentional non-features:

- **No retry.** A failed scenario fails the run. The framework doesn't retry on the assumption that flakiness is itself a failure mode worth surfacing. If a scenario is genuinely non-deterministic, the author should fix it (use a deterministic RNG, raise tolerances) rather than depending on retry.
- **No cross-scenario state.** Each scenario's executor gets a fresh context. Scenario A can't tell Scenario B "I left a record in the database for you." Composition happens at the recipe level (run A then B), not at the data level.
- **No incremental mode.** The full recipe always runs. Unlike fit, where the gate baseline lets you tolerate existing failures, sim has no equivalent. A failing load scenario fails the run, every run.
- **No live progress streaming over JSON.** `--json` mode prints the result *after* the run completes. Live streaming (which fit's Ink view does) is the table-mode path; CI consumers see the final shape.

---

## Where the example lands

For `acme-api` running `opensip-tools sim --recipe pre-deploy`:

1. The recipe selects `{ type: 'tags', include: ['load', 'chaos'] }`. Three scenarios match: `api-checkout-burst` (load), `payment-burst` (load), `kill-database-recovers` (chaos).
2. Mode is `sequential`. Total expected duration: ~5 minutes.
3. Scenario 1 (`api-checkout-burst`) runs for 30s. Hits 200 RPS, p99 = 173ms, error rate = 0.4%. All assertions pass. ✓
4. Scenario 2 (`payment-burst`) runs for 60s. Hits 50 RPS, p99 = 1100ms — fails the `p99-under-500ms` assertion. ✗
5. Scenario 3 (`kill-database-recovers`) runs for 75s. Base load + DB kill at t=10, recovery at t=22. Recovers within 12s, fails the `recoverWithin: 10s` assertion. ✗
6. `SimDoneResult.shouldFail = true`. Exit code 1. CI's pre-deploy job blocks the deploy.

The session record carries the full per-scenario results; the dashboard shows latency histograms, the chaos recovery curve, and the assertion verdicts.

---

## What's next

- **[`../80-implementation/`](/docs/opensip-tools/80-implementation/)** — how the CLI dispatches both fit and sim. Plugin loading, session writing, persistence layout.
- **[`../50-extend/01-plugin-authoring.md`](/docs/opensip-tools/50-extend/01-plugin-authoring/)** — author your first sim scenario.
