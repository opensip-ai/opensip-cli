---
status: current
last_verified: 2026-07-14
release: v0.8.5
title: "Impact analysis and trust"
audience: [contributors, ci-integrators, agent-builders]
purpose: "How `graph impact` and `fit --changed --include-impacted` report coverage, uncertainty, and conservative fallbacks."
source-files:
  - packages/contracts/src/impact-trust.ts
  - packages/shared-analysis/src/graph-impact-compute.ts
  - packages/contracts/src/command-results-variants/graph-impact-result.ts
  - packages/core/src/lib/git-changed-files.ts
  - packages/graph/engine/src/cli/impact.ts
  - packages/graph/engine/src/read/impact-view.ts
  - packages/graph/engine/src/read/test-selection-view.ts
  - packages/fitness/engine/src/cli/fit/changed-targeting.ts
  - packages/cli/src/commands/suite/orchestrator.ts
related-docs:
  - ./01-stages-and-catalog.md
  - ./02-rules-and-gating.md
  - ../60-guides/use-opensip-with-ai-agents.md
---
# Impact Analysis And Trust

`graph impact` answers "what changed and what depends on it?" It combines the
host-owned git changed-file resolver with the persisted graph catalog and returns
changed functions, impacted callers, impacted packages, impacted files, and a
trust verdict.

The trust verdict is machine-readable:

| Field | Meaning |
|---|---|
| `coverage` | `full`, `partial`, or `unknown`. |
| `fullyVerified` | `true` only when targeted impact evidence has no known uncertainty. |
| `fallback` | `targeted` when the caller may rely on narrowed targets; `full-run` when a conservative full target set is required. |
| `uncertainties[]` | Bounded reasons such as `graph-catalog-unavailable`, `graph-catalog-incomplete`, `changed-file-unmatched`, `changed-file-deleted`, `changed-file-renamed`, `git-shallow`, or `impact-truncated`. |

`fit --changed --include-impacted` consumes the same trust vocabulary. When the
graph catalog is unavailable, incomplete, approximate, or cannot match the changed
files, fitness does not silently run changed files only. It emits a warning and
runs the full configured target set so the result is conservative.

Agents and CI annotations should use this rule:

- `fullyVerified: true` means the changed/impacted target set was trusted.
- `fullyVerified: false` means the output is useful evidence, but a targeted run
  is not enough to claim full verification.
- `fallback: "full-run"` means OpenSIP intentionally chose broader execution over
  a possibly missed impacted target.

Suite runs project impact trust onto `data.steps[].verification` when a step emits
it. The host-owned review brief also records partial impact verification in
`reviewBrief.degraded[]`, which turns an otherwise clean suite into a warning
rather than a false pass.

Every graph impact run (including JSON mode) also persists a **bounded impact
report projection** on the graph session payload: capped changed/impacted
lists, explicit omitted counts, catalog identity digests for report drill-down,
and `impactStatus` (`available` or `omitted-overflow`). The human Change Impact
tab joins that session through the parent Run's `RunStep.sessionId` and never
recomputes impact. See
[Report — Change Impact](../70-reference/06-dashboard.md#change-impact) and
[ADR-0156](../../decisions/ADR-0156-bounded-stored-impact-proof.md).

## MCP explicit-file impact

`impact_files` accepts only normalized project-relative `files[]` (maximum 128)
and projects the same canonical `computeImpact` result inside one immutable
`g1:` generation. The generation caches a caller-owned impact index so repeated
queries do not rescan the whole catalog. The response keeps `ImpactTrust`
unchanged and adds the standard inventory/evidence/grouping/projection coverage
facets. Missing or stale graph evidence, unmatched files, caps, and approximate
edges return explicit uncertainty plus `full-run`; a bare empty answer is never
treated as complete.

## Labelled static test selection

`select_tests` combines the exact graph generation with one immutable codebase
inventory snapshot. It walks bounded reverse call/import evidence to test files,
then may add weaker target/convention or co-location candidates only when the
inventory records that basis. Every candidate states its basis, weakest-edge
confidence, bounded proof, and `observed: false`. Body-twin ambiguity lowers
confidence; static reachability never claims observed coverage.

Runnable suggestions come only from package/project script text that parses as
a direct, non-mutating allowlisted verification command, and are returned as
`cwd + argv[]`. Package-manager script wrappers, lifecycle hooks, unsafe shell,
interactive/watch/update flags, and secret-looking arguments are omitted with a
reason. The selector never executes a command and never invents a framework invocation. Uncovered inputs, depth/node/
candidate/command caps, and unsupported evidence carry package/full fallback
tiers. The existing CLI `graph impact` `recommendedCommands` shape is unchanged;
`select_tests` is a separate labelled contract.
