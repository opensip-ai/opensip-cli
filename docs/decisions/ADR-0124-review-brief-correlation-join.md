---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0124: Join Related Review-Brief Risks Without Deduplicating Evidence

```yaml
id: ADR-0124
title: Join related review-brief risks without deduplicating evidence
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0110, ADR-0122, ADR-0123]
tags: [agents, suites, mcp, contracts]
enforcement: mechanizable
enforced-by: ['local:review-brief-correlation-shared-helper']
enforcement-reason: >
  The project-local `review-brief-correlation-shared-helper` fitness check
  requires live suite review briefs and persisted MCP review briefs to call the
  same contracts helper instead of defining local correlation logic.

**Decision:** Review briefs may include optional `correlatedRisks[]` groups that
join related findings by deterministic evidence keys while preserving every
original risk in `topRisks[]` and raw `SignalEnvelope` replay.

**Alternatives:** Deduplicate the source risks and expose only a grouped list.
Rejected because ADR-0101 makes full-fidelity evidence a CLI responsibility, and
agents still need stable `signalRef` pointers to every original finding.

**Alternatives:** Implement correlation separately in the CLI suite builder and
MCP persisted review reader. Rejected because live and replayed review briefs
would drift in ordering, caps, and evidence interpretation.

**Alternatives:** Use fuzzy matching over finding messages or embedding-based joins.
Rejected because opensip-cli is deterministic and does not call models in core
paths; message-text matching is noisy and would hide why risks were grouped.

**Rationale:** ADR-0110 made the review brief the host-owned review surface, and
ADR-0122 orders the agent workflow around evidence agents can consume quickly.
Agents need to see when graph, fitness, and other tool signals describe the same
symbol, graph node, file range, package, or fingerprint, but that join must not
destroy provenance. Putting the pure helper in `@opensip-cli/contracts` gives
the live suite path and the MCP replay path the same bounded grouping behavior.

**Consequences:** `ReviewBriefRisk` carries optional `entities[]` and
`correlationKeys[]` projections derived from trusted scalar signal fields and
allowlisted metadata. `ReviewBrief` carries optional `correlatedRisks[]` groups.
Consumers must treat these fields as additive: absence means no grouping was
available, not that source evidence was inspected and deduplicated. The join
uses only bounded local signal data and must not read files, inspect logs, or
perform outbound lookups.

**Related ADRs:** Extends [ADR-0110](ADR-0110-host-owned-review-brief-contract.md), follows the workflow ordering in [ADR-0122](ADR-0122-agent-workflow-product-wedge.md), and composes with [ADR-0123](ADR-0123-impact-analysis-trust-foundation.md).
