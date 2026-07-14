---
status: current
last_verified: 2026-07-13
release: v0.6.0
title: "Performance profiling"
audience: [contributors, ci-integrators]
purpose: "Contributor workflow for clean-wall benchmarks, CPU profiles, graph stage evidence, toolchain throughput, and performance PR proof."
source-files:
  - scripts/bench-profile.mjs
  - scripts/bench-toolchain.mjs
  - scripts/perf/
  - packages/cli/src/telemetry/profiling.ts
related-docs:
  - ./11-performance-slos.md
  - ./12-public-benchmarks.md
  - ../60-guides/03-wire-into-ci.md
  - ../../decisions/ADR-0162-typescript-7-1-readiness.md
  - ../../decisions/ADR-0163-local-cpu-profiling-independent-of-otel-export.md
---
# Performance Profiling

OpenSIP CLI separates measurements that answer two different questions:

| Lane | Question | May change CI budgets or public numbers? |
|---|---|---|
| `bench:slo` / clean `bench:profile` | How long and how much memory does the built CLI use? | Yes, after repeatable same-host evidence. |
| `bench:profile --cpu-profile` | Where does a measured command spend CPU time? | No. Pair it with a clean-wall run. |
| `bench:toolchain` | How long do build, typecheck, and type-aware ESLint take? | No. This is developer/CI throughput, not built-CLI runtime. |

Every runtime report records `measurementMode`. Budget comparison and public
snapshot generation reject an explicit mode other than `clean-wall`. This keeps
inspector and telemetry overhead out of customer-facing claims.

## Measurement surface inventory

Use the narrowest surface that answers the question. These lanes complement one
another; a ranking artifact is not automatically proof of a wall-time win.

| Surface | Best question | Evidence and posture |
|---|---|---|
| `bench:slo` / `bench:slo:ci` | Did an end-to-end command stay inside its deterministic duration and process-tree RSS budget? | One clean-wall sample per configured tier/scenario. This is the CI budget and public-snapshot source. |
| `bench:profile` | Which scenario or named startup/graph stage should a contributor investigate, and did its median move? | Repeated clean-wall or explicitly profiled samples, retained corpora, RSS summaries, startup diagnostics, and bounded artifact indexes. |
| `graph --profile <file>` | Which graph stage or rule consumes the graph engine's measured work? | Graph-owned JSON with discover/parse/walk/resolve/index/features/rules timing. It does not represent process startup. |
| Command diagnostics | Which bootstrap or pre-action phase is visible in a JSON command result? | Host-owned startup/pre-action events; `bench:profile` extracts only bounded timing fields. Missing diagnostics remain valid optional data. |
| `OPENSIP_PROFILING=1` / `.cpuprofile` | Which JavaScript/V8 stacks consume CPU after the scoped profiler starts? | Sensitive local inspector artifact plus a small labels sidecar; experiment evidence only. |
| Local OTLP spans | How do existing CLI, graph-stage, fitness-check, and worker boundaries nest across a run? | Optional export to a user-configured collector. Keep performance experiments loopback-only and pair them with clean-wall proof. |
| `bench:fork-cost` | Is process/fork startup large enough to justify a worker-specific sprint? | Conditional ranking experiment; it does not create a mandatory optimization task. |
| `bench:partition` | Does a graph partition strategy improve a sufficiently large graph without changing results? | Manual graph strategy/equivalence experiment, not a general CLI startup benchmark. |
| `bench:toolchain` | How long do build, typecheck, and type-aware lint take with a named Turbo-cache posture? | Developer/CI throughput only; never a built-runtime claim. |

The internal profiler is entered after the host has a `RunScope`. Root
`opensip --help` exits through an earlier bailout, so that scenario intentionally
may have no internal `.cpuprofile` or startup-diagnostic payload. Use its
clean-wall row for customer-visible startup, and use a non-bailout command—or an
explicit external Node `--cpu-prof` experiment—when loader/bootstrap stacks are
the question.

The cycle's span audit found the existing stage boundaries sufficient for the
ranked work: graph uses one `opensip_cli.graph.<stage>` span in both sequential
and shard-worker paths, fitness uses `fitness.check.execute`, and the CLI owns
command duration plus startup/pre-action diagnostics. Graph rules already carry
their own profile timings, and external-adapter runs already retain bounded run
duration. Neither appeared as a missing top-band boundary, so this cycle adds no
inner-loop spans. SDK ownership stays in `packages/cli`; tools use the
`@opensip-cli/core` no-op telemetry seam, and metric labels remain
low-cardinality.

## Baseline capture protocol

Build once with Node 24, ensure the worktree and runtime inputs are known, and
write reports outside the repository. Every retained capture records Node,
pnpm, OS, architecture/CPU, branch, commit, and measurement mode. A clean-wall
capture has no CPU profile or trace evidence by design.

The initial cycle capture used Node `v24.16.0`, pnpm `11.10.0`, Darwin `25.5.0`,
an Apple M5 Max (18 logical CPUs), and source commit `d129d41a`, with
`measurementMode=clean-wall`. Three quick `graph-cold` samples measured medians
of 1,226 ms (small) and 1,429 ms (medium). This dated local capture is ranking
evidence, not the committed public snapshot; the optimized non-quick SLO report
later in this page is the publication source.

## Fast local workflow

Build once, then capture a repeated clean-wall report:

```bash
pnpm build
pnpm bench:profile -- --profile pr --quick --runs 3 \
  --out /tmp/opensip-profile-clean.json
```

The driver uses deterministic generated repositories, executes the same built
CLI and scenario definitions as the SLO lane, resets scenario state between
samples, and retains corpora and artifacts under `.opensip-profile/` by default.
Use `--cleanup` when the retained inputs are not needed.

