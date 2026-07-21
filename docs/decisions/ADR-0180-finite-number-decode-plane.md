---
status: active
last_verified: 2026-07-21
owner: opensip-cli
---

# ADR-0180: Finite-number guard on session decode and scalar projection

```yaml
id: ADR-0180
title: Finite-number guard on session decode and scalar projection
date: 2026-07-21
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0084, ADR-0175]
tags: [session-store, decode, json, mcp]
enforcement: mechanizable
enforced-by: ['script:session-payload-decode.test', 'script:json-scalars.test', 'script:list-summaries.test']
enforcement-reason: >
  Unit tests on each surface prove NaN/Infinity are rejected (required fields)
  or omitted (optional projection bags / session list summaries), mirroring the
  write plane's Number.isFinite admission.
```

**Decision:** Every **decode / project** surface that admits numbers from stored
or external JSON uses one shared finite-number guard
(`Number.isFinite` via core `isFiniteNumber`):

- **Required number fields** (summary counts, durationMs, required
  violationCount, …): **reject** (throw) when non-finite.
- **Optional numbers and scalar bags** (optional line/column, metadata values,
  repair confidence, list-summary projection): **omit** non-finite values
  (fail closed — never pass `NaN`/`Infinity` through to MCP, report, or
  `sessions list`).

The write plane already rejects non-finite numbers; decode mirrors that
contract so corrupted or hand-edited rows cannot reintroduce non-JSON numbers.

**Alternatives:**

- *Decode any `typeof === 'number'` (status quo).* Rejected: `NaN` and
  `±Infinity` survive into MCP replay, HTML report, and `sessions list`
  summaries; `JSON.stringify` turns them into `null`, silently changing
  meaning.
- *Sentinel-replace non-finite with `0` or `null` on required fields.*
  Rejected for structural counts: zeroing a corrupted `errors` count would
  green-wash a failed run. Reject-closed is safer.
- *Deep-walk every payload with a generic normalizer.* Rejected as the sole
  mechanism: ownership belongs at each typed decode/project boundary; a
  late global walk would hide which field failed.

**Rationale:** Session write validation (`isFiniteNumber` in
`write-shape-validation`) already fails closed. Decode used bare
`typeof x === 'number'`, so a corrupt SQLite row or hand-edited payload
could still deliver non-finite values on read. One core helper
(`isFiniteNumber` next to `projectJsonScalarMetadata`) is the single
admission predicate for both write-style checks and read projection.

**Consequences:**

- `@opensip-cli/core` exports `isFiniteNumber` from `json-scalars`.
- `session-payload-decode` uses it in `numberField` / `optionalNumber` /
  metadata / repair scalar decode.
- `projectJsonScalarMetadata` drops non-finite numbers.
- `listSessionSummaries` / `sessionSummary` requires finite summary counts
  (otherwise omit the summary projection).
- Tests on each surface fail on `main` (non-finite pass through) and pass
  after this change.
