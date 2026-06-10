---
status: superseded
last_verified: 2026-06-09
owner: opensip-tools
---

# ADR-0031: Graph determinism — one build, one finalize, many renderers

> **Superseded by [ADR-0032](./ADR-0032-sharded-engine-default.md).** ADR-0032 flips
> the **default engine** to sharded (now proven byte-equivalent to exact by the
> repo-scale equivalence guardrail) and replaces `--sharded` with `--exact`. Every
> other invariant in this ADR — the single `finalizeGraphSignals` suppression seam,
> the branded `FinalizedSignals` type, `isTTY` selecting only the renderer, and the
> `mode=exact|sharded` cache stamping — is retained unchanged.

```yaml
id: ADR-0031
title: Graph determinism — one build, one finalize, many renderers
date: 2026-06-09
status: superseded
supersedes: []
superseded_by: ADR-0032
related: [ADR-0014, ADR-0028]   # @graph-ignore suppression primitive; off-main-thread live-view worker
tags: [graph, cli, cache, suppression, determinism]
enforcement: mechanizable
enforcement-reason: >
  Suppression-parity is held at COMPILE TIME: `finalizeGraphSignals` is the only
  producer of the branded `FinalizedSignals` type, and `persistSession` (the shared
  persistence call every path uses) accepts only that type — a path that hands raw
  `Signal[]` to persist/verdict/render fails to typecheck. Backed by
  `live-suppression-parity.test.ts` (incl. a `@ts-expect-error` guard). Engine
  determinism is pinned by `graph-execute.test.ts` (exact is the default; `--sharded`
  is the only way to shard; TTY does not affect engine choice) and the cache-mode
  collision test in `engine-version.test.ts` (`mode=exact` vs `mode=sharded` keys
  never clobber).
```

**Decision:** A `graph` run is **one build → one finalize → many renderers**. (1)
Suppression (`@graph-ignore`) is applied in exactly one seam — `finalizeGraphSignals`
— that every signal-producing path must cross before any signal is persisted,
verdict-computed, or rendered; this is enforced by a branded `FinalizedSignals`
type. (2) The build **engine** is chosen by an explicit, deterministic policy with
the **exact single-program engine as the default**; the **sharded** engine is
opt-in via `--sharded`. (3) `process.stdout.isTTY` selects only the **renderer**
(Ink live view vs plain/JSON text) — never the engine. (4) The persisted catalog
cache key carries the engine mode (`mode=exact|sharded`) so the two engines never
overwrite each other's catalog.

**Alternatives:**
- *Apply suppression in each path (the status quo / prior patches).* Rejected: this
  is exactly how the bug kept recurring — each fix patched the path it could see
  (e.g. ADR-0014's path-resolution fix lived only inside `executeGraph`), while the
  interactive live-view path silently bypassed suppression and leaked every waiver
  as a false warning. Multiple code paths × no shared seam = perpetual regression.
- *Keep auto-sharding, default-on.* Rejected: sharded and single-program produce
  materially different catalogs (~2,400–2,700 functions apart; semantic vs syntactic
  cross-package edges), so a finding's existence depended on partition layout. With
  auto-sharding keyed off TTY/discovery, the same command gave different results in a
  terminal vs CI.
- *Let TTY pick the engine (status quo).* Rejected: coupling "how we draw progress"
  to "what we build" is the root non-determinism — a developer's terminal and CI ran
  different engines.
- *Reconcile sharded≡exact now.* Deferred: closing the cross-shard semantic-edge gap
  is a large, separate effort; making exact the default removes the correctness risk
  immediately, so reconciliation is a perf follow-up, not a blocker.

**Rationale:** The recurring "graph shows findings that aren't real" reports were two
compounding defects: (a) the interactive path never ran suppression, so waived
findings leaked only in a terminal — invisible to piped/CI investigation, which is
why it kept being mis-diagnosed; and (b) engine choice was ambient (TTY + on-disk
discovery), so results were non-deterministic across invocations. A single typed
finalize seam makes (a) structurally impossible to reopen, and a deterministic,
exact-by-default engine policy makes (b) impossible. Quality-over-speed: the default
must be the accurate engine; speed (sharding) is an explicit, opt-in trade.

**Consequences:**
- A bare `graph` always uses the exact engine and yields identical findings whether
  run in a terminal or piped — including the CI `graph --gate-save` step, which now
  matches a local `pnpm graph`. Cold CI graph builds are slower than the old
  auto-sharded path (the accuracy/determinism trade); `--sharded` is available where
  speed is wanted and approximation is acceptable.
- Any NEW signal-producing path must route through `finalizeGraphSignals` (it will
  not typecheck otherwise) — this is the guardrail that keeps suppression universal.
- The sharded engine remains an approximation (~2,400–2,700-function divergence).
  Reconciling sharded≡exact is a tracked perf follow-up; until then `--sharded`
  output should not be treated as authoritative for gating production code.

**Related specs / ADRs:** Implements the fix tracked in
`docs/plans/graph-false-findings-incident-log.md` (local). Builds on ADR-0014
(the shared `@graph-ignore` suppression primitive) and ADR-0028 (the off-main-thread
live-view worker, one of the producers now routed through the finalize seam).
