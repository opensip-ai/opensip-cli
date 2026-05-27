---
status: current
last_verified: 2026-05-26
release: v2.0.x
title: "JSON output schema"
audience: [ci-integrators, plugin-authors]
purpose: "The CliOutput shape (and the SimDoneResult shape). Every field, every type, every presence rule."
source-files:
  - packages/contracts/src/types.ts
related-docs:
  - ../10-concepts/04-contract-surfaces.md
  - ../20-fit/04-output-gate-sarif.md
  - ../30-sim/02-execution-model.md
---
# JSON output schema

`opensip-tools fit --json` and `opensip-tools sim --json` emit structured JSON on stdout. This is the contract surface for CI integrations.

The shapes live in [`packages/contracts/src/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/contracts/src/types.ts).

> **Stability:** the `version: '1.0'` discriminator on `CliOutput` is part of the contract. Adding optional fields is a minor change; removing or changing types is a major change.

---

## fit (fitness checks) — `CliOutput`

```ts
{
  "version": "1.0",
  "tool": "fit",
  "timestamp": "2026-05-15T10:30:00.000Z",
  "recipe": "default",
  "score": 87,
  "passed": false,
  "summary": {
    "total": 80,
    "passed": 78,
    "failed": 2,
    "errors": 5,
    "warnings": 12
  },
  "checks": [ /* CheckOutput[] */ ],
  "durationMs": 4321
}
```

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `"1.0"` | yes | Schema discriminator. Bumped on breaking changes. |
| `tool` | `"fit"` \| `"sim"` \| `"graph"` | yes | The tool that produced this output. `"fit"` for `opensip-tools fit`. |
| `timestamp` | string (ISO 8601) | yes | When the run started. |
| `recipe` | string | no | Recipe name if `--recipe` was used (or the default recipe's name). |
| `score` | number (0..100) | yes | Pass percentage. Deterministic given the same set of checks/findings. |
| `passed` | boolean | yes | True iff every check passed (exit code 0 unless thresholds say otherwise). |
| `summary.total` | number | yes | Total checks run. |
| `summary.passed` | number | yes | Checks that passed. |
| `summary.failed` | number | yes | Checks that failed (any error/warning count > 0). |
| `summary.errors` | number | yes | Total error-level findings across all checks. |
| `summary.warnings` | number | yes | Total warning-level findings. |
| `checks` | CheckOutput[] | yes | Per-check results. |
| `durationMs` | number | yes | Total run time in ms. |

### `CheckOutput`

```ts
{
  "checkSlug": "no-console-log",
  "passed": false,
  "violationCount": 2,
  "findings": [ /* FindingOutput[] */ ],
  "durationMs": 87
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `checkSlug` | string | yes | Check's kebab-case slug. |
| `passed` | boolean | yes | True iff the check produced zero violations. |
| `violationCount` | number | no | Number of violations. Equal to `findings.length` for most checks. |
| `findings` | FindingOutput[] | yes | Violation details. May be `[]`. |
| `durationMs` | number | yes | Time the check took to execute. |

### `FindingOutput`

```ts
{
  "ruleId": "fit:no-console-log",
  "message": "console.log is forbidden in production",
  "severity": "error",
  "filePath": "services/api/src/routes/health.ts",
  "line": 42,
  "column": 17,
  "suggestion": "Replace with structured logger.info()"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `ruleId` | string | yes | Rule identifier. Format: `fit:<slug>` for fit checks, `<provider>:<rule>` for command-mode wrappers. |
| `message` | string | yes | Human-readable description. |
| `severity` | `"error" \| "warning"` | yes | Finding severity. |
| `filePath` | string | no | Project-relative file path. Absent for cross-cutting findings. |
| `line` | number | no | 1-based line number. Absent for findings without a location. |
| `column` | number | no | 1-based column number. |
| `suggestion` | string | no | Optional fix suggestion. |

The line and column are **1-based** to match SARIF and most editor conventions. A finding without a location simply omits `filePath` / `line` / `column`.

---

## sim (simulation scenarios) — `SimDoneResult`

```ts
{
  "type": "sim-done",
  "recipeName": "pre-deploy",
  "cwd": "/workspace/acme-api",
  "totalScenarios": 3,
  "passedScenarios": 1,
  "failedScenarios": 2,
  "scenarios": [ /* per-scenario summaries */ ],
  "durationMs": 165432,
  "shouldFail": true
}
```

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"sim-done"` | yes | Result kind discriminator. |
| `recipeName` | string | yes | Recipe that ran. |
| `cwd` | string | yes | Project root used for the run. |
| `totalScenarios` | number | yes | Scenarios the recipe matched. |
| `passedScenarios` | number | yes | Scenarios that passed. |
| `failedScenarios` | number | yes | Scenarios that failed. |
| `scenarios` | object[] | yes | Per-scenario summaries. |
| `durationMs` | number | yes | Total run time in ms. |
| `shouldFail` | boolean | no | True iff at least one scenario failed. Exit code 1 when true. |

### Per-scenario summary

```ts
{
  "scenarioId": "11111111-1111-4111-8111-111111111111",
  "scenarioName": "checkout-burst",
  "kind": "load",
  "passed": true,
  "durationMs": 32_415,
  "error": undefined
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `scenarioId` | string | yes | Scenario's UUID. |
| `scenarioName` | string | yes | Human-readable name. |
| `kind` | `"load" \| "chaos" \| "invariant" \| "fix-evaluation"` | yes | Scenario kind. |
| `passed` | boolean | yes | True iff the scenario passed all assertions. |
| `durationMs` | number | yes | Scenario execution time. |
| `error` | string | no | Error message if the scenario errored (e.g. agent provider unreachable). |

> **Note:** per-kind details (load p99, invariant counterexample, chaos recovery time) are **not** in this top-level shape. They're in the session record on disk under `<project>/opensip-tools/.runtime/sessions/{timestamp}-sim-{recipe?}.json`. The dashboard reads the session record for the deeper view.

---

## graph (call-graph rules) — `CliOutput`

`opensip-tools graph --json` produces the **same `CliOutput` envelope** as `fit --json`. The only difference is `tool: "graph"` and the `ruleId` format on each finding (`graph:<rule-slug>` instead of `fit:<check-slug>`):

```json
{
  "version": "1.0",
  "tool": "graph",
  "timestamp": "2026-05-17T10:30:00.000Z",
  "score": 92,
  "passed": false,
  "summary": {
    "total": 5,
    "passed": 4,
    "failed": 1,
    "errors": 0,
    "warnings": 23
  },
  "checks": [ /* one CheckOutput per graph rule */ ],
  "durationMs": 7891
}
```

Each rule appears as a `CheckOutput` whose `checkSlug` is the graph rule slug (`graph:orphan-subtree`, `graph:duplicated-function-body`, `graph:no-side-effect-path`, `graph:test-only-reachable`, `graph:always-throws-branch`). Findings carry the same `FindingOutput` shape, and graph's SARIF renderer is a thin wrapper over fitness's `buildSarifLog` (DEC-3 cross-tool import) — no graph-specific extensions today. See the renderer at [`packages/graph/engine/src/render/json.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/graph/engine/src/render/json.ts) and the SARIF wrapper at [`packages/graph/engine/src/render/sarif.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/graph/engine/src/render/sarif.ts).

---

## Error result — `ErrorResult`

When a run fails before producing a result (config invalid, plugin failed to load, baseline missing), the JSON output is the error envelope rather than `CliOutput` / `SimDoneResult`:

```ts
{
  "error": "Gate baseline not found in the project SQLite store. Run `opensip-tools fit --gate-save` first to create one."
}
```

Exit code is 2 (configuration/runtime error) or whatever the throwing code specified.

---

## Compatibility commitments

- **Adding optional fields is a minor change.** A consumer that doesn't know about a new field continues to work.
- **Adding required fields is a major change.** This would break consumers that don't account for it.
- **Reordering keys is *not* a contract.** Consumers must parse, not pattern-match. In practice the renderer emits keys in declared order.
- **The `version: '1.0'` discriminator changes only on a major.** A `version: '2.0'` payload is allowed to break consumers expecting 1.0; they should switch on the version.

---

## Reading the output in CI

A few CI patterns:

```bash
# Fail on any violation:
opensip-tools fit --json | jq -e '.passed'

# Print only failed checks:
opensip-tools fit --json | jq '.checks | map(select(.passed == false))'

# Count errors by file:
opensip-tools fit --json | jq '.checks[].findings[] | select(.severity == "error") | .filePath' | sort | uniq -c

# Score gate:
opensip-tools fit --json | jq -e '.score >= 90'
```

For SARIF (the gate's native shape), use `--gate-save` / `--gate-compare`. The SARIF shape is the SARIF 2.1.0 spec's, not opensip-tools' — see [`10-concepts/05-architecture-gate.md`](/docs/opensip-tools/10-concepts/05-architecture-gate/).

---

## What's next

- **[`02-configuration.md`](/docs/opensip-tools/70-reference/02-configuration/)** — `opensip-tools.config.yml` schema (the *input* shape).
- **[`../10-concepts/04-contract-surfaces.md`](/docs/opensip-tools/10-concepts/04-contract-surfaces/)** — every contract surface, with stability tiers.
