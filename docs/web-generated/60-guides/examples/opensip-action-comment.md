<!-- opensip-cli-review-brief -->
## OpenSIP review: FAIL

Issues: 2 total, 1 new
Baseline: unavailable (1 new, 0 resolved)

### Top risks
- **high** `no-console-log` src/index.ts:3 - Console logging should not ship in production code.
- **medium** `high-blast-untested` src/service.ts:42 - Changed function has broad downstream reach without matching tests.

### Degraded evidence
- baseline-unavailable

<details><summary>Raw top-risk details</summary>

```json
[
  {
    "source": "fitness",
    "ruleId": "no-console-log",
    "message": "Console logging should not ship in production code.",
    "severity": "high",
    "file": "src/index.ts",
    "line": 3,
    "column": 2,
    "isNew": true,
    "signalRef": {
      "tool": "fitness",
      "suiteRunId": "example",
      "stepIndex": 0,
      "signalIndex": 0
    }
  },
  {
    "source": "graph",
    "ruleId": "high-blast-untested",
    "message": "Changed function has broad downstream reach without matching tests.",
    "severity": "medium",
    "file": "src/service.ts",
    "line": 42,
    "column": 0,
    "isNew": false,
    "signalRef": {
      "tool": "graph",
      "suiteRunId": "example",
      "stepIndex": 1,
      "signalIndex": 0
    }
  }
]
```

</details>
