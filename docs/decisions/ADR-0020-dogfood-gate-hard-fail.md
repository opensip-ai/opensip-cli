---
status: active
last_verified: 2026-06-06
owner: opensip-tools
---

# ADR-0020: The dogfood gate hard-fails the CI step on error-level findings (ratchet retained for annotations)

```yaml
id: ADR-0020
title: Dogfood gate hard-fails the CI step on error-level findings
date: 2026-06-06
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0017, ADR-0011, ADR-0019, ADR-0001]
tags: [ci, fitness, graph, dogfood, gate]
enforcement: mechanizable
enforcement-reason: >
  Enforced by `runGateMode`'s gate-save branch (`fit-modes.ts`): on a
  fail-threshold breach (`failOnErrors`/`failOnWarnings`) it now sets exit
  RUNTIME_ERROR, so the `pnpm fit:ci` CI step itself fails — mirroring live /
  JSON mode. Regression-pinned by
  `packages/fitness/engine/src/cli/__tests__/fit-gate-mode.test.ts`. The graph
  half (`graph:ci`) is the tracked follow-up (see Consequences).
```

**Decision:** The dogfood gate (`pnpm fit:ci` = `fit --gate-save`, and by policy
`pnpm graph:ci`) must **hard-fail the CI step itself** on a fail-threshold breach
(`failOnErrors`/`failOnWarnings`), not exit 0 and rely solely on the downstream
GitHub Code Scanning net-new ratchet + branch protection. `gate-save` now records
the baseline **and** returns the threshold exit code (mirroring live/JSON mode).
The net-new ratchet is **retained** as the complementary PR-annotation layer (the
SARIF export/upload steps already run under `if: always()`, so they survive a
failed gate) and remains the model offered to consumers onboarding an existing
backlog.

**Alternatives:**

- **(A) `gate-save` returns the threshold exit code; SARIF/ratchet retained via
  `if: always()` (CHOSEN).** The CI step is the honest pass/fail signal and is
  locally reproducible (`pnpm fit` already behaves this way). Defense-in-depth:
  the exit code is the gate; Code Scanning is the rich annotation layer. Con: a
  pre-existing error would now fail CI rather than only annotate — a non-issue
  here because the repo is maintained at **0** fit findings, and exactly the
  behaviour we want.
- **(B, status quo) Keep `gate-save` exiting 0; enforce only via Code Scanning
  net-new + branch protection (REJECTED).** `runGateMode`'s gate-save branch set
  no findings-based exit code, so `failOnErrors: 1` was **dead in CI** and the CI
  step showed green while error-level findings existed. Worse, the `ci.yml`
  comment asserted *"fails on any error-level finding (`failOnErrors: 1`)"* — a
  guarantee the code did not provide. Real enforcement lived entirely in external,
  invisible GitHub config — the precise "trust external check configuration"
  weakness [ADR-0017](./ADR-0017-release-gate-policy.md) rejected for the release
  gate. Applying the same principle to the dogfood gate is the point of this ADR.
- **(C) Make hard-fail opt-in via config (REJECTED).** Reintroduces a
  silent-pass default — the dishonesty we are removing.
- **(D) Net-new ratchet only, no absolute hard-fail (REJECTED for our repo,
  RETAINED for adopters).** The ratchet is essential when onboarding a codebase
  with a large existing backlog (you cannot hard-fail on hundreds of legacy
  findings on day one). It stays available — `failOnErrors: 0` selects
  ratchet-only mode. But for a repo held at 0 findings, hard-fail is the honest
  default. This is a both/and: hard-fail step + net-new annotations, not either/or.

**Rationale:** `fit:ci` is `fit --gate-save`, and `runGateMode`'s gate-save branch
returned `SUCCESS` unconditionally (it saved the baseline and returned; only a
`--report-to` upload failure could fail it). So the configured `failOnErrors: 1`
threshold — honored in live mode and `--json` mode via `buildFitDoneResult`'s
`shouldFail` — never applied to CI. The only thing catching a regression was the
SARIF → Code Scanning net-new diff gated by branch protection: external config,
invisible in-repo, unverifiable locally, while the CI step itself was green and a
code comment overclaimed a guarantee. The fix aligns `fit:ci` with what
`pnpm fit` already does for contributors (the documented local workflow), so it
adds no new behaviour to learn — it removes a surprising exception. The SARIF
export already runs under `if: always()`, so making the gate step fail does not
lose the baseline or the inline PR annotations.

**Consequences:**

- **Fit (implemented now):** `runGateMode`'s gate-save branch computes
  `runFailed = result.shouldFail` and sets exit `RUNTIME_ERROR` when true, passing
  `runFailed` to `deliverFitSignals` so a `--report-to` failure (exit 4) never
  masks the gate verdict (the same rule gate-compare already uses). Pinned by
  `fit-gate-mode.test.ts`. Safe to flip: the repo is at 0 fit findings, so
  `fit:ci` stays green; any future error-level regression now fails the step.
- **The misleading `ci.yml` comment is corrected**, and CLAUDE.md's "Dogfood
  Gate" section is updated (it previously stated "exit 0 regardless of findings").
- **Graph (tracked follow-up):** `graph:ci` (`graph --gate-save`,
  `graph-modes.ts:63-65`) has the identical exit-0 gate-save and must adopt the
  same hard-fail using core's `isErrorSignal` (the `critical`/`high` rung) as the
  threshold. **Prerequisite:** confirm zero *unsuppressed* error-severity graph
  signals on `main` first — flipping it blind could redden `graph:ci` given the
  outstanding wide-function/cycle findings. Scoped as a separate change so this
  one stays safe and focused; the policy in this ADR covers both gates.
- **The net-new ratchet + branch protection remain** for rich PR-diff annotations
  and as the documented model for consumers adopting a backlog (`failOnErrors: 0`
  = ratchet-only).
- **Resolves [ADR-0019](./ADR-0019-external-tool-adapter-checks.md)'s eslint OQ1:**
  once `fit:ci` honors `failOnErrors`, an eslint wrapper emitting error-severity
  findings hard-fails the gate automatically — no separate non-`--gate-save`
  invocation and no retained standalone `pnpm lint` eslint pass are needed for the
  gate guarantee.

**Related specs / ADRs:** Applies [ADR-0017](./ADR-0017-release-gate-policy.md)'s
"don't trust external config; the gate must enforce itself" principle to the
dogfood gate. Builds on [ADR-0011](./ADR-0011-signal-output-currency-formatter-sink.md)
(severity lives on the `Signal`) and [ADR-0001](./ADR-0001-graph-rules-actionable-precise-bounded.md)
(graph gate severities) for the graph follow-up. Unblocks
[ADR-0019](./ADR-0019-external-tool-adapter-checks.md)'s eslint increment (OQ1).
