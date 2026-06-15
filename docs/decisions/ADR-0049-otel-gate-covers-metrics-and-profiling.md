---
status: active
last_verified: 2026-06-12
owner: opensip-cli
---

# ADR-0049: OTel Gate Covers Metrics and (Optional) Profiling

```yaml
id: ADR-0049
title: OTel Gate Covers Metrics and (Optional) Profiling
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0004]
tags: [observability, telemetry, layering, packaging]
enforcement: mechanizable
enforcement-reason: >
  dependency-cruiser confirms new metrics/profiling SDK packages are imported
  only in the CLI composition root (never core or tool packages). The no-op
  contract for metrics and profiling (when the gate is closed) is asserted by
  tests parallel to the existing trace no-op tests. A follow-up fitness check
  (Phase 4A) will enforce that new hot paths in engines carry spans.
```

**Decision:** The same opt-in environment-variable gate used for tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`) is extended to cover metrics. Profiling is covered by the same gate but is **optional/severable** and, by default, further gated behind a dedicated `OPENSIP_PROFILING=1` flag (which also requires the OTEL endpoint). It remains possible to configure the system so that profiling follows the OTEL endpoint alone (with explicit documentation and warnings about cost). All new OpenTelemetry SDK packages (metrics and any profiling) are added only as runtime dependencies of the CLI composition root (`packages/cli`), never of `@opensip-cli/core` or any tool package. A committed cardinality split rule applies: spans may carry project-root-relative detail; metrics are restricted to low-cardinality labels only.

**Alternatives:**
- Introduce a completely separate env var / flag family for metrics and profiling (rejected: duplicates the propagation, resource attribute, and shutdown machinery already paid for in ADR-0004; increases surface area for embedded consumers).
- Put the metrics SDK in core or a shared package (rejected: layering violation per dependency-cruiser and the existing trace split; would force every tool and the kernel to carry SDK weight even when inert).
- Make profiling always on whenever tracing is enabled (rejected: profile-per-invocation storage and noise cost is high for a CLI; most tracing users do not want profiles).

**Rationale:**
- Preserves the load-bearing "one gate, one no-op contract, one propagation story" of ADR-0004 for standalone users and embedded hosts.
- Adding `@opentelemetry/sdk-metrics` (and its OTLP exporter) only in the CLI root keeps the kernel and tools as pure `@opentelemetry/api` consumers.
- The dedicated profiling flag gives operators explicit control over the expensive per-run profile artifact while still allowing simple "one knob" usage for teams that accept the cost.
- The cardinality split (spans vs. metrics) is recorded here so every future instrumentation site has a single source of truth instead of re-litigating per PR.
- The previous `docs/plans/ready/telemetry-opt-in/` work and the 2026-06 observability audit both showed that the existing trace seam + `sdk-init.ts` pattern generalizes cleanly to metrics and (conditionally) profiles.

**Consequences:**
- `packages/cli/package.json` gains two new runtime dependencies (pinned in `pnpm-workspace.yaml` for version consistency with the trace packages). This affects the published `opensip-cli` closure and the release ordering documented in RELEASING.md.
- Core's `telemetry.ts` grows thin `getMeter` (and optionally profiling) seams; these remain no-ops until an SDK provider is registered in the CLI root.
- A new append-only ADR (this one) extends ADR-0004. Future changes to the gate rules must supersede or relate to both.
- Documentation (env-var reference, CLAUDE.md) must describe both the primary dedicated-flag mode for profiling and the "OTEL endpoint alone" configuration option, with warnings.
- Phase 4A of the observability-hardening plan will deliver a mechanized guard (fitness check) that new expensive engine paths carry spans; that check becomes part of the enforcement story for this decision.

**Related specs / ADRs:**
- Implements and extends ADR-0004.
- Implemented by `docs/plans/specs/observability-hardening.md` and the plan under `docs/plans/ready/observability-hardening/`.
- The Phase 2 ADR task (ADR-00NN in early drafts) is realized by this document.