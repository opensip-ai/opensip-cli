---
status: active
last_verified: 2026-07-13
owner: opensip-cli
---

# ADR-0163: Keep local CPU profiling independent of OTel export

```yaml
id: ADR-0163
title: Keep local CPU profiling independent of OTel export
date: 2026-07-13
status: active
supersedes: [ADR-0049]
superseded_by: null
related: [ADR-0004, ADR-0118]
tags: [observability, profiling, performance, security]
enforcement: mechanizable
enforced-by: ['depcruise:otel-sdk-only-in-cli', 'type-structural']
enforcement-reason: >
  Dependency-cruiser confines telemetry SDK ownership to the CLI composition
  root. The governed environment surface and focused profiler lifecycle,
  artifact-path, worker-propagation, and benchmark-mode tests enforce the
  independent gates and bounded local-artifact contract.
```

**Decision:** Local Node inspector CPU profiles and OpenTelemetry export have
independent, explicit gates. `OPENSIP_PROFILING=1` or `true` enables a local CPU
profile whether or not `OTEL_EXPORTER_OTLP_ENDPOINT` is set. An unset value,
`0`, or `false` keeps profiling off. An OTLP endpoint alone may enable tracing
and metrics but never creates a CPU-profile artifact.

The CLI composition root owns profiler and telemetry lifecycle wiring. Profile
state belongs to the current invocation's `RunScope`; only the documented
process-global active-profiler coordination needed to protect Node's singleton
inspector session may be shared. Tools and `@opensip-cli/core` do not acquire a
profiler SDK or write profile artifacts.

`OPENSIP_PROFILE_DIR` optionally selects the local artifact directory. Relative
paths resolve from the invocation working directory. The CLI sanitizes bounded
filenames, rejects path escape, creates files exclusively with owner-only
permissions, and records only bounded artifact metadata in reports. It does not
embed `.cpuprofile` or `.labels.json` contents. Start, stop, and shutdown are
awaited and best-effort: a profiler failure must not replace the command's
result, and shutdown still runs when the OTel SDK is absent.

Performance evidence has two explicit modes. `clean-wall` runs disable CPU
profiling and OTLP export and are the only evidence eligible for SLO budgets,
public benchmark snapshots, or wall-time improvement claims. `cpu-profile` and
optional loopback-OTLP runs locate work; they require paired clean-wall evidence
to prove a customer-visible win.

Pyroscope is deferred for this optimization cycle. The built-in inspector,
existing OTel spans, graph-stage profiles, and startup diagnostics answered the
ranked hotspot questions without a new runtime dependency, hosted endpoint, or
collector requirement. A later ADR may propose a continuous-profiler adapter
only after those local surfaces fail to answer a concrete, measured question.

**Alternatives:**

- Require an OTLP endpoint before local profiling — rejected because writing a
  local diagnostic artifact does not require network export and the coupling
  made offline investigation unnecessarily difficult.
- Let an OTLP endpoint implicitly enable profiles — rejected because traces and
  profiles have different cost, retention, and data-sensitivity postures.
- Add Pyroscope now — rejected for this cycle because it supplied no missing
  evidence for the finite hotspot ranking and would add dependency and operator
  cost.
- Put profiler ownership in core or tool packages — rejected because it breaks
  the composition-root boundary and makes the inert path carry infrastructure.

**Rationale:** Humans and agents need repeatable performance evidence without
surprising network or artifact side effects. Independent gates make both
effects observable and composable, while clean measurement modes keep profiler
overhead out of regression budgets and public claims. Local, bounded artifacts
also preserve OpenSIP CLI's offline-first posture.

**Consequences:** ADR-0049 is superseded. Metrics and tracing retain the
OpenTelemetry endpoint gate from ADR-0004; local CPU profiling uses its own
explicit gate. Benchmark and documentation surfaces must label measurement
mode, reject profiled input at budget/public-snapshot boundaries, and treat
profile artifacts as sensitive local files rather than stored sessions or
default CI uploads.

**Related specs / ADRs:** [ADR-0004](ADR-0004-opt-in-opentelemetry.md) owns the
OTel export posture. [ADR-0118](ADR-0118-scale-and-performance-slos.md) owns the
deterministic SLO lane. This decision implements the profiling boundary in the
performance optimization program.
