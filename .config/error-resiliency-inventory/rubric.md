# Error And Resiliency Inventory Rubric

**Rubric version:** `1.0.0`  
**Schema version:** `1`  
**Status:** authoritative for Plan 00 pre- and post-infrastructure inventory

## Purpose

This rubric tells reviewers how to classify files and error/resiliency sites so two independent full-file reviews produce comparable evidence. Search and graph tools may guide attention; they never substitute for reading the frozen blob.

## File classifications

Assign exactly one classification **before** exclusions:

| Classification | Meaning |
|---|---|
| `production` | Runtime source that ships or executes in product paths |
| `runtime-asset` | Non-TS/JS assets loaded at runtime (wasm, grammars, templates) |
| `manifest-build` | package.json, tsconfig, build scripts, tooling config |
| `test` | Unit/integration tests and test helpers |
| `fixture` | Fixture trees under `__fixtures__` / similar |
| `generated` | Generated committed artifacts (must not be hand-edited) |
| `docs` | Markdown and human documentation |
| `excluded` | Explicitly out of inventory with a recorded reason |

`excluded` always requires `exclusionReason`. Vendor copies and pure lockfiles are typical exclusions.

## Site kinds

Record a site when the file constructs, classifies, propagates, retries, times out, cancels, redacts, logs, serializes, presents, or cleans up failures — or when it is a deliberate absence of responsibility (`no-error-resiliency-responsibility` at file level with no sites).

| Kind | Examples |
|---|---|
| `error-definition` | Catalog / definition declarations |
| `error-construction` | `new ToolError`, `defineError`, typed constructors |
| `throw` | `throw` of any value |
| `catch` | `catch` / rejection handlers |
| `retry` | retry loops, backoff, `withRetry` |
| `timer` | `setTimeout` / `setInterval` used for deadlines or backoff |
| `signal-listener` | `AbortSignal`, SIGINT/SIGTERM listeners |
| `fallback` | silent defaults, swallow markers, degraded paths |
| `worker-boundary` | worker IPC error messages, failureClass, process exits |
| `redaction` | secret scrubbing, safe metadata projection |
| `logging` | structured failure logs |
| `timeout` | deadline / timeout enforcement |
| `cancellation` | cooperative cancel, abort propagation |
| `cleanup` | finally / dispose after failure |
| `presentation` | human error rendering, action hints |
| `serialization` | JSON/worker wire failure shapes |
| `human-flow` | multi-file flow site owned by a horizontal audit |

## Dispositions

Every file and every site closes with exactly one disposition:

| Disposition | Use when |
|---|---|
| `migrate` | Must move onto registered definitions / envelope / policy |
| `already-conformant` | Already matches the target model |
| `retain-internal-invariant` | Internal `throw new Error` OK if enclosing boundary normalizes |
| `normalize-at-enclosing-boundary` | Fix lives at the public/host boundary, not this site |
| `remove-obsolete-path` | Dead or superseded failure path |
| `no-error-resiliency-responsibility` | File has no error/resiliency duty |
| `excluded-generated-or-vendor` | Generated/vendor content |
| `needs-decision` | Temporary only; **forbidden** in accepted C4/C5 snapshots |

## Orthogonal axes (for design notes, not free text)

When recording semantics, separate:

- **failure source:** application | infrastructure | external  
- **default responsibility:** user | tool-author | operator | environment | unknown  
- **kind:** validation | not-found | conflict | permission | integrity | invariant | I/O | network | timeout | cancelled | resource | compatibility | security  
- **retry:** never | transient | caller-policy  
- **severity:** warning | error | fatal (execution severity — not `SignalSeverity` or `runOutcome`)  
- **exposure:** public | redacted | operator-only  

Do not infer axes from class names or message substrings.

## Mechanical vs human sites

- **Structural** sites come from the TypeScript/JavaScript detector (`source: structural`). Their `siteId` is derived from path + detector version + kind + structural fingerprint. Line/column are navigation only.
- **Human** sites (`source: human`) cover flows and languages without structural coverage. IDs are reviewer-owned and must not be advertised as CI-rediscoverable.

## Review completeness

A production file is complete only when:

1. Primary and blind secondary reviewers each assert `fullFileRead: true` against the frozen blob OID.
2. Both submit schema-valid evidence.
3. Disagreements are adjudicated and recorded (not silently averaged).

“No search hits” is not “no responsibility.” Read the whole file.

## Boundary families (horizontal audits)

Named families required by Plan 00:

- `cli-failure-reporting`
- `worker-ipc-process`
- `filesystem-datastore`
- `http-egress-retry`
- `external-scanner-lifecycle`
- `mcp-stdio-transport`
- `cancellation-timeout`
- `logging-redaction-telemetry`
- `plugin-trust-compatibility`
- `release-init`

## Risk

| Risk | Guidance |
|---|---|
| `critical` | Process edge, secrets, wrong exit/runOutcome, worker crash surface |
| `high` | Cross-package normalization loss, retry amplification, public leakage |
| `medium` | Local classification inconsistency, incomplete metadata |
| `low` | Cosmetic or already-normalized presentation |

## Forbidden reviewer behavior

- Inventing new taxonomy axes without C3
- Editing product source during inventory
- Sharing primary conclusions with secondaries before dual submit
- Claiming structural completeness for human-review-only languages
- Accepting `needs-decision` at C4/C5

## Rubric change control

Bump `rubricVersion` (semver) when classification rules change. Evidence produced under a superseded rubric is invalid for C4/C5 until re-reviewed.
