---
status: current
last_verified: 2026-07-02
release: v0.2.4
title: "Impact analysis and trust"
audience: [contributors, ci-integrators, agent-builders]
purpose: "How `graph impact` and `fit --changed --include-impacted` report coverage, uncertainty, and conservative fallbacks."
source-files:
  - packages/contracts/src/impact-trust.ts
  - packages/contracts/src/graph-impact-compute.ts
  - packages/contracts/src/command-results-variants/graph-impact-result.ts
  - packages/core/src/lib/git-changed-files.ts
  - packages/graph/engine/src/cli/impact.ts
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
