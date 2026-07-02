---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0114: Add Read-Only MCP Review Tools

```yaml
id: ADR-0114
title: Add read-only MCP review tools
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0110]
tags: [mcp, agents, sessions, baselines]
enforcement: mechanizable
enforcement-reason: >
  MCP handler/read-port re-run imports are blocked by mcp-results-no-rerun.
  Package layering and tests cover the remaining boundaries: MCP imports
  session-store/datastore/contracts, not cli or output.
```

**Decision:** Add `review_change` and `compare_to_baseline` as read-only MCP
tools over persisted OpenSIP evidence. They replay stored sessions and read
stored baseline rows; they do not re-run tools, read raw logs, or add
write-capable repair/apply behavior.

**Alternatives:**

- Make agents call `suite run audit --changed --json` for every review question.
  Rejected because that re-executes analysis when persisted evidence may already
  answer the question.
- Persist a suite-level review-brief session row. Rejected for this phase
  because the existing host run plane persists tool step sessions with
  `suiteRunId`; no new schema is needed for a read-side MCP projection.
- Import `@opensip-cli/output` and call the host baseline diff. Rejected because
  tools do not import the output package; MCP can compute its read-only
  fingerprint projection directly from `BaselineRepo` rows without taking a
  host-output dependency.
- Add fix-preview/apply MCP tools now. Rejected because spec 07 phases 1-2 need
  a separate repair-action contract and verification design.

**Rationale:** ADR-0084 established MCP as a read-first stdio server whose result
tools replay persisted sessions. ADR-0110 added the v1 `ReviewBrief` contract for
suite output. Agents now need one MCP call for review and baseline-delta
questions without composing several low-level result tools or re-running the
CLI. The new tools preserve those decisions:

- `review_change` rebuilds the v1 `ReviewBrief` from stored suite step sessions.
  Suite steps are persisted with `suiteRunId` and `suiteName`, but not the
  original suite step index; MCP derives a deterministic persisted step index by
  sorting the suite group by `startedAt` and `id`.
- `compare_to_baseline` replays the selected stored run and compares stamped
  `Signal.fingerprint` values to generic baseline rows. Missing baselines are
  reported as degraded evidence, not as a fresh run request.
- Graph catalog state is reported through existing `GraphReadPort.freshness()`.
  The review tool does not call `refresh_graph` automatically.

**Consequences:**

- `opensip mcp` exposes 15 tools: 9 graph tools and 6 result/review tools.
- MCP result/review handlers must continue to use injected ports. Direct imports
  of run-command entry points remain forbidden by `mcp-results-no-rerun`.
- MCP remains read-only in spec 07 phase 0. Fix preview and apply/verify remain
  unimplemented until their own promoted plan lands.
- A stored suite group reconstructed from sessions can differ from the live
  suite run only in step-index provenance when historical sessions lack the
  original suite step index; the derived ordering is documented and tested.

## Fitness Check Evaluation

| Invariant | Check warranted? | Enforcement |
|-----------|------------------|-------------|
| MCP result/review handlers never re-run `fit`/`graph`/`sim`/`yagni`. | Yes | Existing `mcp-results-no-rerun` covers `packages/mcp/src/tools/` and `session-results-read-port`. |
| MCP must not import the CLI composition root. | Yes | Existing dependency-cruiser layering rules. |
| MCP must not import `@opensip-cli/output` for baseline diff. | Not as a new check | Package dependency review and dep-cruiser catch the package edge; unit tests cover the MCP-local fingerprint comparison. |
| Review output must stay bounded. | Not as a fitness check | Handler/read-port tests assert `limit`; this is DTO behavior, not a cross-repo structural invariant. |

**Related specs / ADRs:**

- `docs/plans/specs/07-agent-apply-verify-loop.md`
- `docs/plans/ready/mcp-review-tools/`
- [ADR-0084](ADR-0084-mcp-server-surface.md)
- [ADR-0110](ADR-0110-host-owned-review-brief-contract.md)
