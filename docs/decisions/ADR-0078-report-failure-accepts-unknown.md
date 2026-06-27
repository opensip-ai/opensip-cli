---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0078: reportFailure accepts unknown errors

```yaml
id: ADR-0078
title: reportFailure accepts unknown errors
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0060, ADR-0066, ADR-0077]
tags: [tools, errors, cli, contracts]
enforcement: mechanizable
enforcement-reason: >
  Template coherence tests typecheck the generated ts-local handler path, and
  report-failure unit tests cover ToolError, Error, and arbitrary thrown values.
```

**Decision:** `ToolCliContext.reportFailure(detail)` accepts
`detail.error: unknown`. The CLI composition root normalizes typed `ToolError`,
plain `Error`, strings, numbers, and object throwables into a bounded
customer-facing message, exit code, diagnostic, and log entry.

**Alternatives:**

- **Require `ToolError | Error`** - rejected; JavaScript can throw anything, and
  catch variables are `unknown` under strict TypeScript.
- **Force templates to cast caught errors** - rejected; the first generated
  TypeScript tool should model the safe path, not teach casts.
- **Stringify arbitrary objects unbounded** - rejected; logs and JSON failures
  need a fixed size ceiling.

**Rationale:** ADR-0077 created one failure-reporting seam, but the type was too
narrow for real handler code. Generated tools caught `unknown` and either had to
cast or fail to compile. The host is the correct normalization owner because it
already owns exit-code mapping, diagnostics, JSON error shape, and logging.

**Consequences:**

- Tool authors can pass a caught value directly: `await cli.reportFailure({ error })`.
- Typed `ToolError` still owns its exit-code policy through ADR-0066.
- Non-Error throwables become runtime errors with a bounded derived message.
- Templates must return after reporting a failure to avoid double rendering.

**Fitness check:** Covered by template typecheck tests and
`tool-engine-no-direct-stderr-command-errors`, which keeps command failures on
the `reportFailure` seam instead of direct stderr.
