---
status: current
last_verified: 2026-06-07
release: v3.0.0
title: "Output, gate, SARIF"
audience: [contributors, ci-integrators]
purpose: "What happens to the signals a check produces — formatter/sink routing, JSON output, SARIF, the gate, cloud reporting."
source-files:
  - packages/contracts/src/signal-envelope.ts
  - packages/output/src/format/signal-sarif.ts
  - packages/fitness/engine/src/gate.ts
  - packages/fitness/engine/src/cli/fit-modes.ts
  - packages/cli/src/bootstrap/deliver-envelope.ts
  - packages/cli/src/ui/
related-docs:
  - ./01-recipes-and-checks.md
  - ./03-ignore-directives.md
  - ../10-concepts/05-architecture-gate.md
  - ../70-reference/04-json-output-schema.md
---
# Output, gate, SARIF

A check produced signals. Now what?

This doc walks the output side of the fit loop: how a run becomes a `SignalEnvelope`, how the composition root routes that envelope through a formatter × sink, how `--gate-save`/`--gate-compare` compare against a stored baseline, and how `--report-to` ships the same data to OpenSIP Cloud.

> **What you'll understand after this:**
> - The four output paths a fit run can take.
> - The shape of the `SignalEnvelope` and where it's defined.
> - Why tools no longer render their own output (ADR-0011): the formatter × sink split.
> - How the gate's identity hash works (and why line numbers are deliberately excluded).

---

## The four output paths

A fit run takes exactly one of these paths:

```
                 ┌─ default      → Ink table on stdout, exit code from result
                 │
fit run ─ Cli    ├─ --json       → CommandOutcome JSON on stdout (envelope under
                 │                  .envelope), exit code from result
                 │
                 ├─ --gate-save  → envelope stored as baseline (SQLite), exit code 0
                 │  / --gate-    → current envelope compared to baseline, exit = degraded?
                 │  compare
                 │
                 └─ --report-to  → envelope → SARIF, POSTed to URL, exit code from result
```

The paths are mutually exclusive in their effect on stdout, but composable in their effect on the cloud / baseline. You can run `fit --json --report-to https://opensip.ai/api` and get JSON locally *and* a cloud upload. You cannot run `fit --json --gate-compare` and get JSON output — gate mode owns stdout.

---

## The `SignalEnvelope`

Every output path starts from the same shape — a `SignalEnvelope` produced after the recipe runs ([ADR-0011](../../decisions/ADR-0011-signal-output-currency-formatter-sink.md)). Defined at [`packages/contracts/src/signal-envelope.ts`](../../../packages/contracts/src/signal-envelope.ts):

```ts
interface SignalEnvelope {
  readonly schemaVersion: 2;
  readonly tool: 'fit' | 'sim' | 'graph';
  readonly recipe?: string;
  readonly runId: string;
  readonly createdAt: string;            // ISO 8601
  readonly verdict: {
    readonly score: number;              // 0..100, deterministic
    readonly passed: boolean;            // true iff no critical/high signals
    readonly summary: {
      total: number; passed: number; failed: number;
      errors: number; warnings: number;
    };
  };
  readonly units: readonly UnitResult[]; // per-unit ran/errored/timing facts
  readonly signals: readonly Signal[];   // the flat findings list
  readonly resolutionMode?: 'exact' | 'fast'; // graph-only
}
```

The full `UnitResult` and `Signal` field tables are in [`70-reference/04-json-output-schema.md`](../70-reference/04-json-output-schema.md) (which also carries the **v1 `CliOutput` → v2 `SignalEnvelope` mapping**). The short version: a `Signal` carries 4-level severity (`critical|high|medium|low`), a `category`, a `provider`, a `fingerprint`, and a fix hint — strictly richer than the old `FindingOutput`.

`SignalEnvelope` is the canonical artifact and the single output currency of every tool. **Tools no longer render their own output**: a tool's action returns the envelope via `CommandResult`, and the CLI composition root maps flags (`--json`, `--report-to`, gate modes) to a (formatter × sink) pair. Output decomposes along two axes:

