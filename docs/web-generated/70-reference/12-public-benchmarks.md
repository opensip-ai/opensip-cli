---
status: current
last_verified: 2026-07-13
release: v0.6.0
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
| Measured at | 2026-07-14T04:42:30.628Z |
| Source | `pnpm bench:slo -- --profile pr --out slo-report.json` |
| Measurement mode | `clean-wall` |
| SLO config SHA-256 | `cd59beb0442d80b91ed99a16ad2b298d7d31be8b2ebce74c1c95c3aa13168528` |
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
| small | Fit full run | pass | 2.8 s | 20 s | +17.2 s | 437.7 MiB | 1.5 GiB | +1.1 GiB |  |
| small | Fit changed run | pass | 1.3 s | 8 s | +6.7 s | 394 MiB | 1 GiB | +630 MiB |  |
| small | Graph cold build | pass | 1.4 s | 30 s | +28.6 s | 452.6 MiB | 2 GiB | +1.6 GiB | miss |
| small | Graph warm build | pass | 964 ms | 12 s | +11.0 s | 372.1 MiB | 1.5 GiB | +1.1 GiB | hit |
| small | Graph impact files | pass | 938 ms | 8 s | +7.1 s | 371.1 MiB | 1 GiB | +652.9 MiB |  |
| small | Audit changed suite | pass | 1.6 s | 18 s | +16.4 s | 538.9 MiB | 1.5 GiB | +997.1 MiB |  |
| medium | Fit full run | pass | 1.5 s | 60 s | +58.5 s | 428.4 MiB | 3 GiB | +2.6 GiB |  |
| medium | Fit changed run | pass | 1.4 s | 18 s | +16.6 s | 401.0 MiB | 2 GiB | +1.6 GiB |  |
| medium | Graph cold build | pass | 2.5 s | 90 s | +87.5 s | 490.9 MiB | 4 GiB | +3.5 GiB | miss |
| medium | Graph warm build | pass | 1.2 s | 25 s | +23.8 s | 384.9 MiB | 3 GiB | +2.6 GiB | hit |
| medium | Graph impact files | pass | 999 ms | 15 s | +14.0 s | 370.6 MiB | 2 GiB | +1.6 GiB |  |
| medium | Audit changed suite | pass | 2.1 s | 45 s | +42.9 s | 580.2 MiB | 3 GiB | +2.4 GiB |  |
<!-- opensip:public-benchmark-results end -->

## Environment

<!-- opensip:public-benchmark-environment start -->
| Field | Value |
|---|---|
| Node.js | `v24.16.0` |
| pnpm | `11.10.0` |
| Architecture | `arm64` |
| Platform | `darwin` |
| OS release | `25.5.0` |
| CPU model | Apple M5 Max |
| CPU count | 18 |
| Git commit | `68d76fd501babebc274721d55c35a620e270be4c` |
| Git branch | `codex/06-performance-optimization-program` |
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
