# ADR-0093: Host-Owned Tool Suites

## Status

Accepted

## Context

OpenSIP CLI can mount and dispatch many tool commands, but users who want to run
several tools together must currently script multiple CLI invocations. That loses
the platform guarantees that matter most for analysis: one resolved project
scope, one config/targeting view, one host-owned command surface, and one
composed session/report timeline.

## Decision

Add `suite` as a host-owned command group and `suites:` as a host-owned config
namespace. A suite is not a Tool and tools do not gain a `runAsSuiteStep` API.
The host resolves each step by `ToolMetadata.id` UUID, then re-dispatches the
step through the same `CommandSpec` surface used by normal commands.

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
converts direct exits into captured step verdicts. External-provenance tools must
continue to use the ADR-0054 worker dispatch boundary.

Authoring uses UUIDs as the canonical key. `tools list` exposes the stable tool
UUID, and `suite add` resolves a name or UUID into the canonical YAML shape.

## Consequences

- Host orchestration can compose existing tools without tool adoption work.
- `CommandSpec.options` stays the single source for option defaults and parsing.
- A suite guarantees one shared run scope for all steps; different scope per step
  remains explicitly out of v1.
- Reports and session history can group suite steps without changing tool-owned
  session contributions.
