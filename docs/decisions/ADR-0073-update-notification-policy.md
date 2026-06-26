---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0073: Update notification policy

```yaml
id: ADR-0073
title: Update notification policy
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0070]
tags: [cli, privacy, updates]
enforcement: mechanizable
enforcement-reason: >
  update-notifier and host-env-specs tests cover opt-outs and sticky state shape.
```

**Decision:** Keep **default-on TTY** npm update checks with **opt-out** via
`OPENSIP_NO_UPDATE` / `NO_UPDATE_NOTIFIER`, CI, and non-TTY suppression. Hourly
detection interval (`UPDATE_CHECK_INTERVAL_MS`). Update-state stores **only**
`{ latest }` — no user identifiers, paths, or credentials. This is product update
I/O, not telemetry (ADR-0070).

**Alternatives:**
- Explicit opt-in (`OPENSIP_UPDATE_CHECK=1`) — rejected; breaks discoverability of
  security fixes for interactive users.
- Remove update checks — rejected; version awareness is a core CLI affordance.

**Rationale:** Non-blocking detached fetch costs little; sticky notice helps users
upgrade. Enterprise disable remains one env var away.

**Consequences:** Public command and env docs match hourly interval and opt-outs.

**Fitness check:** Check warranted — `update-notifier.test.ts` and
`host-env-specs.test.ts`; no separate fitness check required.