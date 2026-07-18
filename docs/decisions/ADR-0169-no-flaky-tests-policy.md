---
status: active
last_verified: 2026-07-18
owner: opensip-cli
---

# ADR-0169: No flaky tests — root-cause, redesign deterministically, or delete

```yaml
id: ADR-0169
title: No flaky tests — root-cause, redesign deterministically, or delete
date: 2026-07-18
status: active
supersedes: []
superseded_by: null
related: [ADR-0137, ADR-0165, ADR-0168]
tags: [testing, ci, reliability, policy]
enforcement: not-mechanizable
enforcement-reason: >
  The policy governs how humans and agents respond to an intermittent test
  failure — a triage judgment with no static invariant to scan for
  (setTimeout/delay in tests is legitimate as simulation input; only
  wall-clock-as-synchronization is banned, which requires understanding what
  the wait is FOR). The policy's individual outcomes ARE mechanically locked
  in: each root-caused flake ships a deterministic regression test
  (scripts/__tests__/platform-acceptance-journeys.test.mjs contention suite,
  packages/agent-eval/src/runner/process-tree.test.ts orphan-sweep case), and
  the qualification journeys separate infrastructure-timing reason codes from
  candidate-fault codes so timing noise cannot register as product failure.
```

**Decision:** A test that fails intermittently is treated as a bug report and
triaged exactly once, to one of three terminal outcomes: (1) a permanent fix —
of the product defect the flake exposed, or of the test's synchronization
(event-based proofs: settlement, markers, lock identity, recorded events —
never "wait N ms and assume"); (2) a deterministic alternative that proves the
same invariant at a layer where determinism is possible (fixture-driven
orchestration, injected snapshots), with the timing-dependent form deleted; or
(3) outright deletion when the invariant is already proven elsewhere.
Widening a timeout is not an outcome. Repeat nursing of the same test is
prohibited. Harness/journey failures caused by infrastructure timing must
carry distinct reason codes so they can never masquerade as product defects.

**Alternatives:**

- *Quarantine + auto-retry* (rerun failed tests, mark flaky, move on) —
  rejected: retries convert intermittent evidence into silent green, the exact
  false-green inversion the product thesis forbids; this repo's flakes have
  repeatedly been real defects (the measured-process EPIPE kill-race corrupted
  release-evidence signal reporting; the descendant-tracker init-miss silently
  waived process containment; the contention barrier misattributed a harness
  race to the CLI).
- *Tolerate and re-run manually* — rejected: on 2026-07-18 the majority of
  maintenance time was going to re-triaging the same timing-window tests
  ("widen spawn timeout" landed three times against one family) with zero
  customer value.
- *Blanket ban on concurrency/e2e tests* — rejected: they guard the
  qualification lane's real claims; the ban is on wall-clock synchronization,
  not on testing concurrency.

**Consequences:** Diagnosing a flake costs more up front (root-cause with
evidence, not a timeout bump) and occasionally deletes coverage that was
duplicative. In exchange the suite's red is always meaningful: every failure
is either a product defect or carries an explicit infrastructure reason code.
Where the fix is a redesign, the old failure mode must be captured as a
deterministic regression test before the timing-dependent form is removed.

**Origin:** Maintainer policy, stated 2026-07-18 after the never-green macOS
qualification lane diagnosis (see the three defect classes above). The
worked examples of each outcome live in the qualification-lane fix
(synthetic pid-liveness lock replacing a fixed release barrier), the
measured-process kill-before-destroy ordering, and the descendant-tracker
group sweep.
