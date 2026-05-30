---
status: current
last_verified: 2026-05-30
decision_date: 2026-05-30
supersedes: docs/plans/backlog/engine-otel-opt-in/ (engine-local SDK placement)
superseded_by:
---
# DEC 01: Opt-in OpenTelemetry — env-var gate + API-in-core / SDK-in-cli layering

## Status

Current. Implemented on branch `feat/telemetry-opt-in` (Phases 0–2 of
`docs/plans/ready/telemetry-opt-in/`). Supersedes the backlog
`engine-otel-opt-in` design, which scoped telemetry to the graph engine and
placed the SDK init inside it.

## Context

The platform emits structured logs (Pino → stderr) but no OpenTelemetry spans.
For **standalone** users (`opensip-tools graph` in a terminal) that is correct —
they have no OTLP endpoint. For an **embedding consumer** that spawns the binary
as a subprocess, the parent can wrap the spawn in a span but cannot see inside
the child: a "30s graph run" with no per-stage breakdown (discover, inventory,
edges, indexes, rules, render). Per-stage attribution is exactly what diagnoses
slow tenant ingestion in production.

The backlog design put `sdk-init.ts` in the graph engine. Generalizing from
there would force either three copies of the SDK init (one per tool) or a
later refactor — tech debt the project's guardrails forbid.

## Decision

### 1. Telemetry is opt-in, gated on `OTEL_EXPORTER_OTLP_ENDPOINT`

Presence of the env var triggers SDK registration. Absence ⇒ no init, no
exporter, no provider, zero overhead. There are **no flags** beyond the standard
OTel env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`,
`TRACEPARENT`). Standalone behavior is byte-for-byte unchanged — this is
additive and opt-in, with no backwards-compatibility surface to preserve.

**Why opt-in (not on-by-default-with-a-kill-switch):** the standalone CLI is the
default mode and has no collector. An on-by-default exporter would attempt
network I/O against a non-existent endpoint on every run. The gate makes "no
endpoint configured" mean "telemetry is inert," which is the pit of success for
the overwhelmingly common case.

### 2. API in the kernel, SDK at the boundary

This is the canonical OpenTelemetry **library/application** split:

- **`@opentelemetry/api`** (the no-op facade) is the ONLY OTel dependency in
  `core` and in tool packages. It does nothing until an SDK registers a global
  `TracerProvider`, so importing it costs nothing at runtime in standalone mode.
  `core` exposes the `withSpan` / `getTracer` seam over it (`core/src/lib/telemetry.ts`),
  the tracing sibling of `logger`.
- **The SDK** (`@opentelemetry/sdk-trace-node`, the OTLP exporter,
  `context-async-hooks`, the W3C propagator in `@opentelemetry/core`,
  `resources`, `semantic-conventions`) lives ONLY in `@opentelemetry/cli` — the
  composition root, which already owns process-level setup (registries,
  `RunScope`, logger config). It is wired in `cli/src/telemetry/sdk-init.ts` and
  initialized from `bootstrapCli`.

**Why the SDK is not a hard dependency of core/tools:** the SDK pulls in an
exporter, a context manager, and protocol machinery — none of which a strict
kernel or a tool should carry. Keeping it at the boundary is what lets the
substrate generalize to `fit`/`sim` later with zero new plumbing: each tool
just wraps its phase boundaries in `withSpan` (the API seam), and whether spans
are actually exported is decided once, at the application boundary.

**Enforcement:** `dependency-cruiser` (run by `pnpm lint`) confirms no
`@opentelemetry/sdk-*` import leaks into `core` or any tool package. Adding such
a dependency to the kernel or a tool is a violation.

### 3. Tools use the `withSpan` seam, never the OTel API directly

Tool authors call `withSpan('opensip-tools-<scope>', 'opensip_tools.<tool>.<stage>', fn, attrs?)`
imported from `@opensip-tools/core`. They never import `@opentelemetry/api`
directly — `core` re-exports the `Span`/`Attributes`/`Tracer` types so the
kernel stays the single telemetry seam, consistent with the "prefer the package
barrel" import rule. `graph` is the first consumer: its single `runStage` funnel
is wrapped, emitting one span per stage.

### 4. Parent-trace nesting + resource attributes flow from the consumer

The SDK extracts a `TRACEPARENT` env var via the W3C propagator and activates it
as the run's parent context, so child spans nest under the consumer's trace.
Consumer-supplied resource attributes (`OTEL_RESOURCE_ATTRIBUTES`, e.g.
`tenant_id=...,run_id=...`) flow in via the env resource detector. A
`BatchSpanProcessor` buffers spans; the CLI flushes them with
`shutdownTelemetry()` in a top-level `finally` before the short-lived process
exits.

## Consequences

- Standalone users pay nothing; the no-op contract is asserted in tests across
  all three layers (core primitive, CLI SDK init, graph stage spans).
- The substrate is built once and correctly; `fit`/`sim` instrumentation is a
  localized `withSpan` wrap with no new infrastructure, to be promoted when each
  tool's own production trigger fires (see the plan's "Deferred follow-on").
- Exporter resilience (a dead collector must degrade to "no telemetry," not a
  broken run) is partially handled (`shutdownTelemetry` swallows shutdown
  errors) and otherwise flagged for a hardening pass.

## Validation

Validated **in-process** (no live infrastructure required, runs in CI):

- **Core no-op contract** (`packages/core/src/lib/__tests__/telemetry.test.ts`):
  with no SDK registered, `withSpan` runs `fn`, returns its value, the span is
  non-recording, and on throw it records the exception, sets ERROR status, ends
  the span, and rethrows.
- **CLI SDK gate** (`packages/cli/src/telemetry/__tests__/sdk-init.test.ts`):
  `OTEL_EXPORTER_OTLP_ENDPOINT` unset ⇒ no provider (spans non-recording); set ⇒
  exactly one real provider, idempotent; `TRACEPARENT` extracted into a parent
  context so a child span inherits the parent trace id; `shutdownTelemetry`
  resolves in both modes.
- **Graph stage spans** — capture
  (`packages/cli/src/telemetry/__tests__/graph-spans.test.ts`, using
  `InMemorySpanExporter` from the SDK, which lives in `cli`): a `runGraph` run
  produces the six `opensip_tools.graph.<stage>` spans in `GRAPH_STAGES` order,
  each with the stage attribute plus orchestrator-level attributes (file_count,
  cache_hit, rule/signal counts), and — under an active parent context — all six
  nest under the parent's trace id. With no provider, the run emits nothing.
- **Graph no-op invariant**
  (`packages/graph/engine/src/cli/__tests__/orchestrate-spans.test.ts`, no SDK in
  the tool package): `runGraph` completes identically and its stage spans are
  non-recording when no provider is registered.

Still requires a **real OTLP collector** (Phase 4 of the plan; not runnable in
this CI environment, documented in
`docs/plans/ready/telemetry-opt-in/phase-4-validation.md`):

- OTLP/HTTP export over the wire to a running `otel-collector` (the in-process
  tests use `InMemorySpanExporter`, so the protocol/exporter path is exercised in
  init/shutdown but not asserted end-to-end against a collector).
- End-to-end resource-attribute propagation from a **spawned subprocess**
  (`OTEL_RESOURCE_ATTRIBUTES=tenant_id=…,run_id=…` + `TRACEPARENT` set by a parent
  process that spawns `opensip-tools graph`).
- The standalone "no network attempt / no measurable overhead vs a pre-plan
  build" timing comparison.
