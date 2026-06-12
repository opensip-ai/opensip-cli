---
status: active
last_verified: 2026-06-02
owner: opensip-cli
---

# ADR-0004: Opt-in OpenTelemetry — env-var gate, API in core / SDK at the boundary

```yaml
id: ADR-0004
title: Opt-in OpenTelemetry — env-var gate, API in core / SDK at the boundary
date: 2026-05-30
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: []               # supersedes the backlog `engine-otel-opt-in` design (a plan, not an ADR)
tags: [observability, telemetry, layering, packaging]
enforcement: mechanizable
enforcement-reason: >
  dependency-cruiser (run by `pnpm lint`) confirms no `@opentelemetry/sdk-*`
  import leaks into `core` or any tool package — adding the SDK to the kernel
  or a tool is a layering violation. The no-op contract is additionally
  asserted by tests across all three layers (core primitive, CLI SDK init,
  graph stage spans).
```

**Decision:** OpenTelemetry is **opt-in**, gated solely on the presence of
`OTEL_EXPORTER_OTLP_ENDPOINT` (no bespoke flags). `@opentelemetry/api` (the no-op
facade) is the only OTel dependency in `core` and in tool packages, surfaced
through a `withSpan` / `getTracer` seam in `core` (`core/src/lib/telemetry.ts`);
the **SDK** (exporter, context manager, propagator, resources) lives **only** in
`@opentelemetry/cli`, the composition root, initialized from `bootstrapCli`.
Tools wrap their phase boundaries with `withSpan` and never import the OTel API
directly.

**Alternatives:**
- _SDK init inside the graph engine_ (the backlog `engine-otel-opt-in` design) —
  rejected: it scopes telemetry to one tool and would force either three SDK-init
  copies (one per tool) or a later refactor — tech debt the guardrails forbid.
- _On-by-default with a kill-switch_ — rejected: the standalone CLI is the default
  mode and has no collector, so an on-by-default exporter would attempt network
  I/O against a non-existent endpoint on every run. The env-var gate makes "no
  endpoint configured" mean "telemetry is inert" — the pit of success for the
  common case.
- _SDK as a hard dependency of `core`/tools_ — rejected: the SDK pulls in an
  exporter, context manager, and protocol machinery that a strict kernel or a
  tool should not carry.

**Rationale:** This is the canonical OpenTelemetry **library/application** split.
`@opentelemetry/api` does nothing until an SDK registers a global
`TracerProvider`, so importing it costs nothing at runtime in standalone mode;
deciding *whether spans are exported* once, at the application boundary, is what
lets the substrate generalize to `fit`/`sim` later with zero new plumbing — each
tool just wraps its phase boundaries in the `withSpan` API seam. Standalone
behavior is byte-for-byte unchanged (additive, opt-in, no backwards-compat
surface). For embedding consumers that spawn the binary as a subprocess, the SDK
extracts a `TRACEPARENT` env var via the W3C propagator so child spans nest under
the consumer's trace, and consumer-supplied `OTEL_RESOURCE_ATTRIBUTES` (e.g.
`tenant_id=…,run_id=…`) flow in via the env resource detector — giving the
per-stage attribution (discover, inventory, edges, indexes, rules, render) that
diagnoses slow tenant ingestion, which a parent-only span cannot see inside the
child.

**Consequences:**
- Standalone users pay nothing; the no-op contract is asserted in tests across all
  three layers.
- `core` re-exports the `Span`/`Attributes`/`Tracer` types so the kernel stays the
  single telemetry seam (consistent with the "prefer the package barrel" rule);
  `graph` is the first consumer (its `runStage` funnel is wrapped, one span per
  stage), and `fit`/`sim` instrumentation is later a localized `withSpan` wrap with
  no new infrastructure.
- A `BatchSpanProcessor` buffers spans; the CLI flushes them via
  `shutdownTelemetry()` in a top-level `finally` before the short-lived process
  exits.
- Exporter resilience (a dead collector must degrade to "no telemetry," not a
  broken run) is partially handled (`shutdownTelemetry` swallows shutdown errors)
  and otherwise flagged for a hardening pass.

**Validation:** Validated **in-process** (no live infrastructure; runs in CI):
- **Core no-op contract** (`packages/core/src/lib/__tests__/telemetry.test.ts`):
  with no SDK, `withSpan` runs `fn`, returns its value, the span is non-recording,
  and on throw it records the exception, sets ERROR status, ends the span, and
  rethrows.
- **CLI SDK gate** (`packages/cli/src/telemetry/__tests__/sdk-init.test.ts`):
  endpoint unset ⇒ no provider; set ⇒ exactly one provider, idempotent;
  `TRACEPARENT` extracted into a parent context; `shutdownTelemetry` resolves in
  both modes.
- **Graph stage spans** (`packages/cli/src/telemetry/__tests__/graph-spans.test.ts`,
  via `InMemorySpanExporter` which lives in `cli`): a `runGraph` run emits the six
  `opensip_cli.graph.<stage>` spans in `GRAPH_STAGES` order with stage +
  orchestrator attributes, all nesting under an active parent's trace id; with no
  provider it emits nothing.
- **Graph no-op invariant**
  (`packages/graph/engine/src/cli/__tests__/orchestrate-spans.test.ts`, no SDK in
  the tool package): `runGraph` completes identically and its stage spans are
  non-recording with no provider.

Still requires a **real OTLP collector** (out of CI scope; see
`docs/plans/ready/telemetry-opt-in/phase-4-validation.md`): OTLP/HTTP over the
wire, end-to-end resource-attribute propagation from a spawned subprocess, and the
standalone "no network attempt / no measurable overhead" timing comparison.

**Related specs / ADRs:** Implemented per `docs/plans/ready/telemetry-opt-in/`
(Phases 0–2). Supersedes the backlog `engine-otel-opt-in` design (engine-local SDK
placement). _(Migrated 2026-06-02 from `docs/internal/decisions/01-otel-opt-in.md`,
where it was recorded as "DEC 01" on 2026-05-30 before the `ADR-NNNN` log
existed.)_
