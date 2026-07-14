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
and RSS deltas. By default it rejects mismatched measurement mode,
report/profile/quick posture, OTLP posture, configuration or corpus
fingerprint, cache/toolchain protocol, host context, Node runtime, pnpm, or
TypeScript. `--allow-runtime-mismatch` and `--allow-toolchain-mismatch` opt into
those intentional comparison axes. `--allow-context-mismatch` and
`--allow-mode-mismatch` produce diagnostic output but suppress performance
deltas. Legacy reports may parse, but missing required context also suppresses
deltas.

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

- Node, pnpm, architecture, OS, CPU model/count, branch, commit, and worktree
  cleanliness;
- explicit clean-wall or CPU-profile mode and whether loopback OTLP was used;
- raw bounded measurement rows plus min/median/nearest-rank-p95 summaries;
- process-tree RSS median/max;
- normalized graph stages from the graph profile's `runs[]` records;
- bounded startup and pre-action diagnostics parsed from JSON output; and
- profile artifact directory, relative filename, kind, size, and omitted count.

Raw command output remains bounded. Successful profile samples do not retain
their output document after diagnostic extraction. Failed rows retain only the
configured stdout/stderr tails.

## Artifact handling

Keep raw SLO, profile, toolchain, and comparison reports outside the repository.
A PR should include the command, environment identity, and compact comparison
summary. Commit `.config/performance-slos.json` only for a justified ratchet,
and commit `benchmark-snapshot.json` plus generated docs only for an eligible
reference refresh. Do not routinely upload `.cpuprofile` or labels sidecars;
they may contain local paths and symbols.

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

The stable before/after experiment used seven quick `graph-cold` repeats on the
same Node 24 host. Percentages below are shares of the before median, not a claim
that every unattributed millisecond is one subsystem.

| Hotspot | Stable Node 24 evidence | Disposition |
|---|---|---|
| Bundled first-party tool admission | Small: 222.6 ms of 1,157 ms (19.2%); medium: 219.7 ms of 1,259 ms (17.5%). Parallel admission raised the stage to 230.1/224.5 ms and overall medians to 1,181 ms (+2.1%) / 1,300 ms (+3.3%). | Reverted. `wontfix` for this cycle: the measured candidate regressed. |
| Exact TypeScript parse | Small: 115 ms (9.9%); medium: 119 ms (9.5%). | `wontfix`: exact mode requires semantic program/checker construction, and the profile found no removable duplicate work that preserved equivalence. |
| Exact TypeScript resolution | Medium: 77 ms (6.1%). | `wontfix`: required for exact call/reference evidence. `graph-fast` remains the explicit lower-fidelity alternative; default correctness is not weakened. |
| AST walk | Medium: 63 ms (5.0%). | `wontfix`: required linear traversal with no isolated avoidable hotspot. |
| Whole-process loader/runtime work | An external `node --cpu-prof` sample covered 1,149 ms of a 1,190 ms small graph-cold wall run. Node ESM/package loading plus its native file operations accounted for 642 ms (55.9% of sampled time); graph-owned work was 237 ms. | Explained and `wontfix` for this cycle. Reducing it requires a broad lazy-descriptor/module-graph redesign, not a safe one-leg graph-engine change. The whole-process profile closes the former >25% attribution gap. |
| Targeting, fitness, and report/persistence | The final optimization profile measured `fit-changed` at 1,212 ms and `report-generate` at 993 ms; neither produced a new repeated named stage in the top band. | Not promoted. Keep the named diagnostics and revisit only if a same-scenario profile isolates a stable stage above the threshold. |
| Worker/process boundary | Three alternating repeats on fresh 24-file corpora measured fit worker/in-process at 1,094/1,089 ms and graph at 1,083/1,082 ms. Structured result fingerprints matched across modes. | `wontfix`: the 0.1–0.5% differences are below the observed noise floor. The subprocess trust boundary stays intact. |
| Real-repository dogfood | `fit --changed`: 17.58 s; graph: 11.59 s wall with 8.879 s graph work (8.248 s sharded build); audit: 18.30 s. | No additional synthetic blind spot was promoted. Repository scale changes total time, but the named evidence remains consistent with the ranked categories above. |

