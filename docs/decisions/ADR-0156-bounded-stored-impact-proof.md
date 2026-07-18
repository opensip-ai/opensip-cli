---
status: active
last_verified: 2026-07-12
owner: opensip-cli
---

# ADR-0156: Store Bounded Impact Proof For Reports

```yaml
id: ADR-0156
title: Store bounded impact proof for reports
date: 2026-07-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0050, ADR-0051, ADR-0085, ADR-0123, ADR-0143, ADR-0155]
tags: [graph, impact, sessions, runs, dashboard, evidence, privacy]
enforcement: mechanizable
enforced-by: ['script:impact-report-projection.test.ts', 'script:impact.test.ts', 'script:run-ledger-persist.test.ts', 'script:report-selection.test.ts', 'script:dashboard-change-impact.test.ts', 'script:dashboard-html.test.ts', 'depcruise:dashboard-no-graph-import', 'local:architecture-session-timing-not-host-owned', 'local:only-documented-toolcli-seams']
enforcement-reason: >
  Producer cap/overflow tests, host ledger joins, closed report selection,
  dashboard state/injection tests, dependency-cruiser, and existing session
  ownership checks cover the decision at its owners. No additional fitness
  check is needed.
```

**Decision:** Persist an optional, graph-owned, bounded impact projection inside
`GraphSessionPayload.__version: 1`; join it to a report only through the parent
`StoredRun.id`, its `RunStep.sessionId`, and the linked graph session. Reports
render this stored evidence and never rerun Git or graph analysis.

The full `GraphImpactResult` and `SignalEnvelope.verification` remain the
authoritative run-time evidence. The session projection is a deliberately lossy,
self-describing display copy. Additive absence requires no SQLite migration:
absence with no `impactStatus` means a legacy or non-impact session;
`impactStatus: available` means a current projection; and
`impactStatus: omitted-overflow` means current analysis completed but the
bounded display projection could not fit.

**Alternatives:**

- **Persist the raw impact result.** Rejected because changed/impacted lists and
  trust detail are not a bounded storage contract and raw catalog fingerprints
  can contain absolute paths.
- **Recompute impact while generating or viewing a report.** Rejected because a
  later working tree or catalog can produce a different answer from the audited
  run, destroying evidence fidelity and offline report behavior.
- **Find the graph session by latest timestamp or proximity.** Rejected because
  concurrent and partial runs make temporal joins ambiguous. `RunStep.sessionId`
  is the sole detail join.
- **Teach the dashboard graph persistence vocabulary or let it query SQLite.**
  Rejected because graph owns the opaque payload, CLI owns composition, and the
  dashboard is a pure self-contained presentation package.
- **Fail the audit when projection storage overflows.** Rejected because display
  persistence cannot revise the analysis verdict or exit code.

**Rationale:** The Change Impact view must explain the exact audited run even
after the repository changes and without network, Git, parser, or datastore
access in the browser. Graph can safely project its own result vocabulary;
the host can persist it through the existing generic session contribution;
the Run ledger already provides stable parent/step/session identities; and the
dashboard can validate and render a structural read model without depending on
the graph engine.

**Consequences:**

- Collection caps are 200 changed files, 200 changed functions, 500 impacted
  functions, 500 impacted files, 100 impacted packages, and 20 recommended
  commands. Collections sort by raw code-point order before slicing and carry
  exact omitted counts.
- Project-relative paths are limited to 4,096 characters. Symbols, packages,
  commands, refs, and uncertainty display messages are limited to 512
  characters. Invalid identity rows are omitted rather than truncated.
- The complete UTF-8 JSON projection is limited to 1,048,576 bytes. Tail
  trimming is deterministic and increments omitted counts. If even the scalar
  skeleton cannot fit, graph preserves the ordinary session, omits `impact`,
  and records `impactStatus: omitted-overflow`.
- The catalog identity contains bounded build/language/resolution fields plus
  fixed-length SHA-256 digests of the opaque cache key and file fingerprint.
  Raw cache keys and file fingerprints are not copied because both can expose
  local paths. Entity drill-down requires a matching current catalog identity
  and one unique occurrence; mismatch disables navigation but not stored rows.
- The projection persists no source text, Git diff body, absolute project root,
  environment value, credential, or secret. It introduces no egress or network
  call.
- Report selection is a closed `change-impact` view plus an optional validated
  Run ID. Evidence-driven strings cross the HTML boundary through safe JSON
  serialization and escaped/text-only DOM construction.
- Reports distinguish unavailable persistence, missing links, legacy payloads,
  malformed evidence, overflow degradation, partial/unknown verification,
  truncation, and a verified zero-impact result. Absence never means zero.

**Related specs / ADRs:** Extends the opaque payload policy in
[ADR-0050](ADR-0050-payload-schema-evolution.md), host-owned timing/session
policy in [ADR-0051](ADR-0051-host-owned-run-lifecycle-timing.md), impact trust
in [ADR-0123](ADR-0123-impact-analysis-trust-foundation.md), and Run/RunStep
authority in [ADR-0143](ADR-0143-host-owned-run-step-ledger.md). Canonical audit
placement is [ADR-0155](ADR-0155-canonical-audit-command.md). Implementation
specification retained as local-only planning notes (not committed).