- **Formatters** — pure `(envelope) => string`, shared across all tools, one per format (`formatSignalJson`, `formatSignalSarif`, the human/table formatter). They live in [`packages/output/src/format/`](../../../packages/output/src/format/) (the package was renamed from `@opensip-tools/reporting` to `@opensip-tools/output`).
- **Sinks** — effectful delivery (stdout, file, chunked HTTPS to OpenSIP Cloud, SQLite), deliberately heterogeneous and resolved only at the composition root.

If you're writing a CI integration, parse the `SignalEnvelope`. The shape is part of the contract surface ([`10-concepts/04-contract-surfaces.md`](../10-concepts/04-contract-surfaces.md)).

---

## Path 1: the default Ink renderer

The default invocation (`opensip-tools fit`) launches a live Ink view: a spinner while the run executes, a results table when it finishes, a summary footer.

The transition path:

```
fitnessTool.action()
  → cli.renderLive('fit', args)            ← CLI's Ink dispatcher
       → mounts <FitApp args={args} />
            → calls executeFit(args) under the hood
            → streams progress events to the spinner
            → on completion, swaps to <FitResultsTable />
       → unmounts when the user closes (or process exits)
```

The renderer is in [`packages/cli/src/ui/`](../../../packages/cli/src/ui/) and depends on Ink + React. It's the only consumer of those libraries; nothing in `core`, `fitness`, or any check pack imports them. This is why a future GUI front-end could replace the renderer without touching a Tool — the Tool calls `cli.renderLive('fit', args)` and the CLI maps that to whatever rendering layer is in place.

`-v` / `--verbose` adds inline finding details to the table. `--quiet` suppresses the banner and shows only the pass/fail summary line.

The exit code is set by the Tool action via `cli.setExitCode(code)`:

- `0` — every check passed.
- `1` — at least one check failed (or `shouldFail` based on `failOnErrors`/`failOnWarnings` config).
- `2` — runtime error before checks could run.

---

## Path 2: `--json`

```bash
opensip-tools fit --json
```

Bypasses the Ink renderer entirely. Calls `executeFit(args)`, then the host wraps the returned envelope in a `CommandOutcome` and serializes the whole outcome through the single `renderOutcome` seam (`cli.emitEnvelope`). The tool never stringifies its own output. The byte-identical `SignalEnvelope` rides under `.envelope`; the outcome adds `kind`, `status`, and `exitCode` at the top level. See [`70-reference/04-json-output-schema.md`](../70-reference/04-json-output-schema.md) for the full wrapper shape.

This is the path CI integrations should use. Stdout is the JSON; stderr carries logs (also JSON-lines, on a separate stream); the exit code is the gate.

```bash
# Capture and pipe to jq (envelope is nested under .envelope):
opensip-tools fit --json | jq '.envelope.verdict.summary'

# Fail CI if score < 90:
opensip-tools fit --json | jq -e '.envelope.verdict.score >= 90' || exit 1

# Fail CI on any critical/high signal:
opensip-tools fit --json | jq -e '.envelope.verdict.passed'
```

The `schemaVersion: 2` discriminator is part of the contract. New optional fields can be added in minors; required fields and the discriminator are major-version changes.

---

## Path 3: the architecture gate

```bash
opensip-tools fit --gate-save                     # capture today's reality
opensip-tools fit --gate-compare                  # CI gate from now on
```

The gate is the regression-detection workflow. `--gate-save` stores the current run's `SignalEnvelope` into the project's SQLite store (`fit_baseline` table at `<project>/opensip-tools/.runtime/datastore.sqlite`). `--gate-compare` runs the same checks, reads the saved envelope back out, computes the diff, and exits 1 if any *new* signal appears. There is exactly one baseline per project.

> **Baseline shape.** Per ADR-0011 the baseline stores the run's `SignalEnvelope` (signals) directly — **not** a SARIF document — mirroring graph's signal-keyed baseline. This removes fitness's `@opensip-tools/output` production dependency: the root owns all SARIF egress. `fit-baseline-export` reads the stored envelope back and writes SARIF to disk via the root `cli.writeSarif` seam, so the on-disk CI artifact stays a SARIF document.

