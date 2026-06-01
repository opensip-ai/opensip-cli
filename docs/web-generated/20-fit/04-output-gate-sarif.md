---
status: current
last_verified: 2026-05-22
release: v2.0.x
title: "Output, gate, SARIF"
audience: [contributors, ci-integrators]
purpose: "What happens to the violations a check produces — render layer, JSON output, SARIF, the gate, cloud reporting."
source-files:
  - packages/contracts/src/types.ts
  - packages/reporting/src/sarif.ts
  - packages/fitness/engine/src/gate.ts
  - packages/fitness/engine/src/cli/fit.ts
  - packages/cli/src/ui/
related-docs:
  - ./01-recipes-and-checks.md
  - ./03-ignore-directives.md
  - ../10-concepts/05-architecture-gate.md
  - ../70-reference/04-json-output-schema.md
---
# Output, gate, SARIF

A check produced violations. Now what?

This doc walks the output side of the fit loop: how violations become a `CliOutput`, how the renderer turns that into stdout, how `--gate-save`/`--gate-compare` use SARIF for baseline comparison, and how `--report-to` ships the same data to OpenSIP Cloud.

> **What you'll understand after this:**
> - The four output paths a fit run can take.
> - The shape of `CliOutput` and where it's defined.
> - How the gate's identity hash works (and why line numbers are deliberately excluded).
> - How SARIF chunking handles large runs.

---

## The four output paths

A fit run takes exactly one of these paths:

```
                 ┌─ default      → Ink table on stdout, exit code from result
                 │
fit run ─ Cli    ├─ --json       → CliOutput JSON on stdout, exit code from result
                 │
                 ├─ --gate-save  → SARIF written to baseline file, exit code 0
                 │  / --gate-    → SARIF compared to baseline, exit code = degraded?
                 │  compare
                 │
                 └─ --report-to  → SARIF chunked + POSTed to URL, exit code from result
```

The paths are mutually exclusive in their effect on stdout, but composable in their effect on the cloud / baseline. You can run `fit --json --report-to https://opensip.ai/api` and get JSON locally *and* a cloud upload. You cannot run `fit --json --gate-compare` and get JSON output — gate mode owns stdout.

---

## The `CliOutput` envelope

Every output path starts from the same shape — a `CliOutput` produced after the recipe runs. Defined at [`packages/contracts/src/types.ts:100`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.1/packages/contracts/src/types.ts):

```ts
interface CliOutput {
  readonly version: '1.0';
  readonly tool: 'fit' | 'sim' | 'graph';
  readonly timestamp: string;            // ISO 8601 — when the run started
  readonly recipe?: string;              // recipe name if --recipe was used
  readonly score: number;                // 0..100, deterministic
  readonly passed: boolean;              // true iff every check passed
  readonly summary: {
    total: number; passed: number; failed: number;
    errors: number; warnings: number;
  };
  readonly checks: readonly CheckOutput[];
  readonly durationMs: number;
}

interface CheckOutput {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly findings: readonly FindingOutput[];
  readonly durationMs: number;
}

interface FindingOutput {
  readonly ruleId: string;               // e.g. 'fit:no-console-log'
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
}
```

`CliOutput` is the canonical artifact. The renderer, the SARIF builder, the cloud reporter, and the gate all consume this shape. If you're writing a CI integration, parse `CliOutput`. The shape is part of the contract surface ([`10-concepts/04-contract-surfaces.md`](/docs/opensip-tools/10-concepts/04-contract-surfaces/)).

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

The renderer is in [`packages/cli/src/ui/`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.1/packages/cli/src/ui/) and depends on Ink + React. It's the only consumer of those libraries; nothing in `core`, `fitness`, or any check pack imports them. This is why a future GUI front-end could replace the renderer without touching a Tool — the Tool calls `cli.renderLive('fit', args)` and the CLI maps that to whatever rendering layer is in place.

