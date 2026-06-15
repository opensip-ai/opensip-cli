---
status: active
last_verified: 2026-06-11
owner: opensip-cli
---

# ADR-0035: Pass/fail is a host-owned verdict computed from a tool-declared findings policy

```yaml
id: ADR-0035
title: Pass/fail is a host-owned verdict computed from a tool-declared findings policy
date: 2026-06-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0023, ADR-0027]
tags: [output, contracts, parity, verdict, exit-codes]
enforcement: mechanizable
enforcement-reason: >
  A parity test asserts, for every registered tool, that the process exit code is
  a pure function of `envelope.verdict.passed` (no tool calls `setExitCode`
  itself), and that sim emits ≥1 error-severity signal whenever a scenario fails
  (the currency precondition below). Both belong in the implementing spec's
  per-tool verification matrix and join the §8 completion-invariant index.
```

**Decision:** A run's pass/fail is **one** value — `envelope.verdict.passed` —
computed by the host (`buildSignalEnvelope`) from the run's error/warning counts
against a **tool-declared findings policy** expressed as two reserved config
keys, `failOnErrors` / `failOnWarnings` (host fallback `{failOnErrors: 1,
failOnWarnings: 0}` when a tool declares neither). That single verdict drives
**both** the process exit code and the terminal headline; the per-tool
`shouldFail` fields and the hardcoded `verdict.passed = errors === 0` are retired.
The shared headline changes to `{PASS|FAIL}  (E Errors, W Warnings) | Duration`.
A new tool plugin inherits the headline, exit-code wiring, and verdict for free —
it only emits signals and (optionally) tunes the two thresholds.

**Alternatives:**

- **Dedicated `verdict` slot on the `Tool` contract** (a predicate/threshold pair
  as a first-class contract member). Rejected: thresholds are *user-facing config*
  with an existing resolution pipeline (flag > env > file > defaults, ADR-0023); a
  new slot would duplicate that pipeline. "Tool declares its policy" already *is*
  `defaults: { failOnErrors, failOnWarnings }` in its `ToolConfigDeclaration`.
- **Ship a functional predicate escape hatch now** (`(counts) => boolean`).
  Deferred, not rejected forever: a function cannot live in serializable config
  (it would force the dedicated slot above), and **no current tool needs it once
  sim emits signals** — the threshold model is exactly sufficient for all three.
  Revisit trigger: *a tool whose verdict is not expressible over severity counts*
  (e.g. "fail if score < 0.8", or per-severity tiers below the error/warning
  collapse). At that point add the slot for that tool only; the config convention
  stays the default path.
- **Keep the status quo** (hardcoded `verdict.passed = errors === 0` for display +
  per-tool `shouldFail` for exit). Rejected: it is the documented latent
  divergence this ADR closes (see Rationale).
- **Keep the count-based headline** (`{P} Passed, {F} Failed (...)`). Rejected: it
  does not answer "did this run pass?", and for graph it renders `0 Passed, 0
  Failed` on a healthy run (graph emits a unit only per *fired* rule).

**Rationale:**

The system carries **two definitions of "passed" that already disagree**, plus a
third inside sim:

1. `buildSignalEnvelope` hardcodes `verdict.passed = errors === 0`
   (`contracts/src/signal-envelope.ts`, `buildSignalEnvelope`) — drives display
   tone, the persisted session row, and the `--json`/SARIF/cloud verdict.
2. fit's `shouldFail` drives the **exit code**:
   `pluginLoadErrors > 0 || (failOnErrors > 0 && totalErrors >= failOnErrors) ||
   (failOnWarnings > 0 && totalWarnings >= failOnWarnings)`
   (`fitness/engine/src/cli/fit/result-builders.ts:146-149`), resolved off
   `scope.toolConfig.fitness` with `OPENSIP_FIT_FAIL_ON_*` env bindings; defaults
   `{1, 0}`. The code itself flags the split: result-builders.ts:114 — *"`shouldFail`
   (the exit-code driver) is NOT `envelope.verdict.passed`."*

   Concrete bug: a fit warn-only run (`failOnErrors: 0`) **exits 0 while the
   envelope and the persisted session row say `passed: false`** — CI green,
   dashboard/JSON/cloud red. Unifying on a single policy-driven verdict closes this.

