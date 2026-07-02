---
status: current
last_verified: 2026-06-07
release: v0.2.2
title: "JSON output schema"
audience: [ci-integrators, plugin-authors]
purpose: "The CommandOutcome and SignalEnvelope shapes every tool emits on --json. Every field, every type, and every presence rule."
source-files:
  - packages/contracts/src/signal-envelope.ts
  - packages/core/src/types/signal.ts
related-docs:
  - ../10-concepts/04-contract-surfaces.md
  - ../20-fit/04-output-gate-sarif.md
  - ../30-sim/02-execution-model.md
---
# JSON output schema

`opensip fit --json`, `opensip sim --json`, `opensip graph --json`, `opensip graph lookup --json`, and `opensip config validate|schema --json` all emit one `CommandOutcome` wrapper on stdout ([ADR-0024](../../decisions/ADR-0024-command-outcome-and-observability.md), [ADR-0065](../../decisions/ADR-0065-public-json-output-and-raw-stream-policy.md)). Run commands carry a `SignalEnvelope` under `.envelope`; list/report/config commands carry their result under `.data`; failures carry structured `errors`. This is the contract surface for CI integrations.

```jsonc
{
  "kind": "fit.run",          // '<tool>.run' (envelope) | '<result.type>' (data) | 'bootstrap.error'
  "status": "ok",             // 'ok' | 'error' | 'partial'
  "exitCode": 0,
  "envelope": { /* the SignalEnvelope, unchanged — see below */ },
  "diagnostics": { /* RunDiagnostics — lifecycle events, JSON-emittable */ }
}
```

`CommandOutcome<T>` lives in [`packages/contracts/src/command-outcome.ts`](../../../packages/contracts/src/command-outcome.ts). The host ASSEMBLES it from each handler's unchanged domain return and serializes it through one renderer; no tool chooses its own error JSON or success carrier. A list/report command sets `.data` (a `CommandResult`) instead of `.envelope`; a failure — including a pre-handler bootstrap failure such as *no project found* — sets `status:"error"` + `.errors[]` (`{ message, suggestion?, code? }`) with neither payload.

The **inner `SignalEnvelope`** is documented below. It lives in [`packages/contracts/src/signal-envelope.ts`](../../../packages/contracts/src/signal-envelope.ts) (the envelope) and [`packages/core/src/types/signal.ts`](../../../packages/core/src/types/signal.ts) (the `Signal`). Per [ADR-0011](../../decisions/ADR-0011-signal-output-currency-formatter-sink.md), **`Signal` is the single output currency of every tool**: a `fit` check, a `graph` rule, and a `sim` scenario are all **units** that *produce signals*, and every run yields one envelope.

> **Stability:** the `schemaVersion: 2` field on the envelope is the output-contract version (independent of any package version). Adding optional fields is a minor change; removing or changing types is a major change.

## Suite Run Results

`opensip suite run <name> --json` emits a `CommandOutcome` whose `.data` is a
`SuiteRunResult` ([ADR-0093](../../decisions/ADR-0093-host-owned-suite-plane.md),
[ADR-0100](../../decisions/ADR-0100-suite-per-step-verdict-and-aggregate-output.md)).
The suite exit code remains the worst step exit code. The aggregate and
per-step verdict fields are additive; older fields keep their names and types.

```jsonc
{
  "kind": "suite-run",
  "status": "ok",
  "exitCode": 1,
  "data": {
    "type": "suite-run",
    "suite": "security",
    "suiteRunId": "suite_3c4e8a1b9d21",
    "exitCode": 1,
    "durationMs": 1842,
    "aggregate": {
      "steps": 3,
      "passed": 1,
      "failed": 1,
      "faulted": 1,
      "errors": 2,
      "warnings": 4
    },
    "steps": [
      {
        "tool": "fitness",
        "stableId": "00000000-0000-4000-8000-000000000111",
        "command": "fit",
        "exitCode": 0,
        "durationMs": 612,
        "verdict": {
          "passed": true,
          "errors": 0,
          "warnings": 4,
          "findings": 4
        }
      },
      {
        "tool": "graph",
        "stableId": "00000000-0000-4000-8000-000000000222",
        "command": "graph",
        "exitCode": 1,
        "durationMs": 740,
        "verdict": {
          "passed": false,
          "errors": 2,
          "warnings": 0,
          "findings": 2
        }
      },
      {
        "tool": "sim",
        "stableId": "00000000-0000-4000-8000-000000000333",
        "command": "sim",
        "exitCode": 1,
        "durationMs": 490,
        "error": "scenario faulted"
      }
    ]
  }
}
```

