---
status: active
last_verified: 2026-07-05
owner: opensip-cli
---

# ADR-0131: Shared dispatch pipeline and suite exit capture

```yaml
id: ADR-0131
title: Shared dispatch pipeline and suite exit capture
date: 2026-07-05
status: active
supersedes: []
superseded_by: null
related: [ADR-0093, ADR-0100, ADR-0020, ADR-0035, ADR-0066]
tags: [cli, suites, dispatch, exit-codes, output]
enforcement: mechanizable
enforcement-reason: >
  The existing exit-code-correctness check is re-armed over the suite step runner.
  Suite taxonomy parity is pinned by packages/cli/src/commands/suite/__tests__/orchestrator.test.ts,
  the CommandOutcome/process parity matrix in
  packages/cli/src/__tests__/command-outcome-exit-parity.test.ts, and the
  ratcheted suppression catalog.
```

**Decision:** Normal command mounting and `suite run` steps dispatch through the
same `runCommandSpecAction` pipeline. Suite steps capture every exit source in a
step-scoped slot, including `reportFailure`, delivery-derived exits, typed
errors, and guarded direct exits. The suite aggregate exit remains the numeric
maximum step exit code over the ADR-0020 code space.

**Alternatives:**

- **Keep two hand-synchronized pipelines with parity tests.** Rejected because
  the architecture review found drift in exactly that split path.
- **Run each suite step as a child `opensip` process.** Rejected because it would
  break ADR-0093's shared `RunScope` guarantee and duplicate bootstrap work.
- **Replace numeric max with a severity ordinal.** Rejected because ADR-0093 and
  ADR-0100 already ratified worst-step exit semantics, and the public exit-code
  space is taxonomy, not a severity ordering.

**Rationale:** `CommandSpec` is the CLI's single command contract. Maintaining a
separate suite-only dispatcher meant parser, output, delivery, failure, and exit
behavior could drift from the mounted command surface. The shipped pipeline in
[`packages/cli/src/commands/run-command-spec-action.ts`](../../packages/cli/src/commands/run-command-spec-action.ts)
is now the common action body, while
[`suite-step-runner.ts`](../../packages/cli/src/commands/suite/suite-step-runner.ts)
wraps the host seams with a step-local capture context and reports `errorCode`
when a typed/reportFailure code is available.

**Consequences:**

- A suite step no longer writes the host process exit holder directly; it writes
  the step capture slot, and the suite runner derives the final suite exit.
- Standalone and in-suite failures preserve the same machine taxonomy code.
- `SuiteStepSummary.errorCode` is additive and optional for existing consumers.
- Future command output modes must be implemented in the shared dispatch path or
  suite steps will not see them.

**Fitness check:** No new check warranted. The existing
`exit-code-correctness` guard plus suite/orchestrator and command-outcome parity
tests cover the invariant.

**Related specs / ADRs:** Extends [ADR-0093](ADR-0093-host-owned-suite-plane.md)
and [ADR-0100](ADR-0100-suite-per-step-verdict-and-aggregate-output.md). Builds
on [ADR-0020](ADR-0020-dogfood-gate-hard-fail.md),
[ADR-0035](ADR-0035-host-owned-verdict-from-tool-declared-policy.md), and
[ADR-0066](ADR-0066-typed-errors-own-exit-codes.md).
