---
status: current
last_verified: 2026-06-07
release: v0.1.14
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
related-docs:
  - ./01-scenarios-and-recipes.md
  - ../10-concepts/01-fitness-loop.md
---
# Sim execution model

The sim engine has the same architectural shape as fit's recipe engine — selector → list → dispatch → run → aggregate → render — but the per-scenario executor is kind-specific. This doc walks the run.

> **What you'll understand after this:**
> - The two executors (load, chaos) and what each does.
> - How sequential vs. parallel execution affects scenarios that share state.
> - The shape of the per-kind executor result.
> - How the run aggregates into a `SimDoneResult`.

---

## The lifecycle

```
opensip sim --recipe <name>
  → simulationTool.action(opts)
       → executeSim(args)                                                   ↓
            → loadProjectConfig + load sim-domain plugins                     │
            → resolve recipe (or default)                                    │
            → expand selector → scenario list                                │
            → for each scenario (in mode order):                             │
                 ┌─────────────────────────────────────────────────────┐    │
                 │  await scenario.run(ctx)   /* polymorphic */        │    │
                 │                                                     │    │
                 │  Extension points (not runtime dispatch — the       │    │
                 │  RunnableScenario produced by define*Scenario       │    │
                 │  already carries the kind-bound run() method):      │    │
                 │      kind 'load'   → kinds/load/executor            │    │
                 │      kind 'chaos'  → kinds/chaos/executor           │    │
                 └─────────────────────────────────────────────────────┘    │
            → aggregate results into SimDoneResult                           │
       → render (Ink or JSON)                                                │
       → set exit code (1 if any scenario failed)                            ▼
                                                                       shell prompt
```

Both executors live under [`packages/simulation/engine/src/kinds/<kind>/executor.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/simulation/engine/src/kinds/). Each accepts a kind-specific config (validated at `define*Scenario` time, carrying the BYO `target` + `workload`) and a `ScenarioExecutionContext` (signal/abort, correlation id, logger).

---

## The executors

### Load executor

[`packages/simulation/engine/src/kinds/load/executor.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/simulation/engine/src/kinds/load/executor.ts)

