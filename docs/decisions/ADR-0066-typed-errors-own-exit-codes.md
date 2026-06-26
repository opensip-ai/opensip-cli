---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0066: Typed errors own exit codes

```yaml
id: ADR-0066
title: Typed errors own exit codes
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0024]
tags: [cli, errors]
enforcement: not-mechanizable
enforcement-reason: >
  Behavior-level policy enforced by error-handler and exit-code unit tests;
  getErrorSuggestion is advice-only and no longer carries exitCode.
```

**Decision:** Only typed `ToolError` subclasses, Commander parse errors, and explicit `BootstrapError` values choose semantic non-runtime exit codes. `getErrorSuggestion` provides message/action advice for untyped errors; untyped errors always exit `RUNTIME_ERROR` (1).

**Alternatives:**
- Keep substring-derived untyped exits — rejected; `"Check not found: foo"` as a plain `Error` incorrectly exited 3.
- Delete suggestions entirely — rejected; actionable hints still help operators.
- Add a dogfood check for `suggestion.exitCode` reads — rejected; tests are sufficient and the field was removed.

**Rationale:** Split authority caused `handleParseError` and `outcomeFromError` to disagree on untyped errors. Typed `NotFoundError` maps to exit 3 via `mapToolErrorToExitCode`; coincidental substrings must not override that policy.

**Consequences:** `ErrorSuggestion` no longer includes `exitCode`. CLI boundary throws should use `ConfigurationError`, `NotFoundError`, or `ValidationError` when exit semantics matter.

**Fitness check:** No check warranted — `error-handler.test.ts`, `exit-codes.test.ts`, and `assemble-outcome.test.ts` lock the policy.

**Related specs / ADRs:** [ADR-0024](ADR-0024-command-outcome-and-observability.md).