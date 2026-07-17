---
status: active
last_verified: 2026-07-05
owner: opensip-cli
---

# ADR-0132: CommandOutcome exit parity

```yaml
id: ADR-0132
title: CommandOutcome exit parity
date: 2026-07-05
status: active
supersedes: []
superseded_by: null
related: [ADR-0024, ADR-0065, ADR-0011, ADR-0035, ADR-0020, ADR-0117]
tags: [json, output, exit-codes, cli]
enforcement: mechanizable
enforced-by: ['script:command-outcome-exit-parity.test']
enforcement-reason: >
  The runtime contract is pinned by
  packages/cli/src/__tests__/command-outcome-exit-parity.test.ts across fit,
  graph, yagni, suite, and gate-compare paths.

**Decision:** The serialized `CommandOutcome.exitCode` always equals the process
exit code for every public JSON command outcome.

**Alternatives:**

- **Require tool engines to derive `runFailed` and set exits before emission.**
  Rejected because it would duplicate the host verdict-to-exit policy and weaken
  ADR-0035's host-owned gate posture.
- **Rely only on serializer-side fallback.** Rejected as the sole fix because
  emission order would remain load-bearing, and generic `emitJson` has no
  `SignalEnvelope` verdict to inspect.
- **Document mismatches as allowed.** Rejected because CI and agent consumers
  need one machine-readable exit fact.

**Rationale:** `CommandOutcome` is the public machine wrapper from ADR-0065. If
its `exitCode` disagrees with the actual process exit, shell integrations and
JSON consumers can make opposite decisions about the same run. The shipped
implementation derives verdict exits before JSON emission on envelope paths and
keeps a host-owned fallback in `emitEnvelope` for paths that still need it.

**Consequences:**

- `--json` consumers can treat `exitCode` as the process result, not just a
  payload hint.
- A `--report-to` warning or delivery failure can appear on stderr before the
  stdout JSON document, because the host must know the final exit before it
  serializes the outcome.
- New JSON-emitting command paths must set or derive their exit before calling
  the output seam.

**Fitness check:** No new check warranted. This is a runtime ordering contract,
enforced by `command-outcome-exit-parity.test.ts`.

**Follow-up (2026-07-06):** Making `afterDelivery` run on the gate path — the
uniform per-mode hook semantics adopted alongside this contract — let yagni's
`applyAdvisoryExitCode` re-affirmation run on `--gate-compare`/`--gate-save`,
where under the default advisory config it reset the host-derived
`RUNTIME_ERROR` back to `SUCCESS` (a degraded ratchet gate that printed FAILED
but exited 0). Fixed by having yagni's `afterDelivery` skip the advisory reset
in gate mode (the host owns the gate exit, ADR-0035), pinned by an un-mocked
`yagni --gate-compare` row in `command-outcome-exit-parity.test.ts`. Any future
adopter whose hooks mutate the exit code must respect the gate-owns-exit rule.

**Related ADRs:** Builds on the public JSON wrapper in [ADR-0065](ADR-0065-public-json-output-and-raw-stream-policy.md), the signal currency in [ADR-0011](ADR-0011-signal-output-currency-formatter-sink.md), and the host-owned gate/delivery posture in [ADR-0035](ADR-0035-host-owned-verdict-from-tool-declared-policy.md) and [ADR-0117](ADR-0117-host-owned-analysis-run-pipeline.md).
