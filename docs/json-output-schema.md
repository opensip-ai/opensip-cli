# JSON Output Schema (v1.0)

The `--json` flag produces structured output on stdout. Both `fit` and
`sim` honor it; the shape per tool is below.

## fit (fitness checks)

| Field | Type | Description |
|-------|------|-------------|
| version | `"1.0"` | Schema version (breaking changes bump this) |
| tool | `"fit"` | Which tool produced the output |
| timestamp | string (ISO 8601) | When the run started |
| recipe | string? | Recipe name (if applicable) |
| score | number (0-100) | Pass percentage |
| passed | boolean | Whether the run passed |
| summary.total | number | Total checks run |
| summary.passed | number | Checks that passed |
| summary.failed | number | Checks that failed |
| summary.errors | number | Total error-level findings |
| summary.warnings | number | Total warning-level findings |
| checks[] | array | Per-check results |
| checks[].checkSlug | string | Check identifier |
| checks[].passed | boolean | Whether this check passed |
| checks[].findings[] | array | Violation details |
| checks[].findings[].ruleId | string | Rule that triggered |
| checks[].findings[].message | string | Human-readable description |
| checks[].findings[].severity | `"error" \| "warning"` | Finding severity |
| checks[].findings[].filePath | string? | File path |
| checks[].findings[].line | number? | Line number |
| checks[].findings[].column | number? | Column number |
| checks[].findings[].suggestion | string? | Fix suggestion |
| checks[].durationMs | number | Check execution time in ms |
| durationMs | number | Total run time in ms |

Exit code: 0 if `passed` is true, 1 otherwise (subject to
`fitness.failOnErrors` / `fitness.failOnWarnings` thresholds in
`opensip-tools.config.yml`).

## sim (simulation recipes)

| Field | Type | Description |
|-------|------|-------------|
| type | `"sim-done"` | Result kind |
| recipeName | string | Recipe that ran (e.g. `"default"`, `"example"`) |
| cwd | string | Project root |
| totalScenarios | number | Scenarios the recipe matched |
| passedScenarios | number | Scenarios that completed without error |
| failedScenarios | number | Scenarios that errored or asserted false |
| scenarios[] | array | Per-scenario results |
| scenarios[].scenarioId | string | Scenario identifier |
| scenarios[].scenarioName | string | Display name |
| scenarios[].kind | `"load" \| "chaos" \| "invariant" \| "fix-evaluation"` | Scenario type |
| scenarios[].passed | boolean | Whether this scenario passed |
| scenarios[].durationMs | number | Scenario execution time in ms |
| scenarios[].error | string? | Error message if the scenario failed |
| durationMs | number | Total run time in ms |

Exit code: 0 if every scenario passed, 1 if any failed, 2 on
configuration errors (unknown recipe, missing config).