3. **sim has a third predicate and an ADR-0011 currency violation.** A failed
   scenario flips `scenario.passed` and records the assertion but **emits no
   signal** — neither the load nor chaos executor calls the builder's
   `addSignal`/`addSignals` (`simulation/engine/src/framework/result-builder.ts`).
   sim's exit is `shouldFail = failed > 0` (`cli/sim.ts:318`), and its unit verdict
   is a *third* rule: `scenario.passed && !hasErrorSignal` (`cli/sim.ts:147`). So
   `failed > 0 ≢ errors > 0`: a sim run with failed assertions exits non-zero today
   but has `errors === 0`. A pure threshold model would therefore **flip a failing
   sim run to PASS / exit 0** — unless sim first emits an error-severity signal per
   failed scenario. That fix is the right *root cause* independent of this ADR: per
   ADR-0011 signals are the single output currency, and sim's failures are
   currently invisible to every sink (`--json`, SARIF, cloud). Once a failed
   scenario emits an error signal, all three sim predicates collapse into the one
   host verdict.

With sim's currency fixed, the threshold model **exactly reproduces** today's exit
behavior for the findings path: fit = thresholds verbatim; graph gate-save =
`errorCount = signals.filter(isErrorSignal).length` → `{failOnErrors: 1}`
(`graph/engine/src/cli/graph-modes.ts:75`); sim = `errors > 0` → `{failOnErrors: 1}`.
This is why the migration is verifiable per-tool rather than a behavioral guess.

The host already owns the seam: graph's *summary* is already shared
(`cli/src/ui/result-to-view.ts:91` routes graph through `viewRunSummary`); only its
*exit logic* is bespoke. Putting the policy in `buildSignalEnvelope` (a pure,
contracts-layer function) keeps the verdict in the one place all sinks read.

**Consequences:**

- **Precondition — sim must emit signals (do first).** A failed scenario must emit
  exactly one error-severity signal (`critical`/`high`) attributed to its
  `scenarioId`. Until then sim must NOT migrate onto the host verdict, or failing
  runs silently pass. This is the gating task in the spec sequence.
- **`buildSignalEnvelope` takes a resolved policy.** It computes `verdict.passed`
  from `(errors, warnings)` against `{failOnErrors, failOnWarnings}` instead of
  `errors === 0`. Stays pure (data in, no IO/clock).
- **Exit code derives from `verdict.passed`** at the host dispatch seam; the
  per-tool `shouldFail` fields (fit, sim) and graph's gate-save `setExitCode`
  collapse into `!verdict.passed`. No tool sets its own exit code for the findings
  path (guarded by the parity test above).
- **Reserved-key convention.** `failOnErrors` / `failOnWarnings` become
  host-recognized reserved keys in *every* tool's config namespace, with host
  fallback `{1, 0}` when a tool declares neither. Generalizes fit's mechanism
  (ADR-0023) to all tools; a plugin author tunes two numbers, end users override
  via the existing flag > env > file pipeline.
- **Execution faults are orthogonal to the findings policy and always FAIL.**
  `UnitResult` already carries `error` (fit maps check throw/timeout into it), so
  the host can compute "any unit faulted" from the envelope. But fit's
  **plugin-load errors occur before any unit exists** — so the envelope needs a
  run-level faults field, or pre-run faults stay a tool-fed input to the verdict.
  *Open question the spec must close;* named here so it is not lost. The policy
  governs *findings* only — a crash is never "0 errors found."
- **graph gate-compare is a distinct, baseline-diff predicate.** Its `degraded` /
  `newSignals.length` (`graph-modes.ts:91-96`) is "net-new findings since baseline",
  not a count over the current run's signals. The spec's verification matrix must
  confirm whether it is expressible over the envelope's residual signals or remains
  a tool-specific gate predicate *alongside* the findings policy. No equivalence is
  asserted here.
- **Headline change is intentional, and parity-gated separately from exit
  semantics.** Today's shared format is `{P} Passed, {F} Failed ({E} Errors, {W}
  Warnings) | Duration` (`cli-ui/src/run-summary.tsx`) — no PASS/FAIL token exists.
  The ADR splits the claim: *exit-code semantics = behavior-preserving and verified
  per tool*; *headline format = deliberate change*. Acceptance/packed-smoke scripts
  likely assert on the current string and must be updated in the same change.
- **The per-unit table is unchanged.** The old per-unit passed/failed *counts* live
  in the table below the summary (one row per check/rule/scenario with its own
  PASS/FAIL/ERROR), not in the headline.

**Related specs / ADRs:** Implements onto ADR-0011 (Signal is the universal output
currency — this ADR makes the verdict a first-class part of that currency and
fixes sim's violation of it), ADR-0023 (tool config consolidation — supplies the
config resolution pipeline the reserved keys reuse), ADR-0027 (tool-plugin parity
GA — "host owns the plane, tool declares a manifest"; the verdict plane is one more
host-owned plane a plugin inherits). The implementing spec
(`docs/plans/specs/host-owned-verdict.md`, local-only) carries the per-tool
verification matrix: fit (exact), graph gate-save (exact), graph gate-compare
(verify `degraded` expressibility), sim (exact *after* the signal-emission fix).
