---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0070: Telemetry and outbound network posture

```yaml
id: ADR-0070
title: Telemetry and outbound network posture
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0004, ADR-0008, ADR-0073]
tags: [privacy, telemetry, outbound]
enforcement: not-mechanizable
enforcement-reason: >
  Existing env-surface/update-notifier tests cover invariants; no new structural
  fitness check required beyond docs coherence tests.
```

**Decision:** Consolidate outbound posture: **OpenTelemetry stays opt-in** via
`OTEL_EXPORTER_OTLP_ENDPOINT` (ADR-0004 unchanged); **cloud sync** is API-key and
entitlement gated (ADR-0008); **update notifications** follow ADR-0073; **no**
source contents, credentials, or registry tokens in telemetry, logs, cloud payloads,
or update-state files without explicit user consent.

**Alternatives:**
- No outbound by default including update checks — rejected; product update I/O is
  distinct from telemetry and remains default-on TTY per ADR-0073.
- Always-on OTel — rejected; local-first CLI must pay zero observability tax.

**Rationale:** Enterprise operators need one answer for "does this phone home?" without
reading source. Separating product update I/O from telemetry avoids conflating
opt-in tracing with version checks.

**Consequences:** Public FAQ, cloud-sync doc, and env reference cross-link ADR-0070
and ADR-0073.

**Fitness check:** No check warranted — existing `host-env-specs` / update-notifier
tests plus `policy-governance-docs.test.mjs` cover the documented surface.