> **v1 → v2 break.** The `--baseline <path>` flag is gone. v1 stored baselines as committed SARIF files; v2 stores them in SQLite. See [`10-concepts/05-architecture-gate.md#ci-integration-patterns`](../10-concepts/05-architecture-gate.md#ci-integration-patterns) for the artifact-based CI workflow that replaces the v1 "committed baseline" pattern.

The full gate behavior — diff classification, line-shift invariance, partial-SARIF tolerance — is documented in [`10-concepts/05-architecture-gate.md`](../10-concepts/05-architecture-gate.md). The short version:

### The identity hash

Two findings are "the same" iff `(filePath, ruleId, message)` matches. The hash:

```ts
sha256(filePath + '\n' + ruleId + '\n' + message)
```

**Line numbers are deliberately excluded.** A regex check that flags `console.log` at line 42 today and the same `console.log` at line 50 next week (because lines were inserted above it) is the *same* violation. Including the line in the hash would produce a false positive: an "added" finding (line 50) and a "resolved" finding (line 42) for what's really one unchanged issue.

The trade-off: if a *different* `console.log` is added at the same file with the same message, the hash collides and we treat it as unchanged. In practice this hasn't been a problem — messages are usually specific enough that two distinct violations have different messages.

### The output

`--gate-compare` prints a structured diff:

```
opensip-tools gate compare

Added (2):
  ✗ no-console-log                          services/api/src/routes/payments.ts:88
      console.log is forbidden in production

Resolved (1):
  ✓ no-todos                                services/api/src/lib/parser.ts

Unchanged (5):
  · ...

✗ DEGRADED — 2 new violations
```

Exit code 1 if `degraded`, 0 otherwise. CI gates on the exit code; humans read the diff.

---

## Path 4: cloud reporting

```bash
opensip-tools fit --report-to https://opensip.ai/api --api-key $OPENSIP_API_KEY
```

The envelope is formatted to SARIF via the single shared `formatSignalSarif` formatter and POSTed to the configured URL through the shared chunked transport. This is a **composition-root** path (ADR-0011): the tool returns its envelope; `cli.deliverSignals` (→ [`deliver-envelope.ts`](../../../packages/cli/src/bootstrap/deliver-envelope.ts)) owns the SARIF formatting *and* the upload. The tool itself never imports `@opensip-tools/output`. This path is composable — `--report-to` runs alongside the default Ink renderer, alongside `--json`, alongside `--gate-compare`. Reporting is a side-channel, not a stdout-replacement.

The transport lives in [`packages/output/src/sink/http-egress.ts`](../../../packages/output/src/sink/http-egress.ts) (`postChunked`). For `--report-to`, the whole SARIF log is sent as one chunk (the envelope is capped upstream):

- It POSTs to `<url>/sarif` with `X-API-Key` if provided, and a stable `Idempotency-Key` per chunk (`<runId>:report:<i>`) so a retried-but-stored chunk is de-duplicated server-side.
- The timeout is `min(300_000, 60_000 + signalCount * 100)` ms — 60s base plus 100ms per signal, capped at 5 minutes. The receiver does per-signal work (dedup, persistence, trace writes); the timeout scales with the workload.
- Retry policy: up to 3 attempts per chunk, honoring `Retry-After` on `429`/`503`, bounded by an overall deadline. `postChunked` **never throws** — it returns a structured `EgressResult`.

The `--report-to` path owns **exit code 4** (`REPORT_FAILED`): an upload failure exits 4, but only when the run otherwise passed — a real check/gate failure dominates and is never masked by a reporting failure (ADR-0008). The separate best-effort cloud-sync path (the run's `signalSink`) ships the envelope's `signals` as-is, **with no SARIF detour**, and never affects the exit code.

---

## SARIF, specifically

opensip-tools emits SARIF 2.1.0 via the shared `formatSignalSarif` formatter ([`packages/output/src/format/signal-sarif.ts`](../../../packages/output/src/format/signal-sarif.ts)) — the same formatter `fit`, `graph`, and `sim` all use. The schema URI:

```
https://json.schemastore.org/sarif-2.1.0.json
```

### What we fill in

- `version: '2.1.0'`, `$schema: <URL>`.
- `runs[]` — **one run** per envelope, with a single driver (`name: opensip-tools-<tool>`).
- `runs[].tool.driver`:
  - `name` — `opensip-tools-fit` / `-graph` / `-sim`.
  - `version` — a fixed driver version string.
  - `rules[]` — one entry per unique `ruleId` across the run's signals (sorted).
- `runs[].results[]` — one per signal:
  - `ruleId` — the signal's `ruleId` verbatim (e.g. `fit:no-console-log`, `graph.<family>.<rule>`).
  - `message.text`.
  - `level` — `critical`/`high` → `error`; `medium` → `warning`; `low` → `note`. (`critical`/`high` both surface as `error` to match GitHub Code Scanning's PR-blocking threshold.)
  - `locations[].physicalLocation.artifactLocation.uri` — the file path.
  - `locations[].physicalLocation.region.startLine` / `startColumn` — only when present.

### What we don't fill in

The full SARIF spec has many more optional fields (`taxonomies`, `invocations`, `originalUriBaseIds`, `fixes`, `properties`). opensip-tools fills in only what's load-bearing for the gate and for downstream consumers like GitHub Code Scanning. Transitive context carried in `Signal.metadata` is intentionally dropped at the SARIF boundary. Adding more fields is a minor compatible change.

### The baseline (SQLite, not SARIF)

The gate baseline is the stored `SignalEnvelope`, not a SARIF document (see the gate section above). `compareToBaseline` extracts hashed violations from the current envelope and the stored baseline envelope and diffs them — see [`packages/fitness/engine/src/gate.ts`](../../../packages/fitness/engine/src/gate.ts) (`extractViolationsFromEnvelope` / `extractViolationsFromStoredBaseline`). The on-disk CI artifact stays a SARIF document because `fit-baseline-export` converts the stored envelope to SARIF via the root `cli.writeSarif` seam.

---

## Where the example lands

For `acme-api`'s PR CI job (after the workflow downloads the `fit-baseline` artifact built by the main-branch job into `opensip-tools/.runtime/`):

```bash
opensip-tools fit --gate-compare
```

1. `executeFit(args)` runs the default recipe, producing a `SignalEnvelope` with 80 units and (today) 30 signals.
2. The gate loads the stored envelope from the `fit_baseline` row in `.runtime/datastore.sqlite` (29 signals from last week's main build).
3. `extractViolationsFromEnvelope` and `extractViolationsFromStoredBaseline` both produce hashed violation lists.
4. The diff: 1 new signal (`no-console-log` at `services/api/src/routes/payments.ts:88` — a `console.log` slipped in), 0 resolved, 29 unchanged.
5. Output: `✗ DEGRADED — 1 new violation`. Exit code 1. The PR fails.
6. Engineer inspects, removes the `console.log`, re-runs CI. New diff: 0 added, 0 resolved, 29 unchanged. Exit code 0. PR merges.

If they'd intentionally added the `console.log` (it's the CLI's startup banner, say), they'd add a directive (`// @fitness-ignore-next-line no-console-log`), the violation wouldn't appear in the run, and the gate would pass without baseline edits.

---

## What's next

You've now seen the four mental-model docs and the four fit-loop docs. That's the complete picture of the `fit` command.

- **[`../30-sim/`](../30-sim/)** — the simulation tool's parallel architecture. Read after `fit` is solid.
- **[`../80-implementation/`](../80-implementation/)** — execution mechanics: dispatch, plugin loader, persistence.
- **[`../10-concepts/05-architecture-gate.md`](../10-concepts/05-architecture-gate.md)** — the gate's full behavior, edge cases, CI patterns.
- **[`../70-reference/04-json-output-schema.md`](../70-reference/04-json-output-schema.md)** — every field of the `SignalEnvelope` with type and presence rules, plus the v1→v2 mapping.
