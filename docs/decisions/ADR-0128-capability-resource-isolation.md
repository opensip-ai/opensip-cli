---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0128: Capability resource isolation

```yaml
id: ADR-0128
title: Capability resource isolation
date: 2026-07-02
status: active
supersedes: [ADR-0081]
superseded_by: null
related: [ADR-0054, ADR-0061, ADR-0074, ADR-0081, ADR-0126]
tags: [plugins, capability-packs, isolation, trust-policy]
enforcement: mechanizable
enforcement-reason: >
  opensip-cli/fit/checks/no-host-external-capability-pack-execution.mjs guards
  the CLI/core bypass points: capability loads must wire the isolated
  contribution loader, policy must return a resource decision, worker-admitted
  packs must not fall through to host import, and default admission is
  fail-closed for external packs.
```

**Decision:** Non-bundled capability packs (`fit-pack`, `sim-pack`, and
`graph-adapter`) run through resource-bounded worker bridges after trust-policy
admission. Bundled first-party capability packs may still run in the host. The
policy plane returns a `resourceDecision` for every allowed capability-pack load:
`host` only for bundled first-party packages, `worker` for all external packages,
the normalized manifest `opensipTools.requires` list, and
`denyUndeclared: true`.

**Alternatives:**

- **Keep `opensipTools.requires` declaration-only.** Rejected because policy
  admission without execution isolation still lets trusted external packs run
  arbitrary host code.
- **Let each tool invent its own isolation model.** Rejected because fit, sim,
  and graph would drift and the CLI would not have one auditable enforcement
  point.
- **Run every pack, including bundled first-party packs, in workers.** Rejected
  for this step because bundled packs are part of the CLI trust base and moving
  them all would add startup and serialization churn without closing the
  external-code gap.
- **Block all external capability packs until OS sandboxing exists.** Rejected
  because project-local/private packs are an existing extension path. The worker
  boundary is a deterministic guardrail and fault boundary; stronger OS-level
  sandboxing can be layered later without changing the manifest contract.

**Rationale:** ADR-0126 centralized executable-load admission in the local trust
policy plane, but admission alone did not change where capability-pack code
executed. The old path could dynamically import an admitted external pack in the
host process. This ADR connects admission to execution: the CLI reads package
resource declarations from `package.json#opensipTools` before import, asks the
policy plane for a resource decision, and routes worker decisions through a
tool-owned `CapabilityIsolationBridge`. The bridge creates host-side proxy
contributions while real pack code runs in the hidden
`__capability-pack-worker` command.

**Consequences:**

- External fit checks, sim scenarios, and graph adapters are represented in the
  host as proxies. Invoking the proxy sends a bounded worker request.
- Worker child environments forward only the documented worker baseline plus
  manifest-declared `env` scopes. `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH` is ignored
  for capability workers.
- Worker guards deny undeclared network/subprocess access and constrain
  undeclared filesystem access to the project/package roots. This is a
  best-effort Node worker guard, not a kernel sandbox.
- Graph adapter methods now allow async returns so worker-backed adapters can
  proxy discovery, parse, walk, cache-key, and resolution work.
- Missing or invalid `opensipTools.requires` denies the package before import.
  Missing isolation bridges produce diagnostics instead of falling back to host
  import.

**Fitness check:** Check warranted —
`opensip-cli/fit/checks/no-host-external-capability-pack-execution.mjs`.

**Related specs / ADRs:** Implements
`docs/plans/completed/10-capability-resource-isolation.md` through the ready plan
under `docs/plans/ready/capability-resource-isolation/`. Supersedes the
declaration-only resource posture of
[ADR-0081](./ADR-0081-capability-pack-trust-and-resource-declarations.md) while
building on the worker-fault boundary in [ADR-0054](./ADR-0054-tool-fault-isolation-boundary.md)
and local trust policy plane in
[ADR-0126](./ADR-0126-cli-local-trust-policy-plane.md).
