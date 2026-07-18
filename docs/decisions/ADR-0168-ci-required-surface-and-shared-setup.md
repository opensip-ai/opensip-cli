---
status: active
last_verified: 2026-07-18
owner: opensip-cli
---

# ADR-0168: CI required surface, shared warm setup, and fork-safe reporting

```yaml
id: ADR-0168
title: CI required surface, shared warm setup, and fork-safe reporting
date: 2026-07-18
status: active
supersedes: []
superseded_by: null
related: [ADR-0012, ADR-0017, ADR-0020, ADR-0032]
tags: [ci, github-actions, supply-chain, dogfood, cold-gate]
enforcement: mechanizable
enforced-by: [script:ci-workflow-structure]
enforcement-reason: >
  scripts/__tests__/ci-workflow-structure.test.mjs (invoked via pnpm test:scripts
  / pnpm lint) asserts aggregator membership (including cold-gate), per-job
  timeouts, third-party action SHA shape, workflow default-deny permissions,
  persist-credentials: false, fork-PR SARIF guards, and post-restore
  verify-pnpm-injection on warm lanes.
```

## Context

After the parallel-lane CI rewrite (PR #30), wall-clock improved by running
lint, test, dogfood, graph-equivalence, policy-and-docs, and cold-gate as
sibling jobs. Scorecard gaps remained:

1. `build-and-test` aggregated warm lanes but **not** cold-gate, so a required
   check named only `build-and-test` could ignore a red cold install proof.
2. Jobs had no explicit `timeout-minutes` (except macOS qualification).
3. PR CI floated third-party action tags while release/macOS already pinned SHAs.
4. Each lane re-ran install + two-pass `build-ci`, inflating runner-minutes.
5. Fork PRs red on SARIF upload (`security-events: write` is stripped for forks).

## Decision

1. **Required surface** — `build-and-test` needs every correctness lane including
   `cold-gate`, runs with `if: always()`, and fails unless every need is
   `success`. Sibling lanes still complete when one fails (no global fail-fast).

2. **Timeouts** — Every CI job declares `timeout-minutes` guided by observed
   durations plus margin (test 45, lint/dogfood/cold/graph-eq 30, policy 20,
   setup 25, aggregator 5).

3. **Supply chain** — Third-party actions in `ci.yml` and
   `.github/actions/setup-workspace` are pinned to full 40-char commit SHAs.
   Workflow-level `permissions: contents: read` is the default deny; dogfood
   alone adds `security-events: write`. Every `actions/checkout` sets
   `persist-credentials: false`.

4. **Shared warm setup** — One `setup` job runs frozen install + `build-ci`,
   packs `node_modules` and package `dist/` trees with **`tar -cpf`** (symlink-
   preserving; raw `upload-artifact` of `node_modules` is forbidden because it
   follows links and breaks pnpm injection). Warm lanes download, `tar -xpf`,
   and run **`node scripts/verify-pnpm-injection.mjs`** before work. Cold-gate
   never consumes that artifact.

5. **Fork PRs degrade reporting only** — SARIF uploads run only when
   `github.event_name != 'pull_request' || head.repo.full_name == github.repository`.
   Forks emit an explicit notice and skip uploads; fit/graph/yagni analysis still
   hard-fails on findings.

6. **Phase 2 is a cost win** — Shared setup may not reduce wall-clock (setup is
   serialized) but must cut total runner-minutes versus N full rebuilds.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Global cancel-on-first-failure | Hides independent failures; worse for monorepo PR loops |
| Keep N× rebuild per lane | Simple but fails caching score and burns minutes |
| Floating action tags on PR CI | Supply-chain drift vs release/macOS |
| Raw `upload-artifact` of `node_modules` | Follows symlinks; breaks injectWorkspacePackages |
| Make macOS qualification required on every PR | Product policy keeps it non-blocking evidence / release gate |
| Skip correctness gates on fork PRs | Would greenwash external contributions |

## Consequences

- Setup complexity rises (pack/restore + injection verify).
- Artifact size/time must stay practical on GitHub-hosted runners.
- Dependabot (or a documented bump process) must refresh action SHAs.
- Fork PRs do not produce Code Scanning uploads (GitHub cannot accept them from
  forks regardless); same-repo PRs and main pushes still ratchet.
- Plan 09 CI steps that need `dist/` should consume the shared setup artifact
  rather than re-running `build-ci`.

## Related

- ADR-0017 — release lane re-runs PR-quality gates; ci.yml gate command
  counterparts remain greppable.
- ADR-0012 — immutable npm publish; CI pins reduce unreviewed tag moves into
  the path that gates publish.
- ADR-0032 — graph exact≡sharded equivalence remains a required lane.
