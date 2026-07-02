---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0110: Keep Review Briefs Host-Owned

```yaml
id: ADR-0110
title: Keep review briefs host-owned
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0093, ADR-0100]
tags: [suite, agents, output, contracts]
enforcement: mechanizable
enforcement-reason: >
  Dependency-cruiser keeps tool packages from importing the CLI composition
  root. Existing output-seam checks keep suite output on CommandResult /
  ToolCliContext.render and emitJson. No new fitness check is warranted unless
  a future change introduces a new structural seam for brief construction.
```

**Decision:** Define `ReviewBrief` as a versioned contract in
`@opensip-cli/contracts`, but build it in the CLI host after suite steps finish.
Tools continue to emit `SignalEnvelope`s; they do not aggregate cross-tool
review verdicts.

**Alternatives:**

- Per-tool aggregation. Rejected because no single tool sees the whole suite,
  step ordering, or cross-tool degradation state.
- Dashboard-only aggregation. Rejected because agents, CI, and GitHub Actions
  need the same deterministic JSON contract without rendering a dashboard.
- Embed full step envelopes in `SuiteStepSummary`. Rejected by ADR-0100; public
  step summaries stay count-only and the brief is a bounded projection with
  explicit `signalRef` provenance.

**Rationale:** The suite runner already owns orchestration across tools. Building
the review brief there lets it preserve suite metadata (`suiteRunId`,
`stepIndex`, step faults, missing envelopes) while keeping tool engines focused
on their standard `SignalEnvelope` output currency from ADR-0011. The contract
is reusable by agents and future MCP read-side tools without adding a dependency
from those surfaces to the CLI implementation.

**Consequences:**

- `opensip suite run <name> --json` may include `data.reviewBrief` with
  `version: 1`, a deterministic verdict, bounded risks, baseline/degradation
  notes, and `signalRef` provenance.
- `steps[]` remains count-only. Signal messages and locations appear only in the
  bounded brief projection, not in raw embedded envelopes.
- Suite-level review-brief SARIF is deferred. Source tools keep owning SARIF for
  their `SignalEnvelope`s until a later evidence-authority or GitHub Action
  decision defines an aggregate SARIF mapping.
- Future MCP `review_change` work should serve this contract from persisted
  evidence rather than inventing another review payload shape.

**Related specs / ADRs:** Spec 05 phase 0 (review brief contract), spec 07 phase
0 (MCP review tools), spec 24 (audit suite preset), [ADR-0093](ADR-0093-host-owned-suite-plane.md),
[ADR-0100](ADR-0100-suite-per-step-verdict-and-aggregate-output.md).
