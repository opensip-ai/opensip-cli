---
status: active
last_verified: 2026-06-28
owner: opensip-cli
---

# ADR-0087: Shelve public ecosystem readiness

```yaml
id: ADR-0087
title: Shelve public ecosystem readiness
date: 2026-06-28
status: active
supersedes: []
superseded_by: null
related: [ADR-0054, ADR-0061, ADR-0068, ADR-0074, ADR-0081, ADR-0082]
tags: [platform, trust, plugins, security, isolation]
enforcement: not-mechanizable
enforcement-reason: >
  This is a gated launch decision from the plan 03 Phase 0 feasibility memos. The
  enforcement action is to not implement or flip the public ecosystem posture
  until a future ADR records a proven network-capability mechanism.
```

**Decision:** Shelve the public untrusted third-party ecosystem launch. Keep
ADR-0061's interim private-extension posture in force because Phase 0 did not
produce a defensible, portable network enforcement mechanism for admitted
external tools or capability packs.

**Alternatives:**

- **Ship fs/child/worker permission flags now and defer network.** Rejected:
  Node v24.16.0 permission mode blocks filesystem, child-process, and worker
  APIs, but it does not block direct `node:net` sockets. Shipping that as a
  public sandbox would be a leaky capability model.
- **Use HTTP(S) proxy environment variables as the network gate.** Rejected:
  proxy variables are advisory and were bypassed by a raw `node:net` socket in
  the Phase 0 spike.
- **Use macOS `sandbox-exec` as the embedded enforcement mechanism.** Rejected:
  it denied local network on the spike host, but the command is deprecated and
  does not prove a supported Linux/Windows/macOS public ecosystem mechanism.
- **Open the public ecosystem with documentation warnings only.** Rejected:
  ADR-0061 requires capability/permission, versioning, and consumption-side
  verification gates before a public untrusted ecosystem opens.

**Rationale:** Plan 03 was intentionally gated. Its first spike treated network
capability enforcement as the make-or-break condition because Node has no
granular `--allow-net` permission and in-runtime monkey-patching is bypassable.
The spike confirmed the expected failure mode:

- `node --permission` denied filesystem, child-process, and worker operations
  with `ERR_ACCESS_DENIED`.
- The same mode still allowed a direct `node:net` loopback socket.
- Proxy env vars did not constrain raw sockets.
- macOS `sandbox-exec` could deny networking locally, but it is deprecated and no
  cross-platform backend was proven.

The versioning gate is largely shipped via ADR-0074, and consumption-side
verification remains governed by ADR-0068 as policy-only. Those facts do not
change the launch decision because a public untrusted ecosystem with direct
network egress would violate the core capability-isolation gate.

**Consequences:**

- Do not implement Plan 03 Phases 2 through 7 in this run.
- Do not author ADR-0088/ADR-0089 for production implementation from this plan
  run; those numbers remain available to the next accepted decisions unless a
  future branch uses them first.
- Do not flip ADR-0061's public ecosystem posture. The public untrusted
  ecosystem remains closed.
- Keep documenting external extensions as trusted/private extensions, with fault
  isolation only and full user privilege caveats.
- A future unshelving ADR must first name a bypass-resistant, supportable
  network mechanism for embedded and Cloud/SaaS modes.

**Fitness check:** No check warranted. The decision is a product/security launch
hold. Existing checks continue to enforce the current interim posture; future
unshelving work must add the mechanized checks required by its own ADR.

**Related specs / ADRs:** This records the shelving outcome for local plan
`docs/plans/ready/03-ecosystem-readiness/` and keeps ADR-0061 active.

