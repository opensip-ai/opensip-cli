---
status: current
last_verified: 2026-06-07
release: v2.8.0
title: "JSON output schema"
audience: [ci-integrators, plugin-authors]
purpose: "The SignalEnvelope shape every tool emits on --json. Every field, every type, every presence rule, plus the v1→v2 mapping."
source-files:
  - packages/contracts/src/signal-envelope.ts
  - packages/core/src/types/signal.ts
related-docs:
  - ../10-concepts/04-contract-surfaces.md
  - ../20-fit/04-output-gate-sarif.md
  - ../30-sim/02-execution-model.md
---
# JSON output schema

`opensip-tools fit --json`, `opensip-tools sim --json`, and `opensip-tools graph --json` all emit **one `CommandOutcome` wrapper on stdout** (release 2.12.0, [ADR-0024](https://github.com/opensip-ai/opensip-tools/blob/v2.11.0/docs/decisions/ADR-0024-command-outcome-and-observability.md)). The **byte-identical `SignalEnvelope` rides under `.envelope`**; list/dashboard commands carry their result under `.data`; a failure carries structured `errors`. This is the contract surface for CI integrations.

> **2.12.0 breaking change.** Before 2.12.0, `--json` emitted the bare `SignalEnvelope` at the top level. It is now nested under `.envelope` of a `CommandOutcome`. Read `.envelope.verdict.passed` where you previously read `.verdict.passed` (and `.data` for list/dashboard, `.errors` for failures). The inner envelope is unchanged. See [Migrating to 2.12](/docs/opensip-tools/70-reference/09-migrating-to-2.12/).

```jsonc
{
  "kind": "fit.run",          // '<tool>.run' (envelope) | '<result.type>' (data) | 'bootstrap.error'
  "status": "ok",             // 'ok' | 'error' | 'partial'
  "exitCode": 0,
  "envelope": { /* the SignalEnvelope, unchanged — see below */ },
  "diagnostics": { /* RunDiagnostics — lifecycle events, JSON-emittable */ }
}
```

`CommandOutcome<T>` lives in [`packages/contracts/src/command-outcome.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.11.0/packages/contracts/src/command-outcome.ts). The host ASSEMBLES it from each handler's unchanged domain return and serializes it through one renderer; no tool chooses its own error JSON or success carrier. A list/dashboard command sets `.data` (a `CommandResult`) instead of `.envelope`; a failure — including a pre-handler bootstrap failure such as *no project found* — sets `status:"error"` + `.errors[]` (`{ message, suggestion?, code? }`) with neither payload.

The **inner `SignalEnvelope`** is documented below. It lives in [`packages/contracts/src/signal-envelope.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.11.0/packages/contracts/src/signal-envelope.ts) (the envelope) and [`packages/core/src/types/signal.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.11.0/packages/core/src/types/signal.ts) (the `Signal`). Per [ADR-0011](https://github.com/opensip-ai/opensip-tools/blob/v2.11.0/docs/decisions/ADR-0011-signal-output-currency-formatter-sink.md), **`Signal` is the single output currency of every tool**: a `fit` check, a `graph` rule, and a `sim` scenario are all **units** that *produce signals*, and every run yields one envelope.

> **Stability:** the `schemaVersion: 2` field on the envelope is the output-contract version (independent of any package version). Adding optional fields is a minor change; removing or changing types is a major change.

> **Migrating from the old shape?** The v1 `CliOutput` JSON (`version: "1.0"`, `checks[]`, `findings[]`) became the v2 envelope in 2.7.0 — jump to the [v1 → v2 mapping](#v1--v2-mapping). The 2.12.0 `CommandOutcome` wrapper is covered in [Migrating to 2.12](/docs/opensip-tools/70-reference/09-migrating-to-2.12/).

---

## The `SignalEnvelope`

```jsonc
{
  "schemaVersion": 2,
  "tool": "fit",
  "recipe": "default",
  "runId": "run_9bb6ef4d07c0",
  "createdAt": "2026-05-15T10:30:00.000Z",
  "verdict": {
    "score": 87,
    "passed": false,
    "summary": {
      "total": 80,
      "passed": 78,
      "failed": 2,
      "errors": 5,
      "warnings": 12
    }
  },
  "units": [ /* UnitResult[] */ ],
  "signals": [ /* Signal[] */ ]
}
```

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | `2` | yes | Output-contract version. Bumped on breaking changes; independent of package version. |
| `tool` | `"fit"` \| `"sim"` \| `"graph"` | yes | The tool that produced this envelope. |
| `recipe` | string | no | Recipe name if `--recipe` was used (or the default recipe's name). |
| `runId` | string | yes | Stable identifier for this run (also used as the cloud-egress / `--report-to` idempotency root). |
| `createdAt` | string (ISO 8601) | yes | When the run was assembled. |
| `verdict` | `RunVerdict` | yes | Run-level pass/fail header. See below. |
| `units` | `UnitResult[]` | yes | Per-unit ran/errored/timing facts. May be `[]`. |
| `signals` | `Signal[]` | yes | The flat list of findings the run produced. May be `[]`. |
| `resolutionMode` | `"exact"` \| `"fast"` | no | **graph-only** edge-fidelity marker. Absent for `fit` / `sim`. |

### `RunVerdict`

```jsonc
{
  "score": 87,
  "passed": false,
  "summary": {
    "total": 80,
    "passed": 78,
    "failed": 2,
    "errors": 5,
    "warnings": 12
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `score` | number (0..100) | yes | Pass percentage. Deterministic given the same set of units/signals. |
| `passed` | boolean | yes | `true` ⇔ **no `critical`/`high` signals** (the "error rung"). This is the CI gate: `--json \| jq -e '.verdict.passed'`. |
| `summary.total` | number | yes | Total units that ran. |
| `summary.passed` | number | yes | Units that passed (emitted no `critical`/`high` signals). |
| `summary.failed` | number | yes | Units that failed. |
| `summary.errors` | number | yes | Total `critical` + `high` signals across the run. |
| `summary.warnings` | number | yes | Total `medium` + `low` signals across the run. |

### `UnitResult`

A **unit** is the neutral umbrella over a fit check, a graph rule, and a sim scenario. `units[]` carries only what a flat `Signal[]` cannot express — that a unit ran, whether it errored, and timing.

```jsonc
{
  "slug": "no-console-log",
  "passed": false,
  "violationCount": 2,
  "durationMs": 87,
  "filesValidated": 450,
  "itemType": "files",
  "ignoredCount": 1
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `slug` | string | yes | The unit's identifier (check slug / graph rule slug / scenario id). |
| `passed` | boolean | yes | `true` ⇔ the unit emitted no `critical`/`high` signals. |
| `violationCount` | number | no | Number of signals the unit produced. |
| `durationMs` | number | yes | Time the unit took to execute. |
| `error` | string | no | Error message if the unit errored (e.g. an agent provider unreachable for a sim scenario). A unit can have run-and-errored with zero signals. |
| `filesValidated` | number | no | **fitness-only.** Files the check scanned this run (the "Validated" column). A check that scanned 450 files and emitted 0 signals still reports `filesValidated: 450`. Graph rules / sim scenarios don't scan files and omit it. |
| `itemType` | string | no | **fitness-only.** Names the scanned noun (`"files"` / `"packages"` / …) for the column label that pairs with `filesValidated`. |
| `ignoredCount` | number | no | **fitness-only.** Findings suppressed by an inline `@fitness-ignore` directive this run (the "Ignores" column). Omitted by tools without a suppression mechanism. |

### `Signal`

Each entry in `signals[]` is a `Signal` ([`packages/core/src/types/signal.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.11.0/packages/core/src/types/signal.ts)). This is the richer shape that replaced the lossy `FindingOutput`: it carries 4-level severity, a `category`, a `provider`, a `fingerprint`, and a fix hint with confidence.

```jsonc
{
  "id": "sig_a3f9c204e1b2",
  "source": "no-console-log",
  "provider": "opensip-tools",
  "severity": "high",
  "category": "quality",
  "ruleId": "fit:no-console-log",
  "message": "console.log is forbidden in production",
  "suggestion": "Replace with structured logger.info()",
  "filePath": "services/api/src/routes/health.ts",
  "line": 42,
  "column": 17,
  "code": { "file": "services/api/src/routes/health.ts", "line": 42, "column": 17 },
  "fixAction": "replace-with-logger",
  "fixConfidence": 0.8,
  "metadata": {},
  "createdAt": "2026-05-15T10:30:00.000Z"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Per-signal identifier (`sig_<12 hex>`). |
| `source` | string | yes | The producing unit's slug — the join key back to `units[].slug`. For graph this is the OpenSIP-convention rule id (`graph.<family>.<rule>`). |
| `provider` | string | yes | The producer's namespace. `"opensip-tools"` for built-in checks/rules; command-mode wrappers carry the wrapped tool's name. |
| `severity` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | yes | 4-level severity. `critical`/`high` are the "error rung" (drive `verdict.passed`); `medium`/`low` are the "warning rung". |
| `category` | string | yes | Canonical labels: `security` \| `quality` \| `architecture` \| `testing` \| `resilience` \| `documentation` \| `warning` \| `performance` \| `error`. Open at the plugin layer (a plugin may declare its own). |
| `ruleId` | string | yes | Rule identifier. `fit:<slug>` for fit checks, `graph.<family>.<rule>` for graph rules, `<provider>:<rule>` for command-mode wrappers. |
| `message` | string | yes | Human-readable description. |
| `suggestion` | string | no | Optional fix suggestion. |
| `filePath` | string | yes | Project-relative file path. Empty string (`""`) for cross-cutting signals with no location. |
| `line` | number | no | 1-based line number. Absent for signals without a location. |
| `column` | number | no | 1-based column number. |
| `code` | `{ file?, line?, column? }` | no | Structured location echo (mirrors `filePath`/`line`/`column`). |
| `fixAction` | string | no | Machine label for the suggested fix. |
| `fixConfidence` | number (0..1) | no | Confidence in the suggested fix. |
| `metadata` | object | yes | Open key/value bag for rule-specific detail. May be `{}`. |
| `strength` | number | no | Optional signal-strength weight. |
| `fingerprint` | string | no | Stable de-dup fingerprint when the producer computes one. |
| `createdAt` | string (ISO 8601) | yes | When the signal was created. |

The line and column are **1-based** to match SARIF and most editor conventions. A signal without a location omits `line` / `column` and carries an empty `filePath`.

---

## Per-tool notes

All three tools emit the **same envelope**; the differences are confined to a few fields:

- **`fit`** — `tool: "fit"`; each unit is a check (`slug` = check slug); signal `ruleId` is `fit:<slug>`. Units carry the fitness-only `filesValidated` / `itemType` / `ignoredCount`.
- **`graph`** — `tool: "graph"`; each unit is a graph rule; signal `ruleId` / `source` are the OpenSIP-convention id (`graph.<family>.<rule>`). The graph rules: `orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`, `large-function`, `wide-function`, `high-blast-untested`, `cycle`, `unexpected-coupling`. The graph envelope also carries the optional `resolutionMode` marker. Graph builds the envelope in [`packages/graph/engine/src/cli/build-envelope.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.11.0/packages/graph/engine/src/cli/build-envelope.ts).
- **`sim`** — `tool: "sim"`; each unit is a scenario (`slug` = scenario id, `error` set when a scenario errored). `sim --json` now emits this envelope too — the old bespoke `sim-done` JSON shape is retired.

> **Per-kind sim detail** (load p99, chaos recovery time) is **not** in the envelope. It lives in the session's `session_tool_payload` row persisted to the project-local SQLite store (`<project>/opensip-tools/.runtime/datastore.sqlite`) via `SessionRepo`. The dashboard reads the session record for the deeper view.

---

## Error result — `ErrorResult`

When a run fails before producing an envelope (config invalid, plugin failed to load, baseline missing), the JSON output is the error envelope rather than a `SignalEnvelope`:

```jsonc
{
  "error": "Gate baseline not found in the project SQLite store. Run `opensip-tools fit --gate-save` first to create one."
}
```

Exit code is 2 (configuration/runtime error) or whatever the throwing code specified.

---

## v1 → v2 mapping

The v1 `--json` output was the fitness-shaped `CliOutput` husk (`version: "1.0"`). v2 is the signal-native `SignalEnvelope` (`schemaVersion: 2`). The mapping for a CI consumer migrating off v1:

| v1 (`CliOutput`) | v2 (`SignalEnvelope`) | Notes |
|---|---|---|
| `version: "1.0"` | `schemaVersion: 2` | Discriminator field renamed and re-typed (string → number). |
| top-level `score` | `verdict.score` | Same 0..100 meaning. |
| top-level `passed` | `verdict.passed` | Same boolean; now defined as "no `critical`/`high` signals". |
| `summary.*` | `verdict.summary.*` | Same field names, nested under `verdict`. |
| `timestamp` | `createdAt` | Renamed. |
| `durationMs` (top-level) | per-unit `units[].durationMs` | No single top-level total; sum `units[].durationMs` if needed. |
| `checks[]` | `units[]` | Per-unit ran/errored/timing facts (no nested findings). |
| `checks[].checkSlug` | `units[].slug` **and** `signals[].source` | The signal's `source` is the join key back to its unit's `slug`. |
| `checks[].findings[]` | `signals[]` | Flattened into one top-level list; join to a unit via `signals[].source === units[].slug`. |
| `findings[].severity: "error" \| "warning"` | `signals[].severity: "critical" \| "high" \| "medium" \| "low"` | 4-level. `error` ≈ `critical`/`high`; `warning` ≈ `medium`/`low`. |
| `findings[].ruleId` / `message` / `suggestion` / `filePath` / `line` / `column` | `signals[].ruleId` / `message` / `suggestion` / `filePath` / `line` / `column` | Same fields; signals add `category`, `provider`, `fingerprint`, `fixConfidence`. |

---

## Compatibility commitments

- **Adding optional fields is a minor change.** A consumer that doesn't know about a new field continues to work.
- **Adding required fields is a major change.** This would break consumers that don't account for it.
- **Reordering keys is *not* a contract.** Consumers must parse, not pattern-match. In practice the formatter emits keys in declared order.
- **`schemaVersion` changes only on a major.** A `schemaVersion: 3` payload is allowed to break consumers expecting 2; switch on the version.

---

## Reading the output in CI

A few CI patterns:

```bash
# Fail on any error-rung (critical/high) signal:
opensip-tools fit --json | jq -e '.verdict.passed'

# Print only failed units:
opensip-tools fit --json | jq '.units | map(select(.passed == false))'

# Count error-rung signals by file:
opensip-tools fit --json | jq '.signals[] | select(.severity == "critical" or .severity == "high") | .filePath' | sort | uniq -c

# All signals for one unit (join on source → slug):
opensip-tools fit --json | jq '.signals[] | select(.source == "no-console-log")'

# Score gate:
opensip-tools fit --json | jq -e '.verdict.score >= 90'
```

For SARIF (the gate's native shape), use `--gate-save` / `--gate-compare`. The SARIF shape is the SARIF 2.1.0 spec's, not opensip-tools' — see [`10-concepts/05-architecture-gate.md`](/docs/opensip-tools/10-concepts/05-architecture-gate/).

---

## What's next

- **[`03-configuration.md`](/docs/opensip-tools/70-reference/03-configuration/)** — `opensip-tools.config.yml` schema (the *input* shape).
- **[`../10-concepts/04-contract-surfaces.md`](/docs/opensip-tools/10-concepts/04-contract-surfaces/)** — every contract surface, with stability tiers.
