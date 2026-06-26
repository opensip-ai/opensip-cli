---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0072: i18n posture

```yaml
id: ADR-0072
title: i18n posture
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: []
tags: [i18n, localization]
enforcement: not-mechanizable
enforcement-reason: >
  Explicit deferral — no extraction catalog or locale runtime to enforce.
```

**Decision:** **Defer localization.** CLI and docs remain **English-only**. Programming-language
adapters are unrelated to UI localization. Revisit when an enterprise contract requires
translated CLI, a maintained docs translation process exists, or a UI string extraction
owner is named.

**Alternatives:**
- Docs-only translation — deferred until a translation process owner exists.
- Full UI string extraction now — rejected; no product demand justified the cost.

**Rationale:** "Language" docs in this repo refer to source-code adapters, not locales.
Building i18n infrastructure without a driver creates dead weight.

**Consequences:** FAQ states English-only posture. No i18n dependencies or message
catalogs in this plan.

**Fitness check:** No check warranted — deferred posture; docs coherence test only.