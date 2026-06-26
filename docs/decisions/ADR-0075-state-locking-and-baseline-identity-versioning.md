---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0075: State Locking and Baseline Identity Versioning

```yaml
id: ADR-0075
title: State locking and baseline identity versioning
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0036, ADR-0050, ADR-0060]
tags: [state, concurrency, baseline, observability]
enforcement: mechanizable
enforcement-reason: >
  baseline-identity-metadata.mjs, state-locking-policy.mjs, baseline-repo tests, file-lock tests.
```

**Decision:** Persist baseline fingerprint strategy `{id, version}` in generic baseline meta;
stamp `baselineIdentity` on every `SignalEnvelope`; guard datastore writes with a
datastore-file write lock and artifact exports with per-target locks plus atomic rename;
expose lock timing via `OPENSIP_STATE_LOCK_*` env specs.

**Alternatives:** Project-wide lock (rejected — over-serializes); per-row locks (rejected —
complexity); SQLite busy-timeout only (rejected — no stale-lock policy or diagnostics).

**Rationale:** Concurrent CLI invocations share one SQLite file; WAL alone does not define
stale-lock recovery or CI fail-fast behavior. Baseline compare must know which fingerprint
strategy produced stored identities (outside ADR-0050 payload scope).

**Consequences:** Incompatible baseline identity requires `--gate-save` recapture; lockfiles
must not contain secrets; OTel remains opt-in.

**Fitness checks:** `baseline-identity-metadata`, `state-locking-policy`.

**Related specs:** `docs/internal/state-observability-contract.md`, Plan 04.