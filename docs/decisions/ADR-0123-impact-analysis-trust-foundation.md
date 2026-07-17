---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0123: Make Impact Analysis Explicitly Trust-Bearing

```yaml
id: ADR-0123
title: Make impact analysis explicitly trust-bearing
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0085, ADR-0110, ADR-0122]
tags: [graph, fitness, agents, suites]
enforcement: mechanizable
enforced-by: ['local:impact-trust-conservative-fallback']
enforcement-reason: >
  The project-local `impact-trust-conservative-fallback` fitness check prevents
  the old `fit --include-impacted` changed-only fallback from returning when the
  graph catalog is unavailable.

**Decision:** Impact analysis must carry an explicit trust verdict. Any changed
or impacted verification path that cannot prove full coverage must surface
`coverage`, `fullyVerified`, `uncertainties`, and the selected fallback; fitness
must fall back to a full target run instead of narrowing unsafely.

**Alternatives:** Keep changed-only degradation when the graph catalog is missing
or stale. Rejected because it lets agents claim a targeted repair was verified
even when downstream callers were not checked.

**Alternatives:** Make `graph impact` fail hard on every uncertainty. Rejected
because uncertainty is often still useful evidence for humans and agents; the
consumer should see the impacted rows plus the reason targeted verification is
not complete.

**Rationale:** ADR-0122 selects the agent workflow wedge, and that workflow needs
to distinguish "verified clean" from "checked with degraded evidence." ADR-0085
already centralized changed-file detection and graph impact computation; the
missing piece was a shared trust contract over git status, graph catalog
freshness, unmatched files, renamed/deleted files, and truncation. Keeping that
contract in `@opensip-cli/contracts` lets `graph`, `fit`, suite summaries, MCP
review payloads, and agents agree on the same vocabulary without adding model
calls or autonomous mutation to the CLI.

**Consequences:** `GraphImpactResult` includes `impactedFiles` and `trust`.
`fit --changed --include-impacted` uses impacted files only when trust is full;
otherwise it warns and runs the full target set. Suite step summaries may carry
`verification`, and review briefs record partial impact verification as degraded
evidence. Agents must not say targeted verification is complete when
`fullyVerified` is false.

**Related ADRs:** Extends [ADR-0085](ADR-0085-change-detection-substrate.md) and is ordered by [ADR-0122](ADR-0122-agent-workflow-product-wedge.md).
