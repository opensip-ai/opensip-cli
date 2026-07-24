---
status: active
last_verified: 2026-07-23
owner: opensip-cli
---

# ADR-0182: The Linux release gate is report-only during preview burn-in and flips to a hard promotion prerequisite in lockstep with the `supported` status

```yaml
id: ADR-0182
title: The Linux release gate is report-only during preview burn-in and flips to a hard promotion prerequisite in lockstep with the supported status
date: 2026-07-23
status: active
supersedes: []
superseded_by: null
related: [ADR-0164, ADR-0165]
tags: [release, acceptance, platform, linux, support, evidence, burn-in]
enforcement: mechanizable
enforced-by: ['script:linux-qualification-workflow.test.mjs', 'script:verify-supply-chain.mjs', 'script:build-supported-platforms-doc.mjs']
enforcement-reason: >
  The lockstep is a STATIC invariant over two committed files. The
  release-workflow structure test (linux-qualification-workflow.test.mjs) reads
  the ubuntu row status from the generated, gate-synced supported-platforms
  matrix and asserts BIDIRECTIONALLY that `qualify-linux ∈ promote-release.needs`
  iff that status is `supported`: a `preview`/`unqualified` row must keep the job
  OUT of `promote.needs` (advisory burn-in), and a `supported` row must have the
  edge (a supported claim with an advisory gate fails the test). The
  supported-platforms doc generator keeps the matrix status truthful against the
  core registry, and verify-supply-chain check [9] keeps the Linux lane pinned +
  least-privilege so the burn-in signal cannot be forged. The 14-day burn-in
  COUNT itself is a human judgment (the release maintainer links runs and edits
  the matrix through review), so the *bar* is not mechanized — only the
  status↔gate coupling is.
```

**Decision:** The Linux release qualification job (`qualify-linux` in
`release.yml`) is **report-only during preview burn-in** — it runs against the
exact staged/published bytes, seals independently-verified evidence, and fails
*itself* on a non-pass, but it is deliberately **not** in
`promote-release.needs`, so a red Linux run never blocks promotion. The job
becomes a **hard promotion prerequisite atomically with the row's `supported`
status**: the same change that flips
`ubuntu-2404-x64-node24-npm11-v1` from `preview` to `supported` MUST add
`qualify-linux` to `promote-release.needs` and extend the promote job's evidence
recheck with the Linux tuple flags. Status and gate move together or not at all.

**Alternatives:**

- **Hard promotion gate immediately (at `preview`)** — rejected: it blocks every
  release on an unproven young lane. ADR-0165's macOS lane demonstrated exactly
  how a young qualification lane fails first — on GitHub runner-image drift
  (`host-sw-vers-major-mismatch`), a host-drift red that is a *decision* to make,
  not a product defect. Gating promotion on that from day one couples shipping to
  runner-pool weather.
- **Advisory forever (never gate, even at `supported`)** — rejected: a
  `supported` status is the strongest claim the support contract makes (measured,
  past burn-in, *every release evidence-gated*). A `supported` row whose release
  gate is advisory is the precise false promise the contract exists to prevent —
  the matrix would assert a guarantee the pipeline does not enforce.
- **Manual coupling (flip status, remember to wire the gate)** — rejected: a
  human step that can be forgotten is a latent false promise. The coupling must be
  a mechanical invariant.

**Rationale:** The burn-in period is exactly the window in which the lane's own
reliability is still unknown, so its verdict must be *observed, not obeyed*. Once
the lane has earned `supported` through the same bar macOS used (14 consecutive
scheduled-lane greens at the pinned profile version + a staged-bytes release
pass), the whole point of `supported` is that promotion is evidence-gated —
advisory is no longer coherent. Encoding the coupling as a bidirectional
structure test (rather than prose or a checklist) means a `supported` flip that
forgets the `needs` edge, or a `needs` edge added while still `preview`, both
fail CI. Runner-image drift stays a deliberate decision, not a mystery red: a
host-fact mismatch fails the run with its reason code, and widening a tolerance
requires an explicit profile `version` bump on the acceptance profile
(`.config/platform-acceptance/ubuntu-2404-x64-node24-npm11-v2.json`), never a
silent expectation edit — the same fail-loud drift-bump posture ADR-0165
established for macOS.

**Consequences:**

- During burn-in, `qualify-linux` appears on release runs as an independent,
  honestly-red-or-green job whose evidence is archived, but promotion depends only
  on `[stage-release, qualify-macos]`. Reading a red Linux job as a release
  blocker is a misread of the burn-in posture.
- `qualify-linux` is a **sibling job, not a `strategy.matrix` leg** of
  `qualify-macos`: the asymmetric gate posture (macOS hard, Linux advisory) cannot
  be expressed as a matrix, because `promote.needs` cannot depend on a single
  matrix leg. This duplication is intentional and enforced by the topology test.
- The future `supported`-flip is a single reviewed PR that (1) flips the row
  status in the core registry, (2) regenerates the matrix, (3) adds the
  `promote.needs` edge, and (4) extends the promote recheck with the Linux tuple.
  The lockstep test refuses any subset of those.
- The support row remains additive: it does not bump
  `PLATFORM_SUPPORT_CONTRACT_VERSION` (per the platform-support compatibility
  class in ADR-0165); the generated matrix and agent/MCP catalogs pick it up from
  the single registry.

**Related ADRs:** [ADR-0165](ADR-0165-macos-ga-support-qualification.md) — the
macOS GA support contract this second tuple joins (same staged-before-promotion
evidence model, same burn-in bar, same fail-loud drift-bump posture).
[ADR-0164](ADR-0164-installed-artifact-platform-acceptance-evidence.md) — the
closed installed-artifact acceptance profile + independently verifiable evidence
the Linux lane consumes.
