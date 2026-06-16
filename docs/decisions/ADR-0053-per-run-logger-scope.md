---
status: active
last_verified: 2026-06-16
owner: opensip-cli
---

# ADR-0053: Per-Run Logger Scope

```yaml
id: ADR-0053
title: Per-Run Logger Scope
date: 2026-06-16
status: active
supersedes: []
superseded_by: null
related: [ADR-0004, ADR-0024, ADR-0051, ADR-0052]
tags: [logging, run-scope, concurrency, saas, architecture]
enforcement: mechanizable
enforcement-reason: >
  Construction can be locked by unit tests that two concurrent RunScopes write
  through independent LoggerImpl instances. Existing no-module-singleton checks
  should then forbid new production configureLogger calls outside the CLI entry
  adapter.
```

**Decision:** Production run logging must move from mutating the process-wide
`logger` singleton to constructing one `LoggerImpl` per `RunScope`. The exported
singleton remains only as a compatibility adapter for pre-scope code, legacy
call sites, and tests. New run-scoped code should read `scope.logger` or receive
the `Logger` seam explicitly.

**Implementation spec:**

- Add a CLI bootstrap helper that builds a fresh `LoggerImpl` from immutable run
  options: `{ runId, debugMode, silent, logDir? }`.
- The bootstrap state machine from ADR-0052 computes logger options in two
  passes without mutating a shared instance: first pre-project stderr policy,
  then optional project `logDir` after project resolution.
- `buildPerRunScope(...)` receives the per-run logger and stamps it onto
  `RunScope.logger`.
- Production calls to `configureLogger(...)` should be limited to pre-scope
  compatibility paths. Once the scoped logger is wired through the bootstrap,
  add a guardrail that rejects `configureLogger(...)` outside approved adapter
  files.
- Tests must prove that two concurrent `runWithScope(...)` calls with different
  log directories, debug modes, and run ids do not affect one another.
- Do not migrate every `import { logger }` in one mechanical patch. Convert
  high-blast-radius paths first: CLI bootstrap, run-plane/session persistence,
  output/sink delivery, capability loading, and tool initialization. Then tighten
  the guardrail.

**Alternatives:**

- Keep singleton configuration because the CLI is one process per run (accepted
  only for current CLI-only operation; rejected for hosted/SaaS execution because
  `RunScope` already states that concurrent hosts construct one scope per run).
- Make the singleton read all options from `currentScope()` dynamically
  (rejected: it improves run id stamping but leaves file path, silent/debug
  policy, and stderr behavior coupled through one mutable object).
- Pass a logger argument to every function and remove `scope.logger` (rejected:
  too much call-site churn and inconsistent with the existing RunScope service
  ownership model).

**Rationale:** `RunScope` already owns per-run registries, diagnostics, project
context, datastore thunks, and signal sinks. Logger output policy is the same
kind of run-local service. Keeping the singleton mutable is fine for a short-lived
CLI process, but it contradicts the stated concurrent-hosting model and creates
cross-run contamination risk for log directory and stderr/debug behavior.

**Consequences:**

- CLI behavior remains unchanged for a single command invocation.
- Hosted in-process runs gain deterministic logger isolation.
- Some lower-level imports of the singleton will remain during the transition;
  the final guardrail should only land after scoped logger reads are available
  along the high-blast-radius paths.

