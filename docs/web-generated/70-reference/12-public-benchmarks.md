---
status: current
last_verified: 2026-07-07
release: v0.5.1
title: "Public benchmarks"
audience: [getting-started, ci-integrators, contributors]
purpose: "Published benchmark evidence for opensip-cli's synthetic SLO lane: measured commands, corpus sizes, environment, and SLO margins."
source-files:
  - docs/public/70-reference/benchmark-snapshot.json
  - .config/performance-slos.json
  - scripts/bench-slo.mjs
  - scripts/build-public-benchmarks-doc.mjs
related-docs:
  - ./11-performance-slos.md
  - ../60-guides/03-wire-into-ci.md
  - ../00-start/03-vs-other-tools.md
---
# Public Benchmarks

These numbers come from the synthetic performance SLO lane. The benchmark
generates deterministic TypeScript corpora, runs the built CLI as an external
process, measures wall-clock duration and process-tree RSS, and writes a JSON
report. This page renders a committed snapshot of that report so the public docs
have concrete, reproducible numbers.

Reproduce the snapshot locally:

```bash
pnpm bench:slo -- --profile pr --out /tmp/opensip-public-benchmark-report.json
pnpm docs:benchmarks -- --report /tmp/opensip-public-benchmark-report.json
```

The budgets that decide pass/fail are documented in
[Performance SLOs](/docs/opensip-cli/70-reference/11-performance-slos/). These are OpenSIP CLI timings only;
they are not competitor benchmarks.

## Snapshot Summary

<!-- opensip:public-benchmark-summary start -->
| Field | Value |
|---|---|
| Measured at | 2026-07-02T11:31:24.608Z |
| Source | `pnpm bench:slo -- --profile pr --out slo-report.json` |
| Profile | `pr` |
| Quick mode | no |
| Verdict | pass |
<!-- opensip:public-benchmark-summary end -->

## Corpus Sizes

<!-- opensip:public-benchmark-corpora start -->
| Tier | Generated files | Changed files | Git ready |
|---|---:|---:|---|
| small | 120 | 1 | yes |
| medium | 750 | 1 | yes |
<!-- opensip:public-benchmark-corpora end -->

## Results

<!-- opensip:public-benchmark-results start -->
| Tier | Scenario | Status | Duration | Duration budget | Duration margin | Peak RSS | RSS budget | RSS margin | Graph cache |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| small | Fit full run | pass | 3.5 s | 20 s | +16.5 s | 397.8 MiB | 1.5 GiB | +1.1 GiB |  |
| small | Fit changed run | pass | 1.1 s | 8 s | +6.9 s | 373.4 MiB | 1 GiB | +650.6 MiB |  |
| small | Graph cold build | pass | 1.2 s | 30 s | +28.8 s | 429.9 MiB | 2 GiB | +1.6 GiB |  |
| small | Graph warm build | pass | 845 ms | 12 s | +11.2 s | 358.2 MiB | 1.5 GiB | +1.2 GiB |  |
| small | Graph impact files | pass | 829 ms | 8 s | +7.2 s | 356.6 MiB | 1 GiB | +667.4 MiB |  |
| small | Audit changed suite | pass | 1.5 s | 18 s | +16.5 s | 529.3 MiB | 1.5 GiB | +1006.7 MiB |  |
| medium | Fit full run | pass | 1.3 s | 60 s | +58.7 s | 435.6 MiB | 3 GiB | +2.6 GiB |  |
| medium | Fit changed run | pass | 1.3 s | 18 s | +16.7 s | 369.6 MiB | 2 GiB | +1.6 GiB |  |
| medium | Graph cold build | pass | 2.0 s | 90 s | +88.0 s | 487.7 MiB | 4 GiB | +3.5 GiB |  |
| medium | Graph warm build | pass | 977 ms | 25 s | +24.0 s | 357.3 MiB | 3 GiB | +2.7 GiB |  |
| medium | Graph impact files | pass | 840 ms | 15 s | +14.2 s | 358.1 MiB | 2 GiB | +1.7 GiB |  |
| medium | Audit changed suite | pass | 1.8 s | 45 s | +43.2 s | 528.0 MiB | 3 GiB | +2.5 GiB |  |
<!-- opensip:public-benchmark-results end -->

## Environment

<!-- opensip:public-benchmark-environment start -->
| Field | Value |
|---|---|
| Node.js | `v24.16.0` |
| Platform | `darwin` |
| OS release | `25.5.0` |
| CPU count | 18 |
| CI | no |
<!-- opensip:public-benchmark-environment end -->

## How To Read The Margins

Positive margins mean the measured run completed within the configured SLO.
Negative margins mean the run exceeded the budget and should fail the SLO lane.
Warnings come from the SLO comparison layer when a measurement reaches at least
90 percent of its budget.

## Limits

The benchmark corpus is synthetic. It is useful for regression detection and
public reproducibility, but it is not a substitute for running OpenSIP CLI on
your own repository. Real projects can be slower or faster depending on language
mix, ignored files, target globs, graph shape, and enabled checks.
