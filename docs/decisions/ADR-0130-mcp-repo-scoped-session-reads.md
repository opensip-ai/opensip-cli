---
status: active
last_verified: 2026-07-07
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
enforced-by: ['script:session-cwd-scope-tests']
enforcement-reason: >
  Runtime scoping is locked by the predicate matrix in
  packages/session-store/src/__tests__/session-cwd-scope.test.ts and by the MCP
  read-port contract tests in packages/mcp/src/__tests__/repo-scoping.test.ts.
  No source-shaped fitness check can express the containment/filter semantics.

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

**Related ADRs:** Extends the MCP result-read posture in [ADR-0084](ADR-0084-mcp-server-surface.md) and preserves the tool-owned payload / host-owned persistence split from [ADR-0042](ADR-0042-tool-storage-contract-and-state-store.md).

---

## Amendment — 2026-07-07: `latest` sentinel scopes selection

The original decision above is **unchanged for explicit session ids**: they
resolve globally against the datastore and are reported as `not-found` when the
resolved session is foreign to the MCP project root (the fail-closed containment
that closes the evidence-corruption class).

The refinement is to the **`latest` sentinel only**. Previously `latest`
resolved the *global* newest session and then failed closed when that row was
foreign — so a single newer foreign run in a shared datastore hid an older but
in-scope run entirely. `latest` now **SELECTS** the newest session whose stored
`cwd` is inside the project root, instead of resolving the global latest and
rejecting it. So `get_latest_findings` (and `show_run` with `ref: latest`, and
`compare_to_baseline` defaulting to `latest`) return the newest **in-scope**
evidence even when a newer foreign run exists in a shared datastore.

**Mechanism:** `cwdWithin` is threaded into the `latest` branch of
`resolveSession` and into `resolveAndReplaySession` via
`SessionReadRepo.latest({ cwdWithin })`, which reuses the same
`isSessionCwdWithin` predicate and the same before-limit filter as `list`. The
MCP `SessionResultsReadPort` passes `projectRoot` as `cwdWithin` at all resolve
sites (the `latest` pre-check plus each replay) so the pre-check and the replay
agree on the same in-scope selection. Explicit ids still pass no `cwdWithin` and
stay unscoped-then-checked as before.

**Consequence to note:** when NO in-scope session exists, `latest` returns
`not-found` **without** emitting the per-row `mcp.results.scope.rejected` log —
the foreign row is filtered out before resolution, never resolved-then-rejected.
That log still fires for an explicit foreign id (unchanged).

**Enforcing tests:**
`packages/mcp/src/__tests__/repo-scoping.test.ts` (latest-selection over a newer
foreign row + empty-scope not-found) and
`packages/session-store/src/__tests__/resolve-session.test.ts` (cwdWithin latest
selection, all-foreign not-found, explicit-id ignores cwdWithin).

No schema, migration, or version bump: `cwdWithin` is a query-time filter over
the existing predicate.
