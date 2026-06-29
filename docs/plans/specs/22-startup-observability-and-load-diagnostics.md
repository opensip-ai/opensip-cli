# 22 Startup Observability and Load Diagnostics

## Status

> **Implementation status (2026-06-29):** not implemented — backlog draft (candidate for the next patch release). **Already shipped (substrate):** structured logging (`cli.run.start`, subprocess spawn/complete, `cli.checks.loading`, datastore lock waits) and a load substrate that knows package names. **Unbuilt by this spec:** a single startup phase-timing surface + a structured degraded-load cause (stop classifying pack failures by parsing human-readable strings → fixes the `"unknown"` pack warning).

Backlog draft. Promote to `ready/` first. Candidate for the next patch release
because it fixes diagnosability gaps found immediately after the v0.1.15 launch.

## Priority

High. Operability floor for a local-first gate: if the CLI pauses before first
output, or reports that an "unknown" pack failed, the user cannot tell whether the
tool is slow, blocked, rebuilding, loading stale extensions, or hiding a real
compatibility problem.

## Principle

Every user-visible delay and every degraded load warning must have a named,
structured cause.

The CLI should be able to answer, from the run record or logs:

- what work happened before first render
- which phase took time
- whether datastore locks, migrations, update checks, capability discovery, worker
  bootstrap, or renderer startup were involved
- which package or plugin produced a degraded load warning

## Problem

The v0.1.15 dogfood run exposed two observability gaps:

- `fit` printed `Optional check pack "unknown" failed to load.` The load substrate
  normally knows the package name, but the fit finalizer classifies failures by
  parsing human-readable error strings. If a string shape does not match
  `package: detail` or `package -> domain: detail`, the display falls back to
  `"unknown"`.
- A first post-upgrade `fit` invocation appeared to pause for several seconds
  before the banner/rendered output. Existing logs show useful clues
  (`cli.run.start`, subprocess spawn/complete, `cli.checks.loading`, datastore lock
  waits), but there is no single phase-timing surface for startup, pre-action
  bootstrap, time-to-first-render, capability discovery, update check, datastore
  open/migration, or live worker readiness.

This is not primarily a performance spec. The first fix is attribution: make slow
or degraded paths explain themselves before we tune them.

## Target State

- Capability/load diagnostics stay structured from discovery through tool-specific
  finalization, presentation, JSON, sessions, and logs.
- A degraded optional check pack warning names the package whenever the discovery
  layer knew it; `"unknown"` is only possible when no package metadata exists, and
  that case carries a raw diagnostic detail.
- The CLI records startup and pre-action phase timings, including time before first
  render, without requiring a debugger.
- `opensip fit --verbose`, `--json`, session replay, and runtime logs expose the
  same core diagnostic facts in different formats.
- Datastore lock waits, migrations, update-check work, capability-domain loads, and
  live worker bootstrap are visible as first-class timing events.

## Scope

1. Replace string-only fit-pack load errors with a typed diagnostic path.
   - Carry `evt`, `packageName`, `domainId`, `targetDomainId`, `sourcePackage`,
     `message`, `detail`, and required/optional classification where available.
   - Update `finalizeFitLoadOutcome` to classify from structured fields, not regex
     parsing of display strings.
   - Apply the same pattern to sim packs and graph adapters if they use the same
     capability-loader substrate.
2. Preserve load diagnostics in user and machine surfaces.
   - Human footer/verbose output: package name, optional vs required, and concise
     detail.
   - JSON/session output: structured degraded diagnostics, not only flattened warning
     strings.
   - Runtime logs: one stable event per load failure, with package/domain metadata.
3. Add startup/pre-action timing instrumentation.
   - Process entry to `bootstrapCli` complete.
   - Commander match to pre-action start.
   - `planPreActionBootstrap` phases: read options, merge defaults, project
     resolution, bailout window.
   - `executePostBailoutBootstrap` phases: project side effects, update check,
     scope build, scope enter, host start effects, owning-tool initialize, owning
     capability load.
   - Datastore open/migration/lock wait.
   - Live worker spawn to worker `cli.run.start`, worker ready, and worker complete.
   - Time to first render/banner/frame for static and live paths.
4. Add a persisted/inspectable timing surface.
   - Extend `RunDiagnostics` events or host metrics with duration fields rather than
     inventing another telemetry shape.
   - Make `opensip sessions show ... --json` and `opensip tools doctor` or an
     equivalent diagnostic command able to show the timing breakdown.
   - Keep OpenTelemetry spans optional; local logs/session diagnostics must work with
     no collector.
5. Keep update checks non-blocking and measurable.
   - Preserve `OPENSIP_NO_UPDATE` / `NO_UPDATE_NOTIFIER` behavior.
   - Record whether update-check display used the sticky state, scheduled a fetch, or
     was skipped.

## Non-Goals

- Defining global performance budgets or large-repo SLOs. That belongs to
  **spec 18**.
- Replacing the existing logger, session store, or OpenTelemetry integration.
- Making capability packs safe to load in-process. That belongs to **spec 10**.
- Cloud evidence authority or egress fidelity. That belongs to **spec 20**.

## Open-Core Placement

**OSS-CLI.** This is local developer and CI operability. Cloud may ingest the richer
session diagnostics later, but the source of truth is the local CLI run.

## Acceptance Criteria

- A fixture check pack with an import failure, bad export, compatibility rejection,
  and foreign-core skip produces a named diagnostic when package metadata exists.
- No first-party path renders `Optional check pack "unknown" failed to load.` when a
  package name was known by discovery.
- `fit --verbose` shows degraded load diagnostics with package/domain/detail.
- `fit --json` and `sessions show --json --raw` preserve degraded load diagnostics
  as structured data.
- A synthetic datastore lock wait is visible in the run diagnostics or host metrics
  with operation name and wait duration.
- A cold-start smoke test can assert timing events for startup, pre-action,
  capability loading, and time-to-first-render without enabling OTEL.
- Instrumentation overhead is bounded and tested; normal no-debug runs do not pay
  for expensive stack capture or profiling.

## Dependencies

- **Spec 01** (deterministic gate inputs; diagnostics must not depend on hidden
  mutable state).
- **Spec 10** (capability isolation consumes the same load/admission metadata).
- **Spec 18** (performance SLOs can consume these timing events, but does not own
  them).
- ADR-0052 (pre-action bootstrap phases), ADR-0054 (external tool dispatch), ADR-0060
  (bootstrap diagnostics), ADR-0081/0084 (capability and MCP substrate), ADR-0093
  (suite/session plane).

## Promotion Trigger

Promote when the live-tree anchors are verified and the first implementation slice
is chosen. Expected anchors:

- `packages/core/src/plugins/capability-discovery.ts`
- `packages/core/src/plugins/capability-loader.ts`
- `packages/fitness/engine/src/cli/fit/check-loader.ts`
- `packages/fitness/engine/src/cli/fit/load-outcome.ts`
- `packages/cli/src/bootstrap/pre-action-hook.ts`
- `packages/cli/src/bootstrap/execute-post-bailout-bootstrap.ts`
- `packages/cli/src/bootstrap/run-plane.ts`
- `packages/core/src/lib/diagnostics-bus.ts`
