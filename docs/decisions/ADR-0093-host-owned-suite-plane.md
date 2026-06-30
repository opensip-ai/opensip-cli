---
status: active
last_verified: 2026-06-30
owner: opensip-cli
---

# ADR-0093: Host-Owned Tool Suites

```yaml
id: ADR-0093
title: Host-Owned Tool Suites
date: 2026-06-28
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0036, ADR-0048, ADR-0054, ADR-0051, ADR-0100]
tags: [cli, host-planes, composition, sessions, config]
enforcement: mechanizable
enforcement-reason: >
  The single-opts-assembly-seam fitness check forbids a second CommandSpec→opts
  projection; architecture-session-timing-not-host-owned keeps suite grouping keys
  host-stamped; dependency-cruiser enforces the host-owned orchestrator layer.
```

**Decision:** Add `suite` as a host-owned command group and `suites:` as a host-owned
config namespace. A suite is not a Tool and tools do not gain a `runAsSuiteStep` API.
The host resolves each step by `ToolMetadata.id` UUID, then re-dispatches the step
through the same `CommandSpec` surface used by normal commands.

The v1 execution model is run-all with a host-derived worst-of exit code. Future
`execution.mode`, `execution.stopOnFirstFailure`, and per-step `cwd` keys are
reserved in the config schema but rejected until implemented. Step args may only
describe tool behavior; run-scope flags such as `cwd`, `config`, `debug`, and
targeting flags remain suite-invocation inputs.

Suite sessions are ordinary tool sessions with two nullable host-stamped grouping
fields: `suiteRunId` and `suiteName`. There is no new session kind and no
suite-level baseline.

For in-process bundled tools, suite eligibility requires routing exit and output
through `ToolCliContext`. The suite runner wraps `process.exit` during a step and
converts direct exits into captured step verdicts with a structured warning event.
External-provenance tools must continue to use the ADR-0054 worker dispatch boundary.

Authoring uses UUIDs as the canonical key. `tools list` exposes the stable tool
UUID, and `suite add` resolves a name or UUID into the canonical YAML shape.

**Alternatives:**

- **Suite as a Tool plugin.** Rejected: cross-tool composition needs `RunScope.tools`,
  which the tool-facing `ToolScope` deliberately excludes.
- **Per-step `RunScope`.** Rejected for v1: breaks the shared-scope guarantee that
  distinguishes suites from shell `&&` chains.
- **Suite-level baseline/ratchet.** Rejected: ADR-0036 keeps baselines per-tool; steps
  declare their own gate args.

**Consequences:**

- Host orchestration can compose existing tools without tool adoption work.
- `CommandSpec.options` stays the single source for option defaults and parsing.
- A suite guarantees one shared run scope for all steps; different scope per step
  remains explicitly out of v1.
- Reports and session history group suite steps via `suiteRunId` without changing
  tool-owned session contributions.

**Fitness check:** `single-opts-assembly-seam` (path-gated to `packages/cli/src/commands/`).

**Related specs / ADRs:** Implements local plan `docs/plans/ready/05-tool-suites/`.
Extended by ADR-0100 for suite per-step verdict and aggregate output.
