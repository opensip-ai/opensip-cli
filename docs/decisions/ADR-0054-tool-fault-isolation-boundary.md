---
status: active
last_verified: 2026-06-16
owner: opensip-cli
---

# ADR-0054: External Tool Fault-Isolation Boundary

```yaml
id: ADR-0054
title: External Tool Fault-Isolation Boundary
date: 2026-06-16
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0027, ADR-0028, ADR-0029, ADR-0030, ADR-0052]
tags: [tools, plugins, isolation, cli, architecture, config, saas]
enforcement: partially-mechanizable
enforcement-reason: >
  The graph live worker tests mechanize the first first-party application of the
  worker primitive: exact and sharded live engines run outside the Ink render
  process. The external-tool boundary is not enforced repo-wide yet. Its future
  capstone invariant is mechanizable: no external-provenance tool runtime may be
  imported in the host process. Add a fitness check / bootstrap test that rejects
  `importToolRuntime(...)` on installed, project-local, or user-global tool paths
  outside the worker-owned dispatch plane.
```

**Decision:** External-provenance tool runtime code must not load or execute in
the CLI host process. The host may read static manifests as data; tool runtime
modules, command handlers, lifecycle hooks, deep config validation, and
capability registrars execute in a worker process behind a structured IPC
protocol. Bundled first-party tools are the trusted computing base and may keep
in-process execution for compatibility and development.

This ADR records the platform boundary and migration contract. It does not claim
that external-tool sandboxing has already landed.

**Alternatives:**

- *Keep importing admitted external tool runtimes in the host and rely on
  ToolCliContext seams.* Rejected: seams are a syscall vocabulary, not a syscall
  boundary. A runtime import can run top-level code before any seam exists, and
  in-process code can still call `process.exit`, spin the event loop, mutate
  globals, or crash native code.
- *Use lint, fitness checks, and runtime guards as the boundary.* Rejected:
  those protect cooperating first-party source. They do not constrain compiled
  JavaScript loaded from npm, a user-global tool, or a project-local sidecar.
- *Worker-isolate command handlers but keep host-side Zod composition for
  third-party config.* Rejected: arbitrary Zod schemas are executable code
  (refinements, transforms, closures). Composing them in the host reintroduces
  the load-time hole under a config label.
- *Treat user-global tools as trusted because the user installed them.* Rejected:
  user intent authorizes running code, not sharing the kernel process. Trust is
  provenance of code, not provenance of intent.
- *Worker threads or `vm` contexts as the boundary.* Rejected for the same reason
  ADR-0028 rejected them for live engines: they do not provide an OS process
  failure boundary, and they cannot contain `process.exit`, native crashes, OOM,
  or CPU-bound infinite loops.

**Rationale:** opensip-cli already has the shape of the boundary but not the hard
trap. Static manifests are explicitly designed so the host can inspect tool
identity, command names, compatibility epoch, and declared capabilities without
importing the runtime module. Today, registration still imports admitted runtime
modules in the host to obtain `commandSpecs`, lifecycle hooks, config Zod blocks,
capability registrars, report/session hooks, and command handlers. That means an
external tool can still kill or freeze the CLI before the host-owned seams can
mediate anything.

ADR-0028 provides the required primitive: a forked CLI worker re-enters normal
bootstrap, streams progress over IPC, returns a slim serializable result, and
turns child failure into structured parent-side failure. Extending the graph live
worker path to sharded runs validates that primitive on a first-party coordinator
workload: the render parent becomes a pure renderer/supervisor, while the worker
owns both the shard pool and the synchronous coordinator work.

**Current implementation scope:** The change that introduces this ADR applies
the worker primitive to first-party graph live rendering only. It moves sharded
live graph coordination out of the Ink render process; it does not remove
host-side `importToolRuntime(...)` for external tools, migrate external config or
tool command execution behind worker IPC, or claim sandboxing for installed /
authored Tool packages. It also does not move capability discovery or lifecycle
hooks behind worker RPC, or disable unsafe in-process fallback for external
provenance. Those are the migration workstreams below.

**2026-06-17 transition guard:** until the manifest/RPC contract can carry
executable command specs across a worker boundary, host-side runtime imports are
still required for admitted tools. The host now requires an explicit
`hostRuntimeImportPolicyFor(source)` policy at every `importToolRuntime` call,
and the `host-tool-runtime-import-boundary` fitness check confines those calls
to the admission/discovery boundary. This is a staging guardrail, not the final
fault-isolation boundary.

**Config semantics:** Config validation is a two-pass contract.

- The host performs a coarse, serializable manifest-declared pass before fork.
  This pass is authoritative for namespace ownership, top-level block presence,
  unknown keys, primitive types, and docs/init scaffolding. JSON Schema-shaped
  descriptors are the intended currency.
- The worker performs tool-owned deep validation after runtime load. This pass is
  authoritative for semantic constraints, cross-field rules, refinements, and
  transforms. Failure crosses IPC as a tool/config error; it must never crash the
  host.

**Trust tiers:** Bundled first-party tools are kernel modules: they are part of
the trusted computing base and may keep in-process execution or the
`OPENSIP_CLI_NO_WORKER` fallback for development and compatibility. Installed,
project-local, and user-global tools are userspace: they run out-of-process by
default, and the unsafe in-process fallback must not apply to them unless a
future explicit developer-only override says so in its name and warning text.

**Consequences:**

- Manifest-first discovery becomes the host contract. The host reads manifests
  and static descriptors; it does not import external runtime code to discover
  commands, config, dashboards, sessions, or capability domains.
- Command metadata and command bodies split cleanly. The manifest carries the
  command shell (`name`, description, aliases, flags/args/output metadata once
  that descriptor is added); the worker loads the runtime command handler.
- ToolCliContext becomes the syscall/RPC surface. Privileged effects such as
  rendering, JSON output, SARIF writes, signal delivery, diagnostics, session
  contribution, baselines, and datastore-mediated host planes cross as structured
  requests or final results. The host remains the only process that performs the
  privileged effect.
- Lifecycle hooks move worker-side for external tools. `initialize`,
  `contributeScope`, `collectReportData`, `sessionReplay`,
  `fingerprintStrategy`, and `capabilityRegistrars` must either become
  serializable manifest declarations, worker-executed code whose effects return
  over IPC, or bundled-only host hooks.
- The external in-host import can be deleted only after the last host consumer of
  the runtime object has migrated. The capstone invariant is: no
  `importToolRuntime(...)` for external-provenance tools in the host process.
- Resource control belongs to the supervisor: wall-clock timeout, cancellation,
  heartbeat, max IPC payload size, max captured output, and child process memory
  limits should be enforced by the host-owned worker plane.

**Migration workstreams:**

- Command shells: lift the host-mounted `CommandSpec` shell into a serializable
  manifest descriptor while keeping handlers worker-owned.
- Config: add manifest-declared structural descriptors and route semantic
  validation through worker IPC.
- Capabilities and lifecycle: replace host-side runtime hook execution for
  external tools with manifest data or worker RPC results.
- Guardrails: add a bootstrap test and fitness check for the capstone invariant,
  then make `OPENSIP_CLI_NO_WORKER` first-party-only by default.

**Related specs / ADRs:** Generalizes the ADR-0028 worker transport into the
target tool fault-isolation primitive. Interacts with ADR-0023 config
composition, ADR-0027 parity, ADR-0029 capability discovery, ADR-0030 authored
tool discovery, and ADR-0052 bootstrap sequencing.
