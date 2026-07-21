---
status: active
last_verified: 2026-07-20
owner: opensip-cli
---

# ADR-0177: Graph session score/passed copy envelope.verdict

```yaml
id: ADR-0177
title: Graph session score/passed copy envelope.verdict
date: 2026-07-20
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0035, ADR-0051]
tags: [graph, session, verdict, score, envelope]
enforcement: mechanizable
enforced-by: ['script:contribution-from-signals.test']
enforcement-reason: >
  contribution-from-signals.test asserts that with one high-severity signal and
  multiple evaluated clean rules, session score/passed equal buildGraphEnvelope
  verdict (near 0 / failed), not passRate of the all-evaluated payload summary
  (~80 / may still fail on errors but diverges on score).
```

**Decision:** Graph's generic-session contribution (`ToolSessionContribution.score`
and `.passed`, and the derived `runOutcome`) is **copied from** the same
`SignalEnvelope.verdict` the live delivery path already builds via
`buildGraphEnvelope` / `buildSignalEnvelope`. Session payload detail may still
inventory every **evaluated** rule (including clean PASS rows) for the dashboard
rule list; that inventory must not recompute the headline score or pass bit.

**Alternatives:**

- *Keep `passRate(payload.summary)` over all-evaluated rules (status quo).*
  Rejected: one high-severity finding plus N clean rules yields live envelope
  score ≈ 0% (units only for fired rules) while the stored session scores
  ≈ 80%+ (clean rules inflate `summary.passed/total`). Fit and yagni already
  copy `envelope.verdict`; graph was the divergence.
- *Change envelope units to include every evaluated clean rule.* Rejected: that
  rewrites ADR-0011 graph envelope shape (one unit per rule that **fired**) and
  would inflate every human/JSON headline and exit-adjacent score for a
  different product meaning than session-detail inventory.
- *Dual scores (envelope score vs session score) with explicit naming.* Rejected:
  `StoredSession.score` is the shared dashboard PASS RATE column; two meanings
  reintroduces the drift this ADR closes.

**Rationale:** ADR-0035 made `envelope.verdict` the single pass/fail currency.
ADR-0011 made the envelope the output currency for JSON, table, and egress.
Graph session assembly incorrectly re-derived score from
`buildGraphSessionPayload`'s all-evaluated summary (`passRate(payload.summary)`
and `errors === 0`), so MCP/`sessions show` and the live envelope disagreed on
the same run. Fit (`fit.ts` / live runner) and yagni (`execute-yagni.ts`) already
set `score: envelope.verdict.score` and `passed: envelope.verdict.passed`. Graph
must match that single-owner pattern; clean-rule inventory stays only in
`payload.checks` / `payload.summary`.

**Consequences:**

- `contributionFromGraphPayload` requires an explicit `verdict: { score, passed }`
  (from the envelope); it no longer imports `passRate` for the contribution row.
- `contributionFromSignals` builds a `buildGraphEnvelope` (same pure assembly as
  live delivery) and copies `envelope.verdict` into the contribution.
- `deliverGraphResult` builds **one** envelope first, then builds the session
  contribution from that envelope's verdict (static and gate/catalog/json paths
  share the same owner).
- Workspace aggregate still forces `score: 0` / `passed: false` / `runOutcome:
  'error'` when any child failed (incomplete evidence), after envelope-derived
  assembly for surviving signals.
- Impact session contribution uses the impact envelope verdict the same way.
- Regression test: one high-severity signal + multiple evaluated clean rules →
  session score/passed must equal `buildGraphEnvelope(...).verdict`, not
  all-evaluated `passRate`.

**Related ADRs:** ADR-0011 (SignalEnvelope currency), ADR-0035 (host-owned
verdict), ADR-0051 (host-owned session timing; tools still supply score/passed
on the contribution).
