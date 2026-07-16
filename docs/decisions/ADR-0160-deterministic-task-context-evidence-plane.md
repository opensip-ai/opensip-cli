---
status: active
last_verified: 2026-07-12
owner: opensip-cli
---

# ADR-0160: Keep Task Context On A Non-Finding Evidence Plane

```yaml
id: ADR-0160
title: Keep task context on a non-finding evidence plane
date: 2026-07-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0093, ADR-0100, ADR-0111, ADR-0129, ADR-0131, ADR-0143, ADR-0147, ADR-0153]
tags: [agents, evidence, suites, persistence, mcp]
enforcement: mechanizable
enforced-by: ['type-structural', 'local:mcp-results-no-rerun', 'script:command-spec.test.ts', 'script:evidence-snapshot-capture.test.ts', 'script:validate-suite.test.ts', 'script:task-context-manifest.test.ts', 'script:orchestrator.test.ts']
```

**Decision:** A deterministic context producer returns bounded
`EvidenceSnapshotContribution` pointers through `ToolRunCompletion`. It does not
emit a `SignalEnvelope`. Evidence-producing and verdict-producing command
markers are mutually exclusive in v1, and evidence commands selected for the
external-worker transport are rejected because that wire result does not carry
evidence contributions.

The CLI host is the sole cross-step aggregator. For the built-in
`agent-context` suite it validates contributions, allocates one parent Run and
all RunStep identities once, constructs a versioned `TaskContextManifest` with
creation time, canonical-project identity, producer versions, per-plane
freshness/coverage/cap state, and those exact references, then persists it on
the parent Run. Ordinary verdict
suites retain their existing ReviewBrief and exit semantics. Task context never
becomes a finding, fingerprint, baseline, SARIF result, gate verdict, or
ReviewBrief risk.

**Alternatives:**

- **Represent readiness as synthetic findings.** Rejected because absence,
  staleness, and partial coverage are evidence state, not code defects.
- **Create a new context Tool.** Rejected because inventory, graph evidence,
  selection, orchestration, and replay already have distinct owners; another
  Tool would create a competing execution plane.
- **Let each producer write the parent Run.** Rejected because only the host
  knows ordered step identity, required/optional policy, source drift, and the
  final aggregate.
- **Widen the external worker protocol in this release.** Rejected to keep the
  trust boundary fail-closed until evidence replay has an explicit wire design.

**Rationale:** Agents and humans need before-edit evidence without corrupting
the finding model. A small generic core pointer lets Tools publish durable
domain evidence while keeping task-context vocabulary in contracts and host
policy in the CLI. Preallocated identities make the returned result, manifest,
Run, and RunSteps one auditable record rather than a timestamp-based join.

**Consequences:**

- Contributions are capped at 16, copied and frozen by the host, and contain no
  generic lifecycle timing or payload/source text.
- A ready manifest requires current, complete, uncapped required planes and
  exact durable pointers; replay trust additionally requires an explicit file
  scope match and every required pointer to remain available.
- Graph-plane completeness is proven from persisted build input identity/counts,
  parse-error counts, adapter provenance, and inventory language/file coverage;
  absent or mismatched proof degrades rather than implying an empty graph.
- A ready manifest is never returned after parent-ledger persistence fails.
- Required missing, failed, cancelled, or unsupported planes make the context
  unavailable and nonzero under the built-in fail-on-fault policy. Partial and
  source-drift states remain explicit degradation.
- Snapshot writes may precede a failed parent write; bounded age/size retention
  eventually removes old derived rows, including orphans. Because retention is
  not reference-aware, a recorded pointer can also become explicitly missing.

**Related:** [ADR-0084](ADR-0084-mcp-server-surface.md) establishes read-only MCP
replay, [ADR-0143](ADR-0143-host-owned-run-step-ledger.md) owns the parent
ledger, and [ADR-0153](ADR-0153-faceted-compact-mcp-graph-protocol.md) defines
bounded coverage semantics.

**Related spec:** `docs/plans/specs/agent-task-context.md` (local-only) retains
the broader deferred context-composer waves beyond this first implementation.
