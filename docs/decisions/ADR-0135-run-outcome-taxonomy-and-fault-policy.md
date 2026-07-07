---
status: active
last_verified: 2026-07-07
owner: opensip-cli
---

# ADR-0135: One run-outcome taxonomy (pass/fail/fault) with non-blocking faults

```yaml
id: ADR-0135
title: One run-outcome taxonomy (pass/fail/fault) with non-blocking faults
date: 2026-07-07
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0035, ADR-0060, ADR-0020, ADR-0008, ADR-0036, ADR-0131, ADR-0093, ADR-0111, ADR-0065]
tags: [verdict, suite, output, fault, exit-codes]
enforcement: not-mechanizable
enforcement-reason: >
  Enforced by the closed `RunOutcome` type + the contracts/suite unit tests
  (deriveOutcome, deriveStepOutcome, deriveSuiteAggregate, envelopeToResultSummary)
  and the golden render fixtures, plus the existing `only-documented-toolcli-seams`
  architecture check. No single fitness check captures the taxonomy; it is a
  framework decision guarded by types + tests.
```

**Decision:** A run has ONE 3-way terminal outcome — `passed | failed | faulted` —
derived once by `deriveOutcome(verdict)` from the `SignalEnvelope` verdict, where
`faulted` (a RUNTIME error: a unit threw/timed-out) is a first-class outcome
distinct from a findings `failed`. This outcome is the single source of truth for
BOTH single-tool runs and suite aggregation, and it is rendered by ONE shared
result block (`viewResultSummary`) across the static (pipe) and live (TTY)
surfaces. A runtime fault is **non-blocking** for the suite exit by default: an
envelope-backed fault (the tool ran, a check crashed — `verdict` present) is
excluded from the suite worst-of exit unless `execution.failOnFault` is set, while
a no-envelope failure (the tool/step itself crashed before results) keeps its
ADR-0020 exit taxonomy and blocks. We explicitly do NOT route all execution
through the suite orchestrator to achieve this unification.

**Alternatives:**

- **Keep the binary `passed`/`failed` verdict + the suite-only 3-way aggregate
  (status quo).** Rejected: the suite derived its 3-way from `step.error`, which
  is set only for run-LEVEL throws, so a unit-level fault (a crashed check that
  still produced an envelope) was mislabeled `failed`; single runs had no
  `faulted` state at all; and the review brief only surfaced faults that emitted
  zero signals.
- **Route ALL execution through the suite orchestrator ("one way to run
  things"), so `opensip fit` synthesizes a 1-step suite.** Rejected: the shared
  CommandSpec dispatch pipeline (ADR-0131) is already the one composition path;
  suites are built ON that surface (ADR-0093), and ADR-0111 already rejected a
  second top-level composition (`opensip audit`) for the same reason. Running a
  single tool as a suite would break the `--json` envelope contract (ADR-0065 —
  agents/MCP read `.envelope.verdict`, not a suite aggregate), lose the per-step
  live TTY view, and re-introduce the second composition path those ADRs closed.
- **Make faults always block (treat a fault as a failure).** Rejected: a crashed
  check has an UNKNOWN result, not a gate failure — conflating them tells a
  contributor "your code failed" when the tool never finished judging it.
- **Make ALL faults non-blocking (including app/step crashes).** Rejected: a
  `ConfigurationError` / `ToolError` / thrown command BEFORE any envelope
  (ADR-0060) is an actionable operational error with a structured ADR-0020 exit
  code; silently passing the suite on a misconfigured step hides real breakage.

**Rationale:** `buildSignalEnvelope` already computes the authoritative fault bit
once — `faulted = runFaulted || unitFaulted` — so `deriveOutcome` is a pure read of
the verdict, shared by `deriveSuiteAggregate` (suite steps) and
`envelopeToResultSummary` (single-run units). Deriving the outcome in one place
fixed three latent defects: the unit-fault mislabel, a suite step with a
success-exit and no envelope silently dropped from all three counts, and the
review-brief fault predicate `!passed && signals.length === 0` — which is
algebraically "faulted with zero signals" and so missed a fault that also emitted
findings. The non-blocking boundary follows the user-facing fault distinction and
ADR-0060: a CHECK faulting means the tool ran and produced an envelope whose
`verdict.faulted` is true (result unknown → non-blocking), whereas the APP/step
faulting is a command-error before the envelope (no `verdict` → blocks). This is
orthogonal to `failOnDegraded` (ADR-0036), which governs the gate-compare ratchet,
not runtime faults.

**Consequences:**

- `RunVerdict.faulted` is optional for forward-compat (a legacy envelope omits it
  and degrades to binary pass/fail); when present it is always `false` for a
  passing run.
- `SuiteStepSummary.outcome` (required) is the authoritative per-step 3-way;
  `deriveSuiteAggregate` tallies it. The suite exit uses an `isNonBlockingFault`
  gate keyed on `outcome === 'faulted' && verdict !== undefined`.
- `deriveStepOutcome` lets the envelope win: a report-delivery failure over a
  passing run keeps `passed` (the failure rides the exit code, ADR-0008).
- `execution.failOnFault` (default false) is a live suite execution policy;
  `execution.mode` / `stopOnFirstFailure` stay reserved.
- `viewResultSummary` is the shared pass/fail/fault block (count line + attention
  bullets); the projection `envelopeToResultSummary` lives in `contracts` so the
  engine live runners and the cli composition root share one derivation, keeping
  the TTY and pipe surfaces byte-identical.

**Related specs / ADRs:** ADR-0011 (SignalEnvelope), ADR-0035 (verdict headline),
ADR-0060 (setup failures are command-errors before the envelope), ADR-0020 (exit
codes), ADR-0008 (report failure never masks a real failure), ADR-0036
(host-owned baseline plane / `failOnDegraded`), ADR-0131 / ADR-0093 / ADR-0111
(the CommandSpec dispatch pipeline, suites built on it, and the rejected second
composition path), ADR-0065 (public `--json` contract).
