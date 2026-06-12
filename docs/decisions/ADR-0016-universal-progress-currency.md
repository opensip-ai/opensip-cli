---
status: active
last_verified: 2026-06-05
owner: opensip-cli
---

# ADR-0016: Universal progress currency + one live-progress renderer

```yaml
id: ADR-0016
title: Universal progress currency + one live-progress renderer
date: 2026-06-05
status: active
supersedes: []
superseded_by: null
related: [ADR-0011]
tags: [cli, ux, graph, simulation, fitness, architecture]
enforcement: not-mechanizable
enforcement-reason: >
  That every tool renders its live run through the shared <LiveProgress> (and no
  tool reintroduces a bespoke progress component) is a code-review invariant —
  the grep `StageChecklist|RunningStageLine` must stay empty outside cli-ui, and
  there are only three live-view renderers (fit/graph/sim). The renderer's two
  modes and the in-process transport's pre-subscribe buffering are covered by
  unit tests in cli-ui and core.
```

**Decision:** All three tools (`fit`, `graph`, `sim`) render their live run
through **one** shared currency + renderer + transport seam — the run-time
analogue of ADR-0011's `SignalEnvelope` *output* currency:

1. **`ProgressEvent` / `ProgressSurface` vocabulary lives in
   `@opensip-cli/cli-ui`** (not `contracts`). One event union
   (`stage-start | stage-progress | stage-done | stage-cached`) covers both tool
   shapes; a tool-declared `shape: 'phases' | 'pool'` picks the rendering.
2. **One `<LiveProgress>` renderer (cli-ui), two modes:** `phases` → a checklist
   (graph's 7 fixed pipeline stages); `pool` → a spinner + `completed/total`
   counter (fit's checks, sim's scenarios — many, dynamic, possibly concurrent).
   The graph-local `StageChecklist`/`StageLine`/`RunningStageLine` are deleted;
   fit's inline `Spinner` wiring is replaced.
3. **`ProgressTransport<TEvent,TResult>` seam in `@opensip-cli/core`**, generic
   over the event type so the kernel names no concrete progress type. Transport
   is **per-tool**: fit + sim use the in-process transport (both already yield to
   the event loop); graph stays in-process too and animates via **cooperative
   yielding** in its heavy `resolve` stage.

**Alternatives:**

- *`ProgressEvent` in `@opensip-cli/contracts` (symmetry with `SignalEnvelope`).*
  Rejected: progress is renderer-bound and ephemeral — never persisted or egressed
  the way a `SignalEnvelope` is. Putting it in `contracts` forces the pure
  ink/react leaf (`cli-ui`, zero opensip deps) to take a heavy `contracts`
  dependency, and forces `core`'s transport to name a type it sits below (layer
  inversion). The renderer owns its own input vocabulary. This is *why* the
  progress currency and the output currency live in different packages.
- *Subprocess (`child_process.fork`) transport for graph* (the original spec's
  plan, to gain process isolation + keep the huge catalog out of the render
  process). Rejected after a de-risk spike: the child would have to **re-derive
  the full engine bootstrap** (adapter discovery, config resolution, rule/recipe
  resolution, scope construction) because the parent's resolved `Rule[]` and
  language adapters contain **functions** that cannot cross an IPC boundary, and
  the engine deliberately hides `runGraph`/`executeGraph` behind a curated barrel
  + restricted `exports`. Any drift in that second bootstrap makes interactive
  `graph` disagree with `graph --json`/CI — a silent divergence on the path that
  is hardest to test. It also assumes a **re-forkable CLI binary**, which does
  not exist in embedded/SaaS mode, breaking the platform's host-agnostic design
  (a Tool's renderer must not assume it was launched as a standalone CLI).
- *`worker_threads` transport for graph.* Rejected: tempts a `structuredClone` of
  the ~13k-function / ~73k-call-site catalog across the thread boundary — the
  exact cost the subprocess was meant to avoid — plus native/WASM worker caveats.
- *Unify the execution strategy across tools.* Rejected: fit and sim already yield
  and animate in-process; forcing them through a subprocess adds latency for zero
  benefit. The shared piece is the event vocabulary + renderer + transport seam,
  never the decision of where a tool's work runs.
- *Cosmetic self-ticking spinner on graph.* Rejected as dishonest: a spinner that
  animates while the event loop is blocked simulates progress that isn't real.

**Rationale:** The only required outcome was that graph's spinner *animate* — the
event loop must stop being starved for the duration of the long `resolve` stage.
Process isolation / catalog-out-of-render-memory were the subprocess's byproducts,
not the goal, and are speculative today (graph's `PressureMonitor` already bails
before OOM; the in-process path holds the catalog fine; no hosted-graph service
exists). Cooperative yielding delivers the goal directly: the `resolve` loop
(graph-typescript `resolveEdgesFromRecords` / `resolveEdgesSyntactic`) yields to
the event loop every 250 call sites, so the in-process 80 ms `ClockProvider` ticks
and the spinner animates while stages reveal progressively. It is **zero
divergence** (same process, same scope, the identical `runGraph` — only timing
changes), **fully testable**, **host-agnostic** (works embedded), and a tiny
production surface. Crucially, the `ProgressTransport` seam stays in place: if a
future heavy tool (`audit`, `bench`) or a hosted graph service ever genuinely
needs process isolation, graph's transport can be swapped to a subprocess *then*,
behind the same stable boundary, with proper TTY validation — the architecture is
already reversible at that seam, so isolation is not paid for speculatively now.

**Consequences:**

- New: `cli-ui` `progress-event.ts` (`ProgressEvent`/`ProgressSurface`/
  `ProgressCallback`) + `live-progress.tsx` (`<LiveProgress>` + `useProgressState`);
  `core` `runtime/progress-transport.ts` (interface) + `runtime/in-process-transport.ts`
  (buffers pre-subscribe events so a fast job can't race the renderer's mount).
- `sim` gains a live view for the first time (`renderSimLive`), closing part of its
  `[experimental]` gap; it had been static-envelope-table only.
- The adapter contract's `resolveCallSites` is widened to
  `ResolveOutput | Promise<ResolveOutput>` so an adapter MAY run resolve
  cooperatively. The TypeScript adapter does; the four tree-sitter adapters stay
  synchronous (declared with `satisfies GraphLanguageAdapter` so their object
  types keep the concrete sync return). The orchestrator always `await`s, so sync
  adapters are unaffected.
- `runStage` / `spanRunStage` / `obtainCatalog` /
  `buildAndResolveCatalog[Incremental]` / `executeShardWorker` are now async
  (`withSpanAsync` keeps each per-stage span open across the awaited work).
- `contracts` is untouched (progress is not an output-currency concern).
- A new tool inherits the live surface by emitting `ProgressEvent`s and declaring
  a shape — no bespoke renderer.

**Merge note:** This work was branched before ADR-0015 (engine-version cache
invalidation) landed. ADR-0015 added `stampEngineVersion` to `catalog-builder.ts`,
`cache-orchestrator.ts`, and `shard-runner.ts` — files this ADR also async-ifies.
Rebasing onto current main must reconcile both (the stamp and the async are
orthogonal; they coexist).

**Related specs / ADRs:** `docs/plans/specs/universal-progress-currency.md`
(local). Symmetric to ADR-0011 (signal output currency).
