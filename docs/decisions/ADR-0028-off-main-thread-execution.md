---
status: active
last_verified: 2026-06-25
owner: opensip-cli
---

# ADR-0028: Off-main-process execution for live runs

```yaml
id: ADR-0028
title: Off-main-process execution for live runs
date: 2026-06-08
status: active
supersedes: []
superseded_by: null
related: [ADR-0016, ADR-0011, ADR-0027]
tags: [cli, ux, performance, graph, simulation, fitness, architecture]
enforcement: mechanizable
enforcement-reason: >
  The surviving ADR-0058 enforcement is `live-view-through-cli-live`
  (checks-typescript), which forbids `import { render } from 'ink'` in tool
  engines — it does NOT assert the off-thread selector (`runOffThreadOrInProcess`).
  The former `live-runs-off-thread` check that asserted runners route through the
  off-thread selector has lapsed (no longer present under `packages/`). The
  transport relay/buffer/error/fallback behaviour is covered by unit tests in core.
  Restoring off-thread-selector coverage is deferred (spec 01 / OQ4).
```

**Decision:** Interactive (TTY) runs execute the engine **off the main process**.
The runner forks the CLI to a per-tool headless worker subcommand
(`fit-run-worker` / `sim-run-worker` / `graph-run-worker`) over the
`ProgressTransport` seam; the worker re-bootstraps the full CLI scope, runs the
engine, and streams `ProgressEvent`s + a slim, serializable result back over IPC.
The main process runs **only** Ink + the 80 ms clock, so the live spinner and the
stage checklist never starve. Persistence and cloud egress stay on the main
process, after the run, from the returned result. `--json` / non-TTY paths stay
fully in-process (no fork), and an `OPENSIP_CLI_NO_WORKER=1` escape hatch forces
the in-process fallback (which is also taken automatically if the fork fails).

**Alternatives:**

- *Cooperative yielding only (ADR-0016, the prior decision).* Rejected as
  insufficient. ADR-0016 chose in-process execution with the heavy graph `resolve`
  loop yielding every 250 call sites, on the premise that yielding the `resolve`
  stage was enough to keep the clock ticking. It is not: the dominant cost on a
  real repo is the **synchronous** work the in-process path cannot interleave with
  Ink — graph's TypeScript `parse` stage (one `ts.createProgram` type-check) and
  the per-check/per-scenario synchronous CPU chunks in fit/sim. `await` only yields
  microtasks; the 80 ms macrotask clock and Ink's reconciler are starved for the
  duration of each synchronous chunk, so the spinner visibly stutters. ADR-0016
  *explicitly reserved* this reversal ("if a future heavy tool … genuinely needs
  process isolation, graph's transport can be swapped to a subprocess *then*,
  behind the same stable boundary") — this ADR exercises that reserved escape
  hatch with the TTY validation ADR-0016 asked for.
- *Reduce render frequency / drop the clock cadence.* Rejected: the defect is
  event-loop **starvation**, not render cost. A slower clock stutters just as
  badly; it only makes the freeze coarser.
- *`worker_threads` instead of `child_process.fork`.* Rejected during Phase 1
  (build-time pivot). A worker thread cannot reconstruct the run scope: the
  language-adapter registry, resolved `Rule[]`, and recipe selection are built by
  the **CLI bootstrap** and contain **functions** that cannot cross the thread
  boundary via `structuredClone`. The graph engine deliberately hides
  `runGraph`/`executeGraph` behind a curated barrel + restricted `exports`, so the
  worker has to re-run the *same* bootstrap a normal CLI invocation does — which a
  forked subcommand does for free (it *is* a normal CLI invocation), but a thread
  does not.
- *Keep everything in-process (do nothing).* Rejected: the stutter is the reported
  symptom; the cooperative-yielding interim (Phase 0) reduced but did not remove it.

**Rationale:** A forked worker subcommand re-enters the identical CLI bootstrap, so
the engine runs under the **same** resolved scope, config, and rules as a normal
run — there is no second bootstrap to drift, which was ADR-0016's central objection
to a subprocess. The result that crosses IPC is deliberately **slim and plain
data**: fit/sim return their `SignalEnvelope`; graph returns `LiveGraphOutput`
(`{ signals, reportLines }`) built by the worker via `buildLiveGraphOutput`,
because a raw `RunGraphResult` carries class-method accumulators + Maps that cannot
be structured-cloned. The worker — not the parent — assembles the report lines and
holds the ~13k-function catalog, so the catalog never enters the render process
(the heap byproduct ADR-0016 noted, now realized rather than speculative). The
`ProgressTransport` seam was already in place from ADR-0016; this ADR only swaps
the transport implementation behind it, exactly as that ADR anticipated.

**Consequences:**

- **Engine entries are persistence-free** (Phase 2): `executeFit`/`executeSim` no
  longer take a datastore or persist; the live runners persist explicitly on the
  main process after the run, from the returned envelope. The datastore handle
  never crosses the fork boundary.
- New per-tool worker subcommands `fit-run-worker` / `sim-run-worker` /
  `graph-run-worker` — `[internal]`, absent from completion, declared in each
  tool's manifest `opensipTools.commands` (manifest↔runtime parity, ADR-0027) and
  in the tool's `commands[]` + `commandSpecs[]`.
- New core seams: `runOffThreadOrInProcess` + `createSubprocessProgressRun`
  (`runtime/subprocess-transport.ts`), forking with `serialization: 'advanced'`,
  relaying `WorkerMessage` progress/result/error, settling once, and killing the
  child. A governed `OPENSIP_CLI_NO_WORKER` env var (via `EnvRegistry`) selects
  the in-process fallback.
- `--json` / non-TTY output is unchanged and stays in-process — only the live TTY
  path forks.
- The in-process fallback path reduces to the **same** result shape the worker
  returns, so TTY ≡ pipe ≡ fallback on output.
- ADR-0058's `live-view-through-cli-live` check forbids ink `render` imports in
  tool engines (the live-view shell constraint). The off-thread selector
  (`runOffThreadOrInProcess`) is live but no longer guarded by a fitness check —
  restoring that assertion is an open follow-up (spec 01 / OQ4).

**Related specs / ADRs:** `docs/plans/ready/offload-engine-to-worker-thread/`
(local). Exercises the reversibility ADR-0016 reserved; the progress currency +
single `<LiveProgress>` renderer from ADR-0016 are unchanged. Slim results follow
ADR-0011's `SignalEnvelope` output currency.