`-v` / `--verbose` adds inline finding details to the table. `--findings` adds a per-check finding listing after the table. `--quiet` suppresses the banner and shows only the pass/fail summary line.

The exit code is set by the Tool action via `cli.setExitCode(code)`:

- `0` — every check passed.
- `1` — at least one check failed (or `shouldFail` based on `failOnErrors`/`failOnWarnings` config).
- `2` — runtime error before checks could run.

---

## Path 2: `--json`

```bash
opensip-tools fit --json
```

Bypasses the Ink renderer entirely. Calls `executeFit(args)` directly, then `process.stdout.write(JSON.stringify(output, null, 2) + '\n')`.

This is the path CI integrations should use. Stdout is the JSON; stderr carries logs (also JSON-lines, on a separate stream); the exit code is the gate.

```bash
# Capture and pipe to jq:
opensip-tools fit --json | jq '.summary'

# Fail CI if score < 90:
opensip-tools fit --json | jq -e '.score >= 90' || exit 1
```

The `version: '1.0'` discriminator is part of the contract. New optional fields can be added in minors; required fields and the discriminator are major-version changes.

---

## Path 3: the architecture gate

```bash
opensip-tools fit --gate-save                     # capture today's reality
opensip-tools fit --gate-compare                  # CI gate from now on
```

The gate is the regression-detection workflow. `--gate-save` writes the current run's findings as a SARIF document into the project's SQLite store (`fit_baseline` table at `<project>/opensip-tools/.runtime/datastore.sqlite`). `--gate-compare` runs the same checks, reads the saved baseline back out, computes the diff, and exits 1 if any *new* finding appears. There is exactly one baseline per project.

