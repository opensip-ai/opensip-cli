---
status: active
last_verified: 2026-06-05
owner: opensip-tools
---

# ADR-0017: Release gate must be at least as strict as the PR gate

```yaml
id: ADR-0017
title: Release gate must be at least as strict as the PR gate
date: 2026-06-05
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0012]       # versioning-and-release-policy (immutable npm versions)
tags: [packaging, ci, release]
enforcement: mechanizable
enforcement-reason: >
  Enforced by the gate steps in `.github/workflows/release.yml` — `pnpm lint`,
  `pnpm test:coverage`, `pnpm fit:ci`, and `pnpm graph:ci` now run BEFORE the
  pack/publish steps, mirroring `.github/workflows/ci.yml`. The package-set half
  of the policy (every release surface ships exactly the discovered publishable
  set) is mechanized by `scripts/release-package-order.mjs` (single source of
  truth), `verify-release.mjs` check #10 (release-time), and
  `packages/cli/src/__tests__/release-package-order-contract.test.ts` (PR-time).
```

**Decision:** The tag-driven release workflow (`.github/workflows/release.yml`)
must enforce every PR-quality gate — `pnpm lint`, `pnpm test:coverage` (per-package
coverage thresholds), and the dogfood gates `pnpm fit:ci` and `pnpm graph:ci` — in
addition to its release-specific gates (consistency check, pack, packed-smoke,
publish), by **re-running** those gates in `release.yml` **before** the pack step.
A tag therefore cannot publish after a code path that would have failed PR CI.

**Alternatives:**

- **(A) Re-run the critical gates in `release.yml` (CHOSEN).** Add `pnpm lint`,
  `pnpm test:coverage`, `pnpm fit:ci`, `pnpm graph:ci` before pack. Fully
  self-contained; immune to branch-protection misconfiguration, force-pushed
  tags, or tags cut from a non-`main` ref. Con: adds the heavier PR-gate runtime
  (coverage + dogfood) to every release — a few minutes; the build is already
  paid in `release.yml`.
- **(B) Verify the tagged SHA already passed required CI (CONSIDERED, REJECTED).**
  Query the GitHub Checks / commit-status API for `github.sha` and fail the
  release unless the required CI suite (`build-and-test` from `ci.yml`) concluded
  `success`. Rejected: it trusts that branch protection + required-check config
  are correct and that the tag points at a SHA that ran the *current* required
  set. A renamed/added required check, a tag on an old SHA, or an API hiccup can
  let a stale pass through; it adds moving parts (auth, pagination, check-name
  matching) and a dependency on external state being configured correctly. The
  saved CI minutes do not justify weakening the guarantee at an immutable
  boundary.
- **(status quo) Release runs only `build` / `typecheck` / plain `test`
  (REJECTED).** This is the gap being closed: no `lint`, no coverage thresholds,
  no dogfood. A tag can publish after a path that would have failed the PR
  workflow — lint regressions, coverage drift, or net-new dogfood findings reach
  npm where versions are immutable.

**Rationale:** npm package versions are **immutable** (ADR-0012: old versions are
retired via `npm deprecate`, never `unpublish`); the release lane is the last gate
before an unrecoverable artifact. `.github/workflows/ci.yml` is the bar — it runs
`pnpm lint`, `pnpm test:coverage`, `pnpm fit:ci`, and `pnpm graph:ci` on every PR.
`.github/workflows/release.yml` ran only `pnpm -r run clean` → `pnpm build` →
`pnpm typecheck` → plain `pnpm test`, so it was strictly weaker than the PR gate.
Option A closes the gap with zero dependency on branch-protection or
required-check configuration being correct: the build is already paid in
`release.yml`, so the marginal cost of coverage + dogfood is a few CI minutes —
cheap relative to a botched, immutable publish. Defense-in-depth at the immutable
boundary beats trusting external state.

**Consequences:**

- Phase 1 adds the re-run gate steps to `release.yml` (lint, test:coverage,
  fit:ci, graph:ci) between `pnpm build`/`pnpm typecheck` and the pack/publish
  steps. The dogfood gates run the compiled engine from `dist`, so they must run
  after `pnpm -r run clean` + `pnpm build` (the same ordering `ci.yml` documents).
- Release runs get longer (coverage + dogfood add a few minutes).
- The dogfood gates now block **publish** as well as PR merge: a net-new
  error-level fit or graph finding on the tagged commit fails the release.
- The SARIF export/upload steps from `ci.yml` are intentionally **not** added to
  `release.yml` — Code Scanning is a PR-diff ratchet; the release gate needs only
  the pass/fail exit.
- `RELEASING.md`'s local-preflight section must mirror the hardened gate so a
  local dry run predicts CI (Phase 1 Task 1.2).
- The generated-artifact sync checks (`build-web-docs --check`,
  `build-package-readmes --check`, `build-package-keywords --check`, checks-index)
  are already enforced in `release.yml` via the first `verify-release.mjs` step, so
  no new steps are needed for those.
- The package-set integrity half of "release ⊇ PR" is mechanized in Phase 2: a
  single source of truth (`scripts/release-package-order.mjs`) that every release
  surface derives from or is verified against, plus `verify-release.mjs` check #10
  (release-time) and a PR-time contract test. This closes the partial-release risk
  where `@opensip-tools/tree-sitter` was present in pack/publish but **omitted**
  from the release preflight loop.

**Related specs / ADRs:** This decision is implemented by the local-only plan
`docs/plans/release-gate-hardening/` (Phases 1–3). It complements
[ADR-0012](./ADR-0012-versioning-and-release-policy.md) (versioning & release
policy: npm version immutability is the reason the release lane is the last
recoverable gate). The two underlying audit findings — the release gate being
weaker than PR CI (P0) and the publishable-package-list drift risk (P0/P1) — are
tracked in this repo's testing-strategy gap register / release-lane backlog.