Select a single scenario while investigating a hotspot:

```bash
pnpm bench:profile -- --profile pr --scenario graph-cold --runs 3 \
  --out /tmp/graph-before.json
```

The non-gating `optimization` profile adds `graph-exact`, `graph-fast`,
`cli-help`, and `report-generate`. These scenarios are ranking evidence; they do
not acquire budgets merely by appearing in the config.

After one focused change, repeat the exact command and compare reports:

```bash
pnpm bench:compare -- \
  --base /tmp/graph-before.json \
  --head /tmp/graph-after.json
```

The comparison aligns tier/scenario metrics and graph stages, reports duration
and RSS deltas, and warns about runtime or toolchain differences. It rejects
clean-wall versus CPU-profile comparisons unless
`--allow-mode-mismatch` is supplied for a diagnostic-only diff.

## CPU profile experiments

The CLI uses Node's built-in inspector profiler. Profiling is explicit:
`OPENSIP_PROFILING=1` enables local profiles; an OTLP endpoint alone does not.
Tracing and metrics remain separately gated by `OTEL_EXPORTER_OTLP_ENDPOINT`.
This boundary is recorded in
[ADR-0163](../../decisions/ADR-0163-local-cpu-profiling-independent-of-otel-export.md).

```bash
pnpm bench:profile -- --profile pr --scenario graph-cold --runs 1 \
  --cpu-profile --out /tmp/graph-cpu.json
```

The report is stamped `cpu-profile` and indexes only bounded artifact metadata.
It never embeds a `.cpuprofile`, reads `.runtime` logs, or inspects SQLite for
benchmark semantics. Profile and `.labels.json` files may contain local paths,
symbol names, and repository identifiers; treat them as sensitive local
artifacts rather than routine CI uploads.

Optional OTLP export is restricted to a loopback endpoint and requires
`--cpu-profile`, making the experiment posture explicit:

```bash
pnpm bench:profile -- --cpu-profile \
  --otlp-endpoint http://127.0.0.1:4318 \
  --scenario graph-cold --runs 1 --out /tmp/graph-local-otel.json
```

No default path exports to a network collector. Pyroscope is deferred for this
cycle: inspector profiles, graph stage profiles, startup diagnostics, and the
existing OpenTelemetry spans answer the finite ranking questions without a new
runtime dependency or collector.

## What a profile report preserves

The JSON report contains:

- Node, pnpm, architecture, OS, CPU model/count, branch, and commit;
- explicit clean-wall or CPU-profile mode and whether loopback OTLP was used;
- raw bounded measurement rows plus min/median/nearest-rank-p95 summaries;
- process-tree RSS median/max;
- normalized graph stages from the graph profile's `runs[]` records;
- bounded startup and pre-action diagnostics parsed from JSON output; and
- profile artifact directory, relative filename, kind, size, and omitted count.

Raw command output remains bounded. Successful profile samples do not retain
their output document after diagnostic extraction. Failed rows retain only the
configured stdout/stderr tails.

## Node and TypeScript sequence

Node 24 is the baseline and optimization runtime for this cycle. Prove code
changes against optimized Node 24 first. A same-suite Node 26 report is a later
experiment and must not provide this cycle's SLO budgets or public snapshot.

TypeScript 7 is a separate toolchain/API track. Capture the current baseline
with an explicit cache posture:

```bash
pnpm bench:toolchain -- --cache-mode force --runs 3 \
  --out /tmp/opensip-toolchain-ts6.json
```

The fixed order is workspace build, workspace typecheck, then type-aware ESLint.
`force` bypasses Turbo cache reads; `reuse` deliberately measures the cached
developer path. Neither report implies that emitted JavaScript runs faster.
[ADR-0162](../../decisions/ADR-0162-typescript-7-1-readiness.md) keeps TypeScript
7.x deferred until a stable compiler API satisfies OpenSIP's parsing, scanner,
program, diagnostics, symbol, type, signature, alias, and declaration needs.

## Real-repository dogfood

Synthetic corpora are the regression control; this repository is the manual
reference. On a clean Node 24 build, record the commit and run mode, then time:

```bash
node packages/cli/dist/index.js fit --changed --json
node packages/cli/dist/index.js graph --json \
  --profile /tmp/opensip-dogfood-graph.json
node packages/cli/dist/index.js audit --changed --json
```

Dogfood can promote a synthetic blind spot into the hotspot ranking, but it is
not a public benchmark and does not set a synthetic budget.

## Performance PR checklist

1. Capture a same-host, same-Node clean-wall baseline with at least three quick
   repeats.
2. Use graph stages, startup diagnostics, or one CPU-profile experiment to name
   a hotspot. Do not optimize an unranked hunch.
3. Change one coherent leg and add correctness tests beside it.
4. Capture the same clean-wall run after the change and attach the deterministic
   comparison.
5. Run build, typecheck, tests, lint, graph equivalence where applicable, and
   repository dogfood.
6. Ratchet a budget or public snapshot only from stable clean-wall evidence.

The optimization sprint stops when every stage contributing at least 5% of a
primary scenario has a measured win or an evidence-backed `wontfix`, no
unexplained stage exceeds 25%, and further changes are below either the observed
noise floor or a 3% clean-wall median improvement.

## Current hotspot ranking

The initial Node 24 quick baseline identified bundled first-party tool admission
as the largest named startup stage for short graph runs. Graph parse/resolve/walk
was the next named block. Pre-action capability loading was material but smaller.
The final before/after medians and closed ranking are recorded here when the
optimization pass finishes; unprofiled process/module-loader time is kept
explicit rather than being mislabelled as graph-engine work.