The load executor delegates to the shared `runLoadWindow` driver
([`packages/simulation/engine/src/framework/execution/run-load-window.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/simulation/engine/src/framework/execution/run-load-window.ts)). Its job:

1. **Ramp + pace.** Increase the issue rate from 0 to `workload.rps` over `workload.rampUp` seconds, then sustain for `duration` seconds.
2. **Drive the target.** Per request: call `config.target`, bounded by `workload.concurrency` in-flight; resolve = success, throw/abort = failure. Measure real wall-clock latency.
3. **Collect.** Aggregate `SimulationMetrics` — total/successful/failed requests, error count, p50/p95/p99 latency.
4. **Assert.** Run each `assertion` against the measured metrics. The scenario passes iff every assertion passes.

The result type is `LoadScenarioExecutorResult` — carries the `SimulationMetrics` plus the assertion verdicts.

A load scenario that's interrupted (signal abort, timeout) drains in-flight requests, then returns the metrics collected up to the abort.

### Chaos executor

[`packages/simulation/engine/src/kinds/chaos/executor.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/simulation/engine/src/kinds/chaos/executor.ts)

The chaos executor drives the same shared `runLoadWindow` driver, but wraps the target with the **fault model** ([`packages/simulation/engine/src/framework/execution/fault-model.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/simulation/engine/src/framework/execution/fault-model.ts)) for the steady-state window. The full sequence:

1. Build the fault model from `config.fault` (with an injectable RNG — `Math.random` in production, a stub in tests). Run the steady-state window: `runLoadWindow({ workload }, ctx, { windowMs: duration*1000, target: faultModel.wrap(config.target) })`. Per request, at `fault.probability` the model perturbs the **real** call — adds latency, aborts it, or drops it (recording a `ChaosEvent`); otherwise the call passes through unperturbed.
2. Run the recovery window: `runLoadWindow({ workload }, ctx, { windowMs: recoveryWindowMs, target: config.target })` — the **bare** target, faults lifted.
3. Evaluate the `steadyStateAssertions` against the steady window's measured metrics.
4. Evaluate the `recoveryAssertions` against the recovery window's measured metrics.

The result type is `ChaosScenarioExecutorResult` — steady + recovery `SimulationMetrics`, the per-phase assertion verdicts, and the `ChaosEvent[]`. Pass/fail is the AND of every steady-state and recovery assertion.

The shipped fault vocabulary ([`packages/simulation/engine/src/framework/execution/fault-spec.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/simulation/engine/src/framework/execution/fault-spec.ts)) is the **client-side** set: `'latency'` (delay the call), `'abort'` (cancel the in-flight request), `'drop'` (skip it, counting a client-observed failure). Server-side faults (500s, killed dependencies) are not injected here — point the `target` at a fault-injectable endpoint you control (see the honesty boundary in [`01-scenarios-and-recipes.md`](/docs/opensip-cli/30-sim/01-scenarios-and-recipes/)).

---

## Sequential vs. parallel

The recipe's `execution.mode` decides ordering:

- **`sequential`** — one scenario at a time. The default for sim recipes. Required for load and chaos scenarios that drive the same target system: running them in parallel would create cross-contamination (latency injected for chaos #1 affects load #2's measurements).
- **`parallel`** — N scenarios at once, bounded by `maxParallel`. Safe for scenarios that fan out across independent inputs and don't share a target system.

The recipe service ([`packages/simulation/engine/src/recipes/service.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/simulation/engine/src/recipes/service.ts)) dispatches based on mode. Sequential dispatch awaits each scenario's result before starting the next; parallel uses a `Promise.all`-with-concurrency wrapper similar to fit's parallel dispatcher.

A recipe's `kind` selector narrows the selected scenarios to one or more kinds **before they run** — non-matching scenarios (which have real side effects) are never executed.

---

## The aggregated result

After every scenario runs, the recipe service builds the run's **`SignalEnvelope`** (each scenario is a *unit* that produces signals, ADR-0011) and returns it inside a `SimDoneResult` ([`packages/contracts/src/command-results.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/contracts/src/command-results.ts)):

```ts
interface SimDoneResult {
  type: 'sim-done';
  recipeName: string;
  cwd: string;
  durationMs: number;
  envelope: SignalEnvelope;    // the run's signals + verdict + per-scenario units
}
```

There is no pass/fail boolean on the result: the run verdict lives on `envelope.verdict` (ADR-0035 — the tool declares its policy; the **host** derives the findings exit code from the envelope when the signals are delivered, so sim never calls `setExitCode` for scenario failures).

`SimDoneResult` is the internal `CommandResult` union member the renderer consumes (the `App.tsx` dispatcher in [`packages/cli/src/ui/`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.14/packages/cli/src/ui/) switches on `result.type`); it derives the per-scenario table from `envelope.units` (one unit per scenario — `slug` = scenario id, `passed`, `durationMs`, `error?`). The **`--json` output wraps the `envelope` in a `CommandOutcome`** (the byte-identical `SignalEnvelope` `fit` and `graph` emit, nested under `.envelope`) — the old bespoke `sim-done` JSON shape is retired. See [`70-reference/04-json-output-schema.md`](/docs/opensip-cli/70-reference/04-json-output-schema/).

Per-kind details (the load p99, the chaos recovery time) are *not* in the envelope. They're in the executor result, which rides in the session's `session_tool_payload` row persisted to the project-local SQLite store (`<project>/opensip-cli/.runtime/datastore.sqlite`) via `SessionRepo`. The dashboard reads the session record to show full per-kind detail; the CLI summary stays compact.

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

For `acme-api` running `opensip sim --recipe pre-deploy`:

1. The recipe selects `{ type: 'tags', include: ['load', 'chaos'] }`. Three scenarios match: `api-checkout-burst` (load), `payment-burst` (load), `checkout-resilient-under-fault` (chaos).
2. Mode is `sequential`. Total expected duration: ~5 minutes.
3. Scenario 1 (`api-checkout-burst`) runs for 30s. Hits 200 RPS, p99 = 173ms, error rate = 0.4%. All assertions pass. ✓
4. Scenario 2 (`payment-burst`) runs for 60s. Hits 50 RPS, p99 = 1100ms — fails the `p99-under-500ms` assertion. ✗
5. Scenario 3 (`checkout-resilient-under-fault`) runs a 30s steady-state window with latency/drop faults injected at 10%, then a 10s recovery window. The recovery window's p95 stays at 1300ms — fails the recovery `ASSERTIONS.lowLatency('p95', 500)` assertion. ✗
6. Two scenario units failed, so `envelope.verdict.passed === false`; the host derives exit code 1 from the envelope verdict. CI's pre-deploy job blocks the deploy.

The session record carries the full per-scenario results; the dashboard shows latency histograms, the chaos recovery curve, and the assertion verdicts.

---

## What's next

- **[`../80-implementation/`](/docs/opensip-cli/80-implementation/)** — how the CLI dispatches both fit and sim. Plugin loading, session writing, persistence layout.
- **[`../50-extend/01-plugin-authoring.md`](/docs/opensip-cli/50-extend/01-plugin-authoring/)** — author your first sim scenario.
