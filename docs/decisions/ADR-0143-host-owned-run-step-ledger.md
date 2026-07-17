---
status: active
last_verified: 2026-07-12
owner: opensip-cli
---

# ADR-0143: Host-Owned Run + Step Execution Ledger

```yaml
id: ADR-0143
title: Host-owned Run + Step execution ledger
date: 2026-07-08
status: active
supersedes: []
superseded_by: null
related: [ADR-0093, ADR-0051, ADR-0100, ADR-0084, ADR-0036, ADR-0111, ADR-0117, ADR-0135]
tags: [cli, host-planes, persistence, sessions, suites, evidence, mcp]
enforcement: mechanizable
enforced-by: ['script:dashboard-overview-suite-grouping.test', 'script:dashboard-external-tab.test']
enforcement-reason: >
  Focused dashboard tests assert the overview read model is ledger-only: sessions
  without a run ledger do not produce Recent Activity rows, implicit one-step
  tool runs render from the ledger, and linked sessions are used only for
  drill-in/detail enrichment.
```

**Decision:** Add a host-owned, persisted **Run + RunStep** execution ledger as the
canonical evidence record for both standalone tool commands and multi-step suites.
Direct tool runs are represented as implicit one-step runs. Suite runs persist the
authoritative parent aggregate and declared step manifest that `runSuite` already
computes in memory (`SuiteRunResult`). `StoredSession` rows remain child artifacts
linked from steps when present; they are not the suite parent record.

Partially amend ADR-0093 by retiring the consequence that forbids a suite-level
persisted record ("no new session kind and no suite-level record" at ADR-0093:37-39).
This does not supersede ADR-0093 as a whole. ADR-0093's other decisions remain:
suites are not Tools, steps re-dispatch through `CommandSpec`, suites share one
`RunScope`, and baselines stay per-tool (ADR-0036).

Use product-family vocabulary **`Run`** and **`RunStep`** (not `RunInvocation`) to
align with the cloud-side parent/child run evidence model. Publish an explicit
identity taxonomy distinguishing correlation (`RunScope.runId`), persisted
`Run.id`, `RunStep.id`, step `ordinal`, tool `stableId`, legacy `session.id`, and
legacy `suiteRunId`.

**Alternatives:**

- **Keep session-only persistence with `suiteRunId` grouping.** Rejected. Child-session
  reconstruction is lossy (dual aggregates, missing steps, heuristic MCP ordering).
  Evidence from the collaborative architecture review.
- **Persist only a JSON blob parent row without normalized steps.** Rejected for the
  long-term read model. Acceptable only as a time-boxed first slice if it links
  forward to normalized `run_steps` in the same spec.
- **Introduce `RunInvocation` as the canonical name.** Rejected. Overloads existing
  CLI meanings (`RunPlaneInvocation`, per-CLI bootstrap) and forks cloud vocabulary
  (`Run` + child assessment rows).
- **Mount configured suites as root commands (`opensip audit`).** Rejected for this
  decision. ADR-0111 explicitly chose `opensip suite run audit`; root aliases require
  a separate ADR and reserved-name validation.
- **Require every verdict-producing step to persist a generic `StoredSession`.**
  Rejected. Auxiliary verdict commands (e.g. `graph impact`) may persist step
  evidence without a full tool session row.

**Rationale:** Execution is already unified: suite steps call `runCommandSpecAction`
(`packages/cli/src/commands/suite/suite-step-runner.ts:160-161`) with the same host
run hooks as standalone commands (`packages/cli/src/commands/run-command-spec-action.ts:36-45`).
The gap is durability and read-model authority. `runSuite` returns a complete
`SuiteRunResult` with `deriveSuiteAggregate` (`packages/cli/src/commands/suite/orchestrator.ts:140-196`),
but the handler emits it as a `CommandResult` and exits without persistence
(`packages/cli/src/commands/suite/suite-command-specs.ts:163-169`). The dashboard
re-derives suite aggregates from child sessions (`packages/dashboard/src/client/overview.ts:108-140`),
which disagree with the runtime aggregate when sessions are missing, duplicated, or
incomplete.

ADR-0051 correctly keeps generic session timing host-owned. This ADR adds a sibling
ledger for composition runs without giving tools a suite API or a generic-session
writer. Tools continue to return `ToolSessionContribution` through documented seams;
the host stamps timing, persists sessions, and now also persists the parent Run and
observed RunSteps.

**Consequences:**

- Add SQLite tables `runs` and `run_steps` (names illustrative; exact schema in spec).
- Dual-write: suites -> one Run + N steps; standalone verdict-producing commands ->
  implicit one-step Run.
- Dashboard Overview reads the ledger exclusively. `StoredSession` rows may enrich
  linked steps for tool detail/navigation, but the browser must not reconstruct
  Recent Activity rows or suite aggregates from sessions. If pre-ledger rows need
  to appear in Overview, they must be explicitly backfilled into `runs` /
  `run_steps` as `source: reconstructed`; there is no client fallback.
- Report, dashboard, and MCP read paths use the ledger for run history; `sessions
  show` replay remains for tool payloads and drill-in artifacts.
- Step rows carry stable step ids, ordinals, effective args/selectors, envelope
  summaries, optional `session_id`, and reserved fields for `attempt`, `parent_step_id`,
  and `dependency` even while v1 execution stays serial-only.
- Legacy rows may be backfilled as `source: reconstructed` when ordinals or effective
  args are incomplete. This is an explicit datastore migration/projection step,
  not a dashboard compatibility path.
- Root-level suite aliases remain out of scope until ADR-0111 is explicitly superseded.
- ADR-0093 remains active, but its "no suite-level record" consequence is retired;
  do not infer that suites must remain session-grouping-only in new code.

**Related specs / ADRs:** Partially amends ADR-0093 and extends ADR-0051,
ADR-0100. Complements ADR-0084 (MCP replay). Does not supersede ADR-0111.

## Amendment: Reserved Audit Entry And Returned Run Identity (2026-07-12)

[ADR-0155](ADR-0155-canonical-audit-command.md) resolves this ADR's root-alias
deferral narrowly. The host reserves top-level `opensip audit` for the curated
built-in definition and routes it through the same suite executor and ledger as
`suite run`; configured suites are not mounted at root. The broader rejection of
configured root aliases remains active.

`SuiteRunResult.runId` is now the optional projection of the authoritative
persisted `StoredRun.id`. It is present when Run-ledger persistence succeeds and
absent when persistence is unavailable; consumers must not substitute
`suiteRunId`, a timestamp, or a latest-row lookup. The legacy `suiteRunId`
remains correlation identity. [ADR-0156](ADR-0156-bounded-stored-impact-proof.md)
uses the selected `StoredRun.id` and the matching `RunStep.sessionId` as the only
route to stored graph impact detail.
