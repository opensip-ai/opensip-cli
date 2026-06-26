---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0068: Consumption-side verification policy

```yaml
id: ADR-0068
title: Consumption-side verification policy
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0061, ADR-0012]
tags: [trust, supply-chain, plugins]
enforcement: not-mechanizable
enforcement-reason: >
  Policy-only until spec 03 implements loader enforcement; docs/script tests
  prevent overclaiming active enforcement.
```

**Decision:** Define consumption-side provenance verification for non-bundled npm
packages as **install/sync + load** checks in enterprise strict mode: bundled
first-party packages remain trusted TCB (release provenance); non-bundled packages
require allowlist admission plus acceptable provenance or an approved exception;
missing/mismatched provenance **denies** in strict mode and **warns** in default
mode; authored project-local code has no npm provenance and requires explicit
admission. **Do not implement enforcement** in this plan — spec 03 owns the loader
gates.

**Alternatives:**
- Verify at install/sync only — rejected; load-time re-check catches registry swaps.
- Verify at load time only — rejected; install-time feedback is earlier for operators.
- No policy until implementation — rejected; enterprise rollout needs explicit posture.

**Rationale:** ADR-0061 names consumption-side verification as a launch gate.
Producer provenance already ships (`release.yml` OIDC + `--provenance`). The gap is
consumer trust at install/load for third-party tools and capability packs.

**Consequences:** `docs/internal/plugin-isolation-surface.md` carries the inventory
and strict-mode matrix. Public docs must not claim enforcement is active until spec
03 lands.

**Fitness check:** No check warranted — policy-only until spec 03 implements
loader/docs wiring; `scripts/__tests__/policy-governance-docs.test.mjs` guards
against overclaiming enforcement.