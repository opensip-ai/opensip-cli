---
status: active
last_verified: 2026-06-30
owner: opensip-cli
---

# ADR-0100: Suite per-step verdict and aggregate output

```yaml
id: ADR-0100
title: Suite per-step verdict and aggregate output
date: 2026-06-30
status: active
supersedes: []
superseded_by: null
related: [ADR-0093, ADR-0011, ADR-0035]
tags: [cli, suites, output, agents, security]
enforcement: mechanizable
enforcement-reason: >
  Unit tests cover the mixed-step suite matrix, external-dispatch replay,
  aggregate derivation, additive output shape, and counts-only secret hygiene.
  Static guardrails such as only-documented-toolcli-seams and
  single-opts-assembly-seam continue to enforce the host-owned output plane and
  the single CommandSpec-to-options projection.
```

**Decision:** Extend the host-owned suite result contract additively with
per-step counts-only `verdict` projections and a suite-level `aggregate`. Keep
the suite exit code derived from worst step exit code, and represent step
outcomes through the existing `{exitCode, error, verdict}` fields rather than a
new discriminant enum.

**Alternatives:**

- **Add counts-only `steps[].verdict` and `aggregate`.** Chosen. It makes mixed
  suites legible to humans, CI, and agents while preserving existing fields and
  the host-owned worst-of exit policy.
- **Add an explicit per-step `outcome` enum.** Rejected for now. Faulted,
  failed-without-findings, passed-with-findings, empty findings, and missing
  output are already derivable from `{exitCode, error, verdict}`. An enum can be
  added later if consumers need a normalized label.
- **Embed each step's full `SignalEnvelope` in the suite summary.** Rejected.
  That would duplicate large payloads and leak signal messages, file paths,
  symbols, scanner snippets, or other sensitive match content into a summary
  whose job is orchestration, not findings transport.
- **Leave suite summaries exit-only.** Rejected. Exit-only output hides whether a
  step emitted an empty envelope, emitted warning findings but passed, failed
  without findings, or faulted before producing output.

**Rationale:** ADR-0093 made suites a host-owned composition plane, not a tool.
That plane already owns step isolation, grouped session stamping, and the
worst-of suite exit. However, the original `SuiteStepSummary` dropped the
`RunVerdict` each step emitted under ADR-0011, so `suite run --json` consumers
could not distinguish important mixed-step states without reading separate step
output.

The new projection carries only `passed`, `errors`, `warnings`, and `findings`.
That is enough for gate consumers and coding agents to reason about the suite
without pulling signal payloads into the suite summary. `findings` comes from
`SignalEnvelope.signals.length`, while `errors` and `warnings` come from
`RunVerdict.summary`; this preserves the distinction between "an empty envelope"
and "no envelope was emitted."

The aggregate is derived after all steps finish and does not replace the shipped
worst-of exit policy. A non-faulted step is failed when its verdict failed or
its captured exit code is non-zero. A thrown step is faulted. A successful step
that emitted no envelope remains visible as missing output, not as an invented
signal pass.

**Consequences:**

- `suite run --json` includes additive `data.aggregate` and
  `data.steps[].verdict` fields. Existing fields keep their names and types.
- Terminal suite output renders per-step verdict/count columns plus an aggregate
  line when the result includes aggregate data.
- Suite summaries remain counts-only. Future fields must not add signal
  messages, file paths, symbols, match snippets, raw scanner output, or config
  payloads to `SuiteStepSummary`.
- A future `outcome` label remains addable, but it should be a derived
  convenience over `{exitCode, error, verdict}`, not a second source of truth.

**Fitness check:** No new check warranted. The invariants are behavioral
(external replay contributes, every step is summarized, output is additive, and
verdicts are counts-only) and are locked by suite orchestrator, capture-context,
and view tests. Existing static checks already guard the host-owned output
seams and single options assembly path introduced by ADR-0093.

**Related specs / ADRs:** Extends ADR-0093. Builds on ADR-0011
(`SignalEnvelope` as output currency) and ADR-0035 (verdict policy).