> **v1 → v2 break.** The `--baseline <path>` flag is gone. v1 stored baselines as SARIF files; v2 stores them in SQLite. See [`10-concepts/05-architecture-gate.md#ci-integration-patterns`](/docs/opensip-tools/10-concepts/05-architecture-gate/#ci-integration-patterns) for the artifact-based CI workflow that replaces the v1 "committed baseline" pattern.

The full gate behavior — diff classification, line-shift invariance, partial-SARIF tolerance — is documented in [`10-concepts/05-architecture-gate.md`](/docs/opensip-tools/10-concepts/05-architecture-gate/). The short version:

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

The same `CliOutput` is converted to SARIF runs and POSTed in chunks to the configured URL. This path is composable — `--report-to` runs alongside the default Ink renderer, alongside `--json`, alongside `--gate-compare`. Reporting is a side-channel, not a stdout-replacement.

The chunker lives in [`packages/reporting/src/sarif.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.1/packages/reporting/src/sarif.ts):

```ts
chunkSarifRuns(runs, maxFindings = 500): SarifRun[][]
```

Algorithm:

1. Pack whole SARIF runs into chunks of at most `maxFindings` findings each.
2. If a single run exceeds `maxFindings`, split it across chunks (preserving rule-id metadata in each slice).
3. Each chunk is a complete SARIF document — the receiver doesn't need to reassemble.

Per chunk:

- The reporter computes a timeout: `min(300_000, 60_000 + chunkFindings * 100)` ms — 60s base plus 100ms per finding, capped at 5 minutes. The receiver does per-finding work (dedup, persistence, trace writes); the timeout scales with the workload.
- It POSTs to `<url>/sarif?cwd=<cwd>` with `X-API-Key` if provided.
- The `fetch()` call is wrapped in `withRetry` from `@opensip-tools/core` — `maxAttempts: 3`, `initialDelayMs: 500`, `maxDelayMs: 5000`. This retries when `fetch()` *rejects* (network errors, AbortSignal timeouts).
- HTTP-status handling is separate: a transient 5xx / 429 response aborts the chunk attempt and proceeds to the next chunk; a non-transient 4xx aborts all remaining chunks (no point sending more).

The result is a `ReportResult` with `chunksTotal` / `chunksSucceeded`. Partial success is reported back to the user via the run's footer.

---

## SARIF, specifically

opensip-tools emits SARIF 2.1.0. The schema URI is hardcoded in [`packages/reporting/src/sarif.ts:6`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.1/packages/reporting/src/sarif.ts):

```
https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json
```

### What we fill in

- `version: '2.1.0'`, `$schema: <URL>`.
- `runs[]` — one per check slug that produced findings (zero-finding checks aren't included).
- `runs[].tool.driver`:
  - `name` — the check slug.
  - `version` — `'1.0.0'` (currently a fixed string; could be the check pack version in a future revision).
  - `rules[]` — one entry per unique `ruleId` in the run's findings.
- `runs[].results[]` — one per finding:
  - `ruleId` — e.g. `'fit:no-console-log'`.
  - `message.text`.
  - `level` — `'error'` or `'warning'`.
  - `locations[].physicalLocation.artifactLocation.uri` — the file path.
  - `locations[].physicalLocation.region.startLine` / `startColumn` — only if the values are positive (SARIF rejects 0).
  - `fixes[]` — populated from the finding's `suggestion` field, if present.

### What we don't fill in

The full SARIF spec has many more optional fields (`taxonomies`, `invocations`, `originalUriBaseIds`, `properties`). opensip-tools fills in only what's load-bearing for the gate and for downstream consumers like GitHub Code Scanning. Adding more fields is a minor compatible change.

### Reading SARIF as a baseline

The baseline reader is forgiving — it tolerates partial SARIF (a run with no `results` array, a result with no `locations`, etc.) so a hand-edited baseline doesn't crash the gate. See [`packages/fitness/engine/src/gate.ts:287`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.1/packages/fitness/engine/src/gate.ts) (`extractViolationsFromSarif`).

This permissiveness exists for a real reason: teams sometimes hand-edit baselines to remove a finding they've intentionally fixed, or to add an entry that they want grandfathered. The gate parser shouldn't refuse those edits as long as the document is structurally a SARIF log.

---

## Where the example lands

For `acme-api`'s PR CI job (after the workflow downloads the `fit-baseline` artifact built by the main-branch job into `opensip-tools/.runtime/`):

```bash
opensip-tools fit --gate-compare
```

1. `executeFit(args)` runs the default recipe, producing a `CliOutput` with 80 checks and (today) 30 findings.
2. The gate loads the SARIF payload from the `fit_baseline` row in `.runtime/datastore.sqlite` (29 findings from last week's main build).
3. `extractViolationsFromSarif` and `extractViolationsFromCliOutput` both produce hashed violation lists.
4. The diff: 1 new finding (`no-console-log` at `services/api/src/routes/payments.ts:88` — a `console.log` slipped in), 0 resolved, 29 unchanged.
5. Output: `✗ DEGRADED — 1 new violation`. Exit code 1. The PR fails.
6. Engineer inspects, removes the `console.log`, re-runs CI. New diff: 0 added, 0 resolved, 29 unchanged. Exit code 0. PR merges.

If they'd intentionally added the `console.log` (it's the CLI's startup banner, say), they'd add a directive (`// @fitness-ignore-next-line no-console-log`), the violation wouldn't appear in the run, and the gate would pass without baseline edits.

---

## What's next

You've now seen the four mental-model docs and the four fit-loop docs. That's the complete picture of the `fit` command.

- **[`../30-sim/`](/docs/opensip-tools/30-sim/)** — the simulation tool's parallel architecture. Read after `fit` is solid.
- **[`../80-implementation/`](/docs/opensip-tools/80-implementation/)** — execution mechanics: dispatch, plugin loader, persistence.
- **[`../10-concepts/05-architecture-gate.md`](/docs/opensip-tools/10-concepts/05-architecture-gate/)** — the gate's full behavior, edge cases, CI patterns.
- **[`../70-reference/04-json-output-schema.md`](/docs/opensip-tools/70-reference/04-json-output-schema/)** — every field of `CliOutput` with type and presence rules.
