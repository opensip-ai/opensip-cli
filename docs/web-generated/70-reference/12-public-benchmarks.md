---
status: current
last_verified: 2026-07-13
release: v0.7.0
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
  - ./16-performance-profiling.md
---
# Public Benchmarks

These numbers come from the synthetic performance SLO lane. The benchmark
generates deterministic TypeScript corpora, runs the built CLI as an external
process, measures wall-clock duration and process-tree RSS, and writes a JSON
report. This page renders a committed snapshot of that report so the public docs
have concrete, reproducible numbers.

Snapshot generation accepts only an explicit `clean-wall` SLO report. CPU
profiles and OTLP experiments are useful for locating work, but their overhead
cannot become a published runtime number. See
[Performance profiling](/docs/opensip-cli/70-reference/16-performance-profiling/).

Publication requires a passing, non-quick `opensip-performance-slo` report
using the `pr` profile, `clean-wall` mode, Node 24, and a non-CI environment with
complete identity and a clean Git worktree. Its configuration fingerprint must
match the checked-in SLO config; each deterministic corpus must retain its
content SHA-256 and exact changed-file set; every scenario must succeed without
being skipped or timed out; and all configured exit, duration, and RSS budget
rows must be present, recomputed from the scenario measurements, and passing.

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
| Measured at | 2026-07-14T05:46:35.868Z |
| Source | <code>pnpm bench:slo -- --profile pr --out slo-report.json</code> |
| Measurement mode | <code>clean-wall</code> |
| SLO config SHA-256 | <code>cd59beb0442d80b91ed99a16ad2b298d7d31be8b2ebce74c1c95c3aa13168528</code> |
| Profile | <code>pr</code> |
| Quick mode | no |
| Verdict | pass |
<!-- opensip:public-benchmark-summary end -->

## Corpus Sizes

<!-- opensip:public-benchmark-corpora start -->
| Tier | Generated files | Changed files | Git ready | Content SHA-256 |
|---|---:|---:|---|---|
| small | 120 | 1 | yes | <code>34f41dce96376dd3c3652681f38eabd88d781c1c74b2c0b898427111c527cb0d</code> |
| medium | 750 | 1 | yes | <code>df4837c5d2c151a6c0a8c6ca00fa5ac892c4d67ad190eb0792e851728964a60c</code> |
<!-- opensip:public-benchmark-corpora end -->

## Results

<!-- opensip:public-benchmark-results start -->
| Tier | Scenario | Status | Duration | Duration budget | Duration margin | Peak RSS | RSS budget | RSS margin | Graph cache |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| small | Fit full run | pass | 1.2 s | 20 s | +18.8 s | 382.2 MiB | 1.5 GiB | +1.1 GiB |  |
| small | Fit changed run | pass | 1.2 s | 8 s | +6.8 s | 373.0 MiB | 1 GiB | +651.0 MiB |  |
| small | Graph cold build | pass | 1.4 s | 30 s | +28.6 s | 454.0 MiB | 2 GiB | +1.6 GiB | miss |
| small | Graph warm build | pass | 1.0 s | 12 s | +11.0 s | 371.5 MiB | 1.5 GiB | +1.1 GiB | hit |
| small | Graph impact files | pass | 951 ms | 8 s | +7.0 s | 372.9 MiB | 1 GiB | +651.1 MiB |  |
| small | Audit changed suite | pass | 1.7 s | 18 s | +16.3 s | 530.8 MiB | 1.5 GiB | +1005.3 MiB |  |
| medium | Fit full run | pass | 1.4 s | 60 s | +58.6 s | 469.7 MiB | 3 GiB | +2.5 GiB |  |
| medium | Fit changed run | pass | 1.5 s | 18 s | +16.5 s | 392.0 MiB | 2 GiB | +1.6 GiB |  |
| medium | Graph cold build | pass | 2.4 s | 90 s | +87.6 s | 557.9 MiB | 4 GiB | +3.5 GiB | miss |
| medium | Graph warm build | pass | 1.1 s | 25 s | +23.9 s | 402.3 MiB | 3 GiB | +2.6 GiB | hit |
| medium | Graph impact files | pass | 937 ms | 15 s | +14.1 s | 373.6 MiB | 2 GiB | +1.6 GiB |  |
| medium | Audit changed suite | pass | 2.0 s | 45 s | +43.0 s | 580.6 MiB | 3 GiB | +2.4 GiB |  |
<!-- opensip:public-benchmark-results end -->

## Environment

<!-- opensip:public-benchmark-environment start -->
| Field | Value |
|---|---|
| Node.js | <code>v24.16.0</code> |
| pnpm | <code>11.10.0</code> |
| Architecture | <code>arm64</code> |
| Platform | <code>darwin</code> |
| OS release | <code>25.5.0</code> |
| CPU model | Apple M5 Max |
| CPU count | 18 |
| Git commit | <code>9d56368a52404935a5e016986fd176f4bf44975d</code> |
| Git branch | <code>codex/06-performance-optimization-program</code> |
| Git worktree dirty | no |
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
