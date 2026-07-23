---
status: current
last_verified: 2026-07-13
release: v0.8.5
title: "Performance SLOs"
audience: [contributors, ci-integrators]
purpose: "Reference for the opensip-cli synthetic performance SLO lane, corpus tiers, budgets, and report artifact."
source-files:
  - .config/performance-slos.json
  - scripts/bench-slo.mjs
  - scripts/perf/
related-docs:
  - ../60-guides/03-wire-into-ci.md
  - ./01-cli-commands.md
  - ./12-public-benchmarks.md
  - ./16-performance-profiling.md
---
# Performance SLOs

OpenSIP CLI tracks performance through a script-level benchmark lane rather than
a new product command. The lane generates deterministic TypeScript corpora,
runs the built CLI end-to-end, measures wall-clock duration plus process-tree
RSS, and writes a JSON report that CI uploads as an artifact.

Run locally:

```bash
pnpm bench:slo -- --profile pr --quick --out slo-report.json
```

CI uses the already-built dist output:

```bash
pnpm bench:slo:ci -- --profile pr --require-memory --out slo-report.json
```

The benchmark never reads `.runtime` logs or datastore internals. It treats the
CLI as a black box, and each scenario runs in a generated project with its own
`opensip-cli.config.yml`.

The SLO lane is always `measurementMode: "clean-wall"`. Its child environment
removes inherited profiling, every `OTEL_*` exporter setting, and trace context
before invoking the CLI. CPU-profile and OTLP experiments use the separate
[performance profiling](./16-performance-profiling.md) lane and cannot feed
budget comparisons.

For published measurements from this lane, see
[Public benchmarks](./12-public-benchmarks.md).

## Corpus Tiers

<!-- opensip:performance-slo-tiers start -->
| Tier | Max files | Max LOC | Default corpus files | Quick corpus files |
|---|---:|---:|---:|---:|
| small | 150 | 30,000 | 120 | 24 |
| medium | 1,000 | 250,000 | 750 | 80 |
| large | 3,000 | 750,000 | 3,000 | 260 |
<!-- opensip:performance-slo-tiers end -->

## Scenario Budgets

<!-- opensip:performance-slo-budgets start -->
| Tier | Scenario | Duration budget | RSS budget |
|---|---|---:|---:|
| small | Fit full run | 20 s | 1.5 GiB |
| small | Fit changed run | 8 s | 1 GiB |
| small | Graph cold build | 30 s | 2 GiB |
| small | Graph warm build | 12 s | 1.5 GiB |
| small | Graph impact files | 8 s | 1 GiB |
| small | Audit changed suite | 18 s | 1.5 GiB |
| small | Graph exact resolution | Not budgeted | Not budgeted |
| small | Graph fast resolution | Not budgeted | Not budgeted |
| small | CLI help startup | Not budgeted | Not budgeted |
| small | HTML report generation | Not budgeted | Not budgeted |
| medium | Fit full run | 60 s | 3 GiB |
| medium | Fit changed run | 18 s | 2 GiB |
| medium | Graph cold build | 90 s | 4 GiB |
| medium | Graph warm build | 25 s | 3 GiB |
| medium | Graph impact files | 15 s | 2 GiB |
| medium | Audit changed suite | 45 s | 3 GiB |
| medium | Graph exact resolution | Not budgeted | Not budgeted |
| medium | Graph fast resolution | Not budgeted | Not budgeted |
| medium | CLI help startup | Not budgeted | Not budgeted |
| medium | HTML report generation | Not budgeted | Not budgeted |
| large | Fit full run | Not budgeted | Not budgeted |
| large | Fit changed run | 40 s | 3 GiB |
| large | Graph cold build | 240 s | 8 GiB |
| large | Graph warm build | 60 s | 6 GiB |
| large | Graph impact files | 30 s | 3 GiB |
| large | Audit changed suite | Not budgeted | Not budgeted |
| large | Graph exact resolution | Not budgeted | Not budgeted |
| large | Graph fast resolution | Not budgeted | Not budgeted |
| large | CLI help startup | Not budgeted | Not budgeted |
| large | HTML report generation | Not budgeted | Not budgeted |
<!-- opensip:performance-slo-budgets end -->

## Report Shape

The report is JSON and includes:

- report kind `opensip-performance-slo`, measurement mode, and the semantic
  SHA-256 fingerprint of the loaded SLO configuration
- complete Node, pnpm, architecture, OS, CPU model/count, CI, branch, and
  commit identity plus Git worktree cleanliness
- corpus facts: tier, generated file count, exact changed-file set, Git
  availability, and a deterministic content SHA-256
- one row per measured scenario with command, cwd, exit status, timeout flag,
  duration, RSS, bounded stdout/stderr tails, and graph profile summary when present
- budget comparisons for exit code, duration, and RSS
- `performance-slo:*` signals for failed budget rows
- top-level `verdict`: `pass`, `warn`, or `fail`

Warnings do not fail the lane. A failed command, timeout, missing required RSS
measurement, or over-budget metric sets `verdict: "fail"` and exits non-zero.
Selected scenarios without budgets still execute and must exit successfully;
they simply omit duration/RSS comparisons.

Public-snapshot eligibility is deliberately stricter than an SLO pass. The
report must also be a non-quick Node 24 `pr` clean-wall run outside CI, retain
complete environment/config/corpus identity, come from a clean Git worktree, and
cover every configured budget with successful non-skipped scenarios.