### `SuiteRunResult`

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"suite-run"` | yes | Discriminant for suite run command results. |
| `suite` | string | yes | Suite name from `suites.<name>`. |
| `suiteRunId` | string | yes | Host-generated id shared by the step sessions produced in the run. |
| `exitCode` | number | yes | Worst step exit code. |
| `durationMs` | number | yes | Host-measured suite duration. |
| `aggregate` | object | no | Additive roll-up over step summaries. Present on current CLI output; optional for compatibility. |
| `steps` | `SuiteStepSummary[]` | yes | One summary per configured step, in execution order. |

### `SuiteAggregate`

| Field | Type | Description |
|---|---|---|
| `steps` | number | Total configured steps that ran. |
| `passed` | number | Steps with a passing emitted verdict and successful step exit. |
| `failed` | number | Non-faulted steps with a failing emitted verdict or non-zero step exit. |
| `faulted` | number | Steps that threw or faulted before completing normally. |
| `errors` | number | Sum of `steps[].verdict.errors` across envelope-emitting steps. |
| `warnings` | number | Sum of `steps[].verdict.warnings` across envelope-emitting steps. |

### `SuiteStepSummary`

| Field | Type | Required | Description |
|---|---|---|---|
| `tool` | string | yes | Tool display name. |
| `stableId` | string | yes | Stable tool UUID used by suite config. |
| `command` | string | yes | Command run for this step. |
| `exitCode` | number | yes | Captured step exit code. |
| `durationMs` | number | yes | Host-measured step duration. |
| `error` | string | no | Error message when the step faulted. |
| `verdict` | object | no | Counts-only projection of the step's last emitted `SignalEnvelope`. Absent means the step emitted no envelope. |

`steps[].verdict` contains only `passed`, `errors`, `warnings`, and `findings`
(`SignalEnvelope.signals.length`). It intentionally excludes signal messages,
file paths, symbols, match snippets, and raw scanner output.

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
  "signals": [ /* Signal[] */ ],
  "baselineIdentity": {
    "fingerprintStrategyId": "opensip.default.rule-file-line-col",
    "fingerprintStrategyVersion": 1
  },
  "declaredInputs": {
    "cliVersion": "0.1.16",
    "nodeVersion": "24.16.0",
    "packageManager": "pnpm@11.5.1",
    "platform": "darwin/arm64",
    "tool": "fit",
    "engineVersion": "0.1.16",
    "baselineIdentity": {
      "fingerprintStrategyId": "opensip.default.rule-file-line-col",
      "fingerprintStrategyVersion": 1
    }
  }
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
| `baselineIdentity` | `{ fingerprintStrategyId: string; fingerprintStrategyVersion: number }` | yes | Fingerprint strategy that stamped signal fingerprints; persisted on `--gate-save` and compared on `--gate-compare` ([ADR-0075](../../decisions/ADR-0075-state-locking-and-baseline-identity-versioning.md)). |
| `declaredInputs` | `DeclaredInputs` | no | Host-stamped verdict provenance: CLI/Node/package-manager/platform/tool/engine/baseline identity. Optional for additive compatibility; absence means an older/no-manifest producer ([ADR-0097](../../decisions/ADR-0097-gate-verdict-determinism.md)). |
| `resolutionMode` | `"exact"` \| `"fast"` | no | **graph-only** edge-fidelity marker. Absent for `fit` / `sim`. |

### `DeclaredInputs`

`declaredInputs` is added by the host before JSON outcome rendering, delivery,
SARIF reporting, and dashboard/report composition. It is an allowlist, not an
environment dump.

```jsonc
{
  "cliVersion": "0.1.16",
  "nodeVersion": "24.16.0",
  "packageManager": "pnpm@11.5.1",
  "platform": "darwin/arm64",
  "tool": "fit",
  "engineVersion": "0.1.16",
  "baselineIdentity": {
    "fingerprintStrategyId": "opensip.default.rule-file-line-col",
    "fingerprintStrategyVersion": 1
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `cliVersion` | string | yes | Installed opensip-cli package version that emitted the envelope. |
| `nodeVersion` | string | yes | `process.versions.node` from the host process. |
| `packageManager` | string | no | Nearest `package.json#packageManager`, falling back to the first package token in `npm_config_user_agent`. |
| `platform` | string | yes | Host platform/architecture, e.g. `darwin/arm64`. |
| `tool` | string | yes | Tool id for the run envelope. |
| `engineVersion` | string | no | Tool/engine package version when available from the active tool manifest. |
| `baselineIdentity` | `{ fingerprintStrategyId: string; fingerprintStrategyVersion: number }` | no | Baseline fingerprint identity copied from the envelope. |

The manifest intentionally excludes absolute paths, full environment variables,
credentials, and config payloads.

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
| `passed` | boolean | yes | `true` ⇔ **no `critical`/`high` signals** (the "error rung"). This is the CI gate: `--json \| jq -e '.envelope.verdict.passed'`. |
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

Each entry in `signals[]` is a `Signal` ([`packages/core/src/types/signal.ts`](../../../packages/core/src/types/signal.ts)).
It carries 4-level severity, a `category`, a `provider`, a `fingerprint`, and a
fix hint with confidence.

```jsonc
{
  "id": "sig_a3f9c204e1b2",
  "source": "no-console-log",
  "provider": "opensip-cli",
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
| `provider` | string | yes | The producer's namespace. `"opensip-cli"` for built-in checks/rules; command-mode wrappers carry the wrapped tool's name. |
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
| `repair` | `SignalRepair` | no | Structured repair guidance for agents ([ADR-0086](../../decisions/ADR-0086-signal-repair-metadata.md)). Omitted when no guidance exists. Not exported to SARIF. |

#### `SignalRepair` (optional)

```jsonc
{
  "repairKind": "split-function",  // e.g. add-test | split-function | manual | unknown
  "autofixable": false,
  "suggestedCommand": "opensip fit --check large-function",
  "docsRef": "../60-guides/use-opensip-with-ai-agents.md",
  "confidence": 0.7,
  "patchHint": { "kind": "text", "summary": "Extract helper from lines 40-120" }
}
```

The line and column are **1-based** to match SARIF and most editor conventions. A signal without a location omits `line` / `column` and carries an empty `filePath`.

---

## Per-tool notes

All three tools emit the **same envelope**; the differences are confined to a few fields:

- **`fit`** — `tool: "fit"`; each unit is a check (`slug` = check slug); signal `ruleId` is `fit:<slug>`. Units carry the fitness-only `filesValidated` / `itemType` / `ignoredCount`.
- **`graph`** — `tool: "graph"`; each unit is a graph rule; signal `ruleId` / `source` are the OpenSIP-convention id (`graph.<family>.<rule>`). The graph rules: `orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`, `large-function`, `wide-function`, `high-blast-untested`, `cycle`, `unexpected-coupling`. The graph envelope also carries the optional `resolutionMode` marker. Graph builds the envelope in [`packages/graph/engine/src/cli/build-envelope.ts`](../../../packages/graph/engine/src/cli/build-envelope.ts).
- **`sim`** — `tool: "sim"`; each unit is a scenario (`slug` = scenario id,
  `error` set when a scenario errored).

> **Per-kind sim detail** (load p99, chaos recovery time) is **not** in the envelope. It lives in the session's `session_tool_payload` row persisted to the project-local SQLite store (`<project>/opensip-cli/.runtime/datastore.sqlite`) via `SessionRepo`. The dashboard reads the session record for the deeper view.

---

## Error result — `status: "error"`

When a run fails before producing an envelope (config invalid, plugin failed to load, baseline missing), the `--json` output is still a `CommandOutcome` — `status: "error"` with neither `.envelope` nor `.data`, only a structured `errors[]`:

```jsonc
{
  "kind": "command.error",
  "status": "error",
  "exitCode": 2,
  "errors": [
    {
      "message": "Gate baseline not found in the project SQLite store. Run `opensip fit --gate-save` first to create one.",
      "suggestion": "Run opensip fit --gate-save.",
      "code": "CONFIGURATION_ERROR"
    }
  ]
}
```

Each `ErrorDetail` carries a `message`, an optional actionable `suggestion`, and an optional machine `code`. The `exitCode` is 2 (configuration/runtime error) or whatever the throwing code specified — and it matches the top-level `exitCode` field as well as the process exit code.

---

## Compatibility commitments

- **Adding optional fields is a minor change.** A consumer that doesn't know about a new field continues to work.
- **Adding required fields is a major change.** This would break consumers that don't account for it.
- **Reordering keys is *not* a contract.** Consumers must parse, not pattern-match. In practice the formatter emits keys in declared order.
- **`schemaVersion` changes only on a major.** A `schemaVersion: 3` payload is allowed to break consumers expecting 2; switch on the version.

---

## Reading the output in CI

A few CI patterns:

The envelope is nested under `.envelope` of the `CommandOutcome` wrapper — every path below reflects that.

```bash
# Fail on any error-rung (critical/high) signal:
opensip fit --json | jq -e '.envelope.verdict.passed'

# Print only failed units:
opensip fit --json | jq '.envelope.units | map(select(.passed == false))'

# Count error-rung signals by file:
opensip fit --json | jq '.envelope.signals[] | select(.severity == "critical" or .severity == "high") | .filePath' | sort | uniq -c

# All signals for one unit (join on source → slug):
opensip fit --json | jq '.envelope.signals[] | select(.source == "no-console-log")'

# Score gate:
opensip fit --json | jq -e '.envelope.verdict.score >= 90'
```

For SARIF (the gate's native shape), use `--gate-save` / `--gate-compare`. The SARIF shape is the SARIF 2.1.0 spec's, not opensip-cli' — see [`10-concepts/05-architecture-gate.md`](../10-concepts/05-architecture-gate.md).

### Agent-filtered live/replay output

When `fit`/`graph`/`sim` run with `--json` and any `--filter` token (or
`sessions show` with filters), the payload includes filter metadata
([ADR-0085](../../decisions/ADR-0085-change-detection-substrate.md)):

```jsonc
{
  "filtersApplied": ["errors-only", "top:20"],
  "originalSignalCount": 142,
  "returnedSignalCount": 20,
  "envelope": { /* filtered SignalEnvelope */ }
}
```

With `--raw`, the outer `CommandOutcome` wrapper is omitted and only the
filtered result object is emitted.

### `graph impact --json`

```jsonc
{
  "kind": "graph-impact",
  "status": "ok",
  "exitCode": 0,
  "data": {
    "type": "graph-impact",
    "basis": { "type": "changed", "ref": "main" },
    "changedFiles": ["src/foo.ts"],
    "changedFunctions": [ /* ImpactFunction[] */ ],
    "impactedFunctions": [ /* ImpactFunction[] */ ],
    "impactedPackages": [ /* ImpactPackage[] */ ],
    "recommendedCommands": ["opensip fit --changed --include-impacted --json"],
    "truncated": false
  }
}
```

### `graph lookup --json`

```jsonc
{
  "kind": "graph-lookup",
  "status": "ok",
  "exitCode": 0,
  "data": {
    "type": "graph-lookup",
    "name": "saveBaseline",
    "resolutionMode": "exact",
    "matches": [ /* GraphLookupMatch[] */ ]
  }
}
```

### `config validate|schema --json`

```jsonc
// validate success
{
  "kind": "config-validate",
  "status": "ok",
  "exitCode": 0,
  "data": {
    "type": "config-validate",
    "valid": true,
    "configPath": "/path/to/opensip-cli.config.yml",
    "namespaces": ["cli", "fitness", "graph", "targets"]
  }
}

// schema success
{
  "kind": "config-schema",
  "status": "ok",
  "exitCode": 0,
  "data": {
    "type": "config-schema",
    "schema": { /* JSON Schema document */ },
    "namespaces": ["cli", "fitness", "graph"]
  }
}
```

---

## What's next

- **[`03-configuration.md`](./03-configuration.md)** — `opensip-cli.config.yml` schema (the *input* shape).
- **[`../10-concepts/04-contract-surfaces.md`](../10-concepts/04-contract-surfaces.md)** — every contract surface, with stability tiers.
