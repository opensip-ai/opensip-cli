# Tool-plugin parity — completion-invariant index

GA (3.0.0) is not "the building blocks exist" — it is **the acceptance test passes
and all nine completion invariants are live guardrails** (north-star §8). This is
the index that makes "GA done" mechanically checkable: each §8 invariant maps to
the enforcement that holds it, and a CI test
(`packages/cli/src/__tests__/parity-invariants.test.ts`) asserts every named check
slug resolves to a registered check — so deleting or renaming a guardrail without
updating this index fails CI.

The nine invariants are enforced by a **fitness check** (a live dogfood gate at 0
findings) and/or a **test** that pins the behaviour. The run-currency invariant is
deliberately enforced by composition rather than a dedicated check — see its row.

| # | §8 invariant | Enforcing check(s) | Pinning test(s) |
|---|--------------|--------------------|-----------------|
| 1 | **Install-source independence** — a first-party tool loads through the plugin path with identical behaviour; provenance changes only whether the host admits it (§5.2.1). | `no-bootstrap-tool-import` (checks-typescript) — the host holds no static tool-runtime import | `fit-external-load.test.ts` (the acceptance test) · `sim-external-load.test.ts` · `graph-external-load.test.ts` |
| 2 | **One command surface** — every command is a typed `CommandSpec` or a documented host-command exception. | `command-surface-parity` (checks-universal) | `tool-command-plane.test.ts` |
| 3 | **One outcome shape** — every outcome + error (incl. bootstrap) is a `CommandOutcome`. | `one-outcome-shape` (checks-universal) | `envelope-routing.test.ts` |
| 4 | **One run currency** — every run-producing tool emits a `SignalEnvelope` wrapped by a stable outer outcome. | `one-outcome-shape` + `no-direct-stdout-in-tool-engine` (checks-universal) — *composed, no dedicated check: a stand-alone `run-emits-signal-envelope` would only restate what these two + the acceptance tests already lock; adding it would be a redundant guardrail.* | `fit-external-load.test.ts` (`fit --json` is a `CommandOutcome`-wrapped `SignalEnvelope`) · `envelope-routing.test.ts` |
| 5 | **Input compatibility** — every plugin declares `apiVersion`; incompatible inputs fail closed; bundled + external share one gate. | `tool-has-manifest` (checks-universal) | `compatibility.test.ts` · `as-if-external.test.ts` (grace window closed → fail-closed/skip) |
| 6 | **One config document** — every config block validates through one composed schema. | `one-config-document` (checks-universal) | — |
| 7 | **Same semantics** — every recipe/execution field behaves identically across domains, or an ADR documents the difference. | `same-recipe-semantics` (checks-universal) | ADR-0026 (graph selection-only) |
| 8 | **Scope isolation** — two concurrent runs of a tool share no mutable registry state. | `no-module-singleton` (checks-universal) | — |
| 9 | **Capability by declaration** — a tool's plugin domains are discovered from its manifest, not hardcoded host knowledge. | `capability-by-manifest` (checks-universal) | — |

## How this index is enforced

- **Every check slug above is asserted to resolve** to a registered check in
  `parity-invariants.test.ts`. The dogfood gate (`fit --gate-save`, run in CI)
  independently asserts each is at **0 findings** — so the guardrails are not just
  present, they are *green*.
- **The acceptance test** (`fit-external-load.test.ts`) is the §1 bar: `fit`
  loaded through the plugin path has a command surface identical to the bundled
  mount. It is the executable form of invariant 1.
- Adding a tenth invariant, or moving a check between packs, means updating this
  table **and** the assertion test in the same change — that is the point of the
  index: the set's completeness is itself CI-checked (the §8 "guarded
  conventions" invariant, applied to the guardrails themselves).

## ADR-0035 — host-owned verdict invariants

Distinct from the nine tool-plugin-parity invariants above: ADR-0035 makes the
pass/fail verdict a single host-owned value (`envelope.verdict.passed`) computed
from a tool-declared findings policy. Its `enforcement: mechanizable` clause maps
to these pinning tests.

| Invariant | Pinning test(s) |
| --- | --- |
| **One verdict drives the findings exit** — the process exit is a pure function of `envelope.verdict.passed`; the host (`deliver-envelope.ts`) is the only writer of the findings exit, and `CommandResult.shouldFail` no longer exists. | `exit-parity.test.ts` (behavioural matrix for fit/sim/graph + the gate-compare override; structural guard that `shouldFail` is gone and no non-host file sets the findings RUNTIME_ERROR) |
| **Verdict = policy over counts + faults** — `verdict.passed = !runFaulted && !unitErrored && policyPasses(errors, warnings, policy)`; the reserved `failOnErrors`/`failOnWarnings` keys resolve per-tool with a `{1,0}` host fallback. | `core/lib/__tests__/verdict-policy.test.ts` · `contracts/verdict-envelope.test.ts` |
| **Sim failures are in the currency** — a failed sim scenario emits ≥1 error-severity signal (ADR-0011), so the policy verdict sees it (the Phase 0 precondition that makes sim's exit byte-equal its old `failed > 0`). | `simulation/__tests__/sim-failure-signal.test.ts` |
