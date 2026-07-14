# Sim Proof-of-Value Examples

## Status

Backlog discovery item. Do not expand `sim` merely to make an example possible.
The work must first prove that a real OpenSIP CLI use case benefits from the
simulation abstraction more than it would from an integration test, the
development-only performance lane, or a mature external load-testing tool.

## Priority

Medium, with a product-retention decision attached. `sim` is bundled and
customer-facing, but the current generated example only sleeps and reports
synthetic latency. That proves the extension mechanics; it does not prove why
OpenSIP CLI customers should use the Tool.

## Problem

OpenSIP CLI needs at least one authentic, maintained `sim` scenario that:

- exercises a real shipped OpenSIP surface;
- demonstrates a customer decision that `fit`, `graph`, tests, and benchmarks do
  not already answer more directly;
- is useful to human operators and AI-agent consumers; and
- can be adapted by a customer without importing private OpenSIP internals.

Without that evidence, keeping a generic load/chaos Tool in the bundled product
creates documentation, compatibility, and maintenance cost without a validated
customer benefit.

## Recommended First Proof

Use the OpenSIP MCP evidence server as the first and strongest candidate:

1. Build or load a real graph catalog and start one `opensip mcp` process.
2. Drive a bounded concurrent mix of representative agent reads, such as agent
   catalog discovery, symbol/declaration search, callers/callees, references,
   blast radius, context status, and test selection.
3. Assert protocol correctness, zero cross-request state contamination,
   consistent catalog-generation identity, bounded latency/error rates, and
   continued service after abandoned requests.
4. Exercise only faults `sim` can honestly claim to control, such as client
   cancellation, delay, and dropped requests. Do not describe those as
   server-side process or network sandbox fault injection.
5. Preserve the result through the normal signal, session, JSON, and report
   surfaces so both humans and agents can consume the verdict.

This candidate is OpenSIP-specific and maps directly to simultaneous AI-agent
customers. Batch `fit`, `graph`, and report commands are not preferred examples;
their startup, throughput, and memory behavior belongs in tests and the
development-only performance/SLO lane.

## Discovery Questions

- Can public `sim` APIs manage a long-lived MCP child process and client
  connection with deterministic setup, readiness, cancellation, and teardown?
- Does `sim` need a small general scenario lifecycle contract, or would adding
  one be disproportionate to the demonstrated use case?
- Can the scenario detect a seeded realistic defect, such as cancellation
  poisoning later requests, request-state leakage, an unresponsive server, or a
  material latency regression?
- What does `sim` add beyond a Vitest integration test or an external load tool:
  reusable project scenarios, load/chaos orchestration, OpenSIP signals,
  sessions, gates, or report evidence?
- Can a customer copy the pattern to exercise its own MCP or agent-facing
  service using only documented APIs?

## Acceptance Criteria

- Add at least one real, deterministic, local/offline OpenSIP-owned example; do
  not count the synthetic sleep scaffold.
- Exercise a shipped surface through public contracts with bounded resources and
  reliable cleanup on pass, failure, timeout, and cancellation.
- Add a seeded-regression test proving the scenario changes a meaningful verdict.
- Document what is measured, what fault boundary is controlled, and what is not
  proven.
- Compare the implementation with a normal integration test and an established
  load tool, and record the unique value supplied by `sim`.
- If the MCP candidate succeeds, replace or supplement the generated sleep
  example with the authentic example and keep it covered by CI.
- Keep the Plan 6 benchmark/profile lane separate; it remains repository-only
  contributor infrastructure and is not a simulation scenario.

## Product Decision / Kill Criterion

After the bounded MCP proof, explicitly decide whether `sim` has earned its
bundled product surface. Deprecate/remove it from OpenSIP CLI, or move the
runtime-simulation concept to the OpenSIP platform, if the proof cannot produce
decision-changing evidence without OpenSIP-specific framework hacks, if an
ordinary integration test is clearer, or if a mature external load tool serves
customers better.

Do not retain or expand the Tool because of sunk implementation cost.

## Non-Goals

- Moving the repository performance benchmark into `sim`.
- Adding model calls or autonomous mutation to OpenSIP CLI.
- Claiming portable network isolation or server-side chaos from client-side
  delay/abort/drop behavior.
- Building a generic competitor to k6, Artillery, or similar load-testing tools.
- Creating multiple examples before the first example proves distinct value.

## Relevant Sources

- `packages/simulation/engine/src/scaffold/examples.ts`
- `packages/simulation/engine/src/framework/runnable-scenario.ts`
- `packages/simulation/engine/src/framework/execution/target.ts`
- `packages/simulation/engine/src/types/kind-types.ts`
- `packages/simulation/engine/src/recipes/types.ts`
- `docs/public/30-sim/01-scenarios-and-recipes.md`
- `docs/public/30-sim/02-execution-model.md`
- `docs/decisions/ADR-0118-scale-and-performance-slos.md`
