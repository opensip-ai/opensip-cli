---
status: active
last_verified: 2026-07-05
owner: opensip-cli
---

# ADR-0130: MCP repo-scoped session reads

```yaml
id: ADR-0130
title: MCP repo-scoped session reads
date: 2026-07-05
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0042]
tags: [mcp, sessions, evidence, scoping]
enforcement: mechanizable
enforcement-reason: >
  Runtime scoping is locked by the predicate matrix in
  packages/session-store/src/__tests__/session-cwd-scope.test.ts and by the MCP
  read-port contract tests in packages/mcp/src/__tests__/repo-scoping.test.ts.
  No source-shaped fitness check can express the containment/filter semantics.
```

**Decision:** MCP result tools serve only sessions whose stored `cwd` is inside
the server's captured project root. The filter is fail-closed, boundary-aware,
case-sensitive string containment in `isSessionCwdWithin`, applied before list
limits; `RunSummary` carries optional `cwd` so agents can see the evidence root.

**Alternatives:**

- **Serve all rows from the selected datastore.** Rejected because a shared or
  copied datastore can expose foreign-project results through the MCP server.
- **Rely only on per-project datastore selection.** Rejected because it does not
  defend against a server started from the wrong cwd or a contaminated runtime
  directory.
- **Use realpath containment for every stored row.** Rejected because rows remain
  evidence after their source directory is deleted, and per-row filesystem
  resolution would add avoidable cost and platform-dependent symlink behavior to
  a read query.

**Rationale:** ADR-0084 made MCP result tools replay stored evidence instead of
re-running tools. That evidence must be scoped to the project the MCP server was
started for, or an agent can unknowingly reason over a different repository's
findings. The shipped implementation captures `projectRoot` in
[`packages/mcp/src/command.ts`](../../packages/mcp/src/command.ts), threads it
to `SessionResultsReadPort`, and uses
[`isSessionCwdWithin`](../../packages/session-store/src/session-cwd-scope.ts)
through `SessionReadRepo.list({ cwdWithin })`.

**Consequences:**

- Case-variant paths and symlink aliases exclude rather than match; the
  predicate deliberately does not normalize through the filesystem.
- `show_run` and `get_latest_findings` fail closed with not-found when the
  resolved session is foreign to the MCP project root.
- `opensip sessions list` remains unscoped by design. It is an operator/history
  command over the selected datastore, not the MCP server's repo-scoped agent
  surface.

**Fitness check:** No new check warranted. This is runtime evidence-scoping
behavior, enforced by `session-cwd-scope.test.ts` and `repo-scoping.test.ts`.

**Related specs / ADRs:** Extends the MCP result-read posture in
[ADR-0084](ADR-0084-mcp-server-surface.md) and preserves the tool-owned payload /
host-owned persistence split from
[ADR-0042](ADR-0042-tool-storage-contract-and-state-store.md).