No primary `pr` scenario produced a stable clean-wall improvement above the 3%
stop threshold. The only focused candidate regressed and was reverted. The
ranked list therefore closes as a measured noise-floor/no-win outcome. Existing
SLO budgets were not tightened; the refreshed public snapshot records the
current eligible Node 24 reference rather than claiming an optimization win.

### Next-cycle calibration note

Measurement identity is trustworthy enough for a follow-up **absolute
clean-wall calibration** cycle: multi-day same-host clean-wall medians, an
explicit noise model, and budget tightening from the measured distribution (for
example p95 × a documented safety factor)—never from cpu-profile or OTLP runs.
Until that cycle lands, CI budgets may retain substantial headroom and only
catch catastrophic regressions; that is intentional, not a license to ratchet
from noisy experiments.

## Cycle validation evidence

All retained raw reports were written under `/tmp` and were not committed.

- At source commit `9d56368a52404935a5e016986fd176f4bf44975d`, the final
  non-quick Node `v24.16.0` `pr` SLO report passed all 12 scenarios in
  `clean-wall` mode from a clean Git worktree. Durations ranged from 937 ms to
  2,404 ms and process-tree RSS from 372 MiB to 581 MiB. Its semantic SLO-config
  SHA-256 is
  `cd59beb0442d80b91ed99a16ad2b298d7d31be8b2ebce74c1c95c3aa13168528`;
  the small/medium corpus content SHA-256 values are
  `34f41dce96376dd3c3652681f38eabd88d781c1c74b2c0b898427111c527cb0d` and
  `df4837c5d2c151a6c0a8c6ca00fa5ac892c4d67ad190eb0792e851728964a60c`.
  This publication-eligible report is the only report used for the public
  snapshot.
- A three-repeat quick Node 24 clean profile passed all 36 samples. Graph-cold
  medians were 1,169 ms small and 1,261 ms medium; all scenario medians ranged
  from 951 ms to 1,641 ms.
- The separate CPU-profile run passed both graph-cold tiers and produced a
  same-basename `.cpuprofile` plus labels sidecar for each. The profile files
  were 839,114 and 1,103,418 bytes, files were mode `0600`, and their artifact
  directories were mode `0700`. This verifies artifact plumbing and hotspot
  evidence only; it is not budget evidence.
- The non-gating optimization profile passed 24 samples. Small-tier medians
  included graph exact 1,129 ms, graph fast 982 ms, CLI help 896 ms, and report
  generation 993 ms.
- A whole-process external CPU profile covered 1,149 ms of a 1,190 ms
  graph-cold command. Node ESM/package loading and native loader file operations
  accounted for 642 ms (55.9% of samples), closing the prior unattributed
  majority; graph-owned stage time was 237 ms.
- The corrected fork-cost harness used a fresh deterministic corpus per sample,
  alternating order and requiring matching structured-result fingerprints.
  Three-repeat worker/in-process medians were 1,094/1,089 ms for fit and
  1,083/1,082 ms for graph, both below the noise threshold.
- A Node `v26.5.0` SLO and three-repeat clean profile passed only after
  rebuilding the local `better-sqlite3` binding for that runtime. The explicit
  `--allow-runtime-mismatch` comparison was directionally faster in most rows,
  but Node 26 data is excluded from budgets and publication. The binding was
  rebuilt for Node 24 before final validation.
- The forced-cache TypeScript 6 toolchain baseline used three fixed-order
  repetitions. Build/typecheck/type-aware-ESLint medians were 15.192 s,
  25.514 s, and 144.848 s; p95 values were 17.832 s, 25.797 s, and 234.131 s.
- Local OTLP export was skipped because no local collector was available. It is
  optional by plan, and Pyroscope remains deferred.
