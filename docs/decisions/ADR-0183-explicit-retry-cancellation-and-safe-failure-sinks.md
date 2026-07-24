---
status: active
last_verified: 2026-07-23
owner: opensip-cli
---

# ADR-0183: Explicit retry, cancellation, and safe failure sinks

```yaml
id: ADR-0183
title: Explicit retry, cancellation, and safe failure sinks
date: 2026-07-23
status: active
supersedes: []
superseded_by: null
related: [ADR-0181, ADR-0054, ADR-0077, ADR-0175]
tags: [errors, retry, cancellation, security, cli]
enforcement: mechanizable
enforced-by: ['type-structural', 'script:retry.test', 'script:interrupt-abort.test', 'script:safe-diagnostic-data.test']
```

**Decision:** Retry defaults come from `ErrorDefinition.retry`, but callers own max attempts, deadlines, idempotency, and protocol facts. Backoff and work honor `AbortSignal`. OS SIGINT/SIGTERM map to one host root `AbortSignal` with cooperative cancel then POSIX 130/143; a second interrupt escalates. Semantic redaction/bounding runs before public, worker, log, and network sinks; terminal ANSI and HTML encoding stay at final sinks only.

**Alternatives:**

- **Retry every throw** — rejected; amplifies non-idempotent and validation failures.
- **Independent per-package retry loops** — rejected; drift and uncancelable sleep.
- **Caller-only sanitization** — rejected; easy to miss at egress/workers.
- **Raw stack as primary crash UX** — rejected; uncoded, unsafe, non-agent-friendly.
- **Uncoordinated `process.kill` on Ctrl-C** — rejected; races workers/MCP shutdown.

**Rationale:** CLI and workers share one cancel tree (`ToolScope.abortSignal`) distinct from cloud `signalSink`. Injectable clock/jitter/sleep make resilience tests deterministic (ADR-0169). Observer callbacks cannot throw into the operation outcome. Worker IPC carries machine failure projections without raw `Error`/`cause`/stack.

**Consequences:**

- Use `withRetry` / abort-aware execution primitives; hand-rolled retry is Plan 01 debt.
- Cancelled vs timeout vs operation failure remain distinguishable codes/exit classes.
- Sinks use `toSafeDiagnosticData` / envelope projections; never log raw secrets under innocuous keys without allowlists.
- Temporary inventory ratchet (`error-inventory:ratchet`) blocks new structural debt during Plan 01 migration.

**Related ADRs:** ADR-0181 (definitions/envelope), ADR-0054 (workers), ADR-0077 (`reportFailure`), ADR-0175 (JSON-safe data).
