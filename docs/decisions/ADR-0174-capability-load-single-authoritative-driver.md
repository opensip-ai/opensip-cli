---
status: active
last_verified: 2026-07-20
owner: opensip-cli
---

# ADR-0174: One authoritative capability-load driver; worker-side diagnostics fold back to the host

```yaml
id: ADR-0174
title: One authoritative capability-load driver; worker-side diagnostics fold back to the host
date: 2026-07-20
status: active
supersedes: []
superseded_by: null
related: [ADR-0054, ADR-0058, ADR-0103, ADR-0128, ADR-0138, ADR-0169]
tags: [capability, dispatch, observability, fitness, correctness]
enforcement: mechanizable
enforced-by: ['script:fit-acceptance-e2e', 'script:diagnostics-bus.test']
enforcement-reason: >
  The bundled≡installed check-surface parity is proven end-to-end through the
  real binary by fit-acceptance-e2e.test.ts (§1/§8); the worker→host diagnostics
  fold is unit-proven by diagnostics-bus.test.ts (ingest) and exercised through
  the dispatch e2e. A future dedicated dogfood check on "no second capability
  loader keyed off opts.cwd" would strengthen this, tracked as NONE-YET below.
```

**Decision:** A tool's capability domains (e.g. fitness's `fit-pack`) are loaded
by exactly one authoritative driver — the host's `loadOwningToolCapabilities`,
keyed on the canonical `scope.projectContext.projectRoot`. It runs in-process for
a bundled tool and **worker-side for a dispatched (external) tool** (the worker
drives it for the resolved dispatched tool, since the worker bootstraps the
owner-less `__tool-command-worker` host subcommand). A tool's own lazy loader
(fitness `ensureChecksLoaded`) keys on the same canonical root, so it observes the
domain already loaded and no-ops instead of re-resolving under a divergent anchor.
Separately, a dispatched worker's diagnostics snapshot folds back into the host
diagnostics bus (`DiagnosticsBus.ingest`) so the whole run — not just the host
half — is visible in `--json`.

**Alternatives:**

- *Leave the engine's lazy loader as a second resolver (status quo).* Rejected:
  the host driver seeded the bundled pack list from `packages/cli` while the
  engine fallback auto-discovered from the fitness install dir under a different
  memo key (`opts.cwd` vs absolute root). The two resolved **different** pack sets
  — the in-process surface carried the bundled `checks-dogfood` pack (141 checks);
  the dispatched surface did not (128). Byte-divergent output for the same tool by
  provenance alone violates the ADR-0054 "provenance changes only HOW a tool is
  admitted, never WHAT it does" invariant.
- *Publish the resolved `(cliDir, preferences)` on the scope for the engine to
  consume.* Rejected as the primary fix: it keeps two loaders and a second code
  path to keep in sync; making the host driver the single loader deletes the
  divergence by construction rather than by keeping two resolvers agreeing.
- *Forward the worker's raw stderr to the host for observability.* Rejected: the
  worker context shim intercepts `process.stderr` for tool code (correct — the
  documented-seams rule), and `logger.warn` is suppressed under `--json` for
  stdout purity. A structured diagnostics fold is the seam that survives both.

**Rationale:** The divergence resisted a dozen rounds of file-level probing
precisely because the system had no channel to report what a dispatched worker's
capability load did — `logger.warn` is dropped under `--json`, worker stderr is
shim-intercepted, and the worker's diagnostics bus died with the worker process.
The observability fix (folding the worker snapshot into the host bus, and stamping
each capability-domain load event with its resolving anchor + routed pack names)
made the divergence name itself: `[worker] fit-pack loaded 154` vs `[host]
fit-pack loaded 167 from 8 pack(s)`. With the cause visible, the single-driver fix
is small and verifiable — and the fit-acceptance e2e (bundled≡installed through the
real binary) passes. This follows the ADR-0169 posture: a "flake" that reproduces
deterministically is a bug report, and fail-open silence is the defect to remove.

**Consequences:**

- The worker's `runLoadedCommand` drives `loadOwningToolCapabilities` for the
  dispatched tool after `runWorkerInitialize` and before the handler. A tool that
  declares capability domains now has them loaded once, host-seeded, on both the
  in-process and dispatched paths.
- `ToolCommandResult` carries an optional `diagnostics: RunDiagnostics`; the
  dispatch supervisor ingests it into the host bus during `replayResult` before
  the outcome is assembled, so worker-origin events reach `--json` diagnostics
  (tagged `data.origin: 'worker'`; worker metrics namespaced under `worker.*`).
- `DiagnosticsBus` gains `ingest(snapshot, origin?)` — the one seam for folding a
  child run's events + metrics into a parent bus. Reusable for other subprocess
  planes (graph shards) that today drop their child diagnostics.
- The capability-domain `loaded` event now reports `packageCount`, `packages`,
  and the resolving `anchor`, so any future two-path divergence is diagnosable
  from `--json` alone rather than by bisection.
- Not-yet-mechanized guard (NONE-YET): a dogfood check forbidding a second
  capability loader keyed on `opts.cwd` (rather than the canonical project root)
  would prevent regressing to two resolvers. Tracked, not built.

**Related ADRs:** ADR-0054 (out-of-process dispatch plane; this extends its M4-F
worker-side lifecycle contract to capability loading), ADR-0138 (engine-triggered
capability loads apply the host trust gate), ADR-0128 (capability resource
decisions), ADR-0103 (single-core scope-ABI guard — the dual physical core copies
that made local diagnosis hard), ADR-0058 (live-view/runtime seams), ADR-0169
(no-flaky-tests: a deterministic "flake" is a bug).
