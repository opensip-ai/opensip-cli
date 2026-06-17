---
status: active
last_verified: 2026-06-17
owner: opensip-cli
---

# ADR-0055: Core Kernel Sub-Boundaries

```yaml
id: ADR-0055
title: Core Kernel Sub-Boundaries
date: 2026-06-17
status: active
supersedes: []
superseded_by: null
related: [ADR-0007, ADR-0027, ADR-0037, ADR-0040, ADR-0052, ADR-0054]
tags: [core, layering, plugins, architecture]
enforcement: convention-plus-layering-rules
enforcement-reason: >
  dependency-cruiser and ESLint keep the package-level direction acyclic. The
  sub-boundaries inside @opensip-cli/core are documented ownership rules rather
  than independently publishable packages today.
```

**Decision:** `@opensip-cli/core` remains one publishable kernel package, but it
is treated as a set of explicit internal sub-boundaries:

- **Run kernel:** `RunScope`, diagnostics, logger interfaces, errors, IDs,
  timers, telemetry no-ops, project context, path resolution, and environment
  helpers.
- **Tool/plugin contract:** `Tool`, `CommandSpec`, manifest/provenance types,
  compatibility checks, manifest/runtime drift guards, and the generic
  registries/capability-registry primitives.
- **Discovery substrate:** marker/package discovery, sidecar discovery,
  package metadata readers, and plugin-layout helpers.
- **Language substrate:** the generic `LanguageAdapter` registry/contracts and
  parse-cache infrastructure; language-specific logic lives in `lang-*`.
- **Runtime transport:** subprocess/progress transport primitives shared by
  graph live workers and future worker-isolated tools.
- **Shared data contracts owned below tools:** signal primitives, fingerprint
  strategies, baseline helpers, recipe ids/config slots, and generic targeting
  interfaces.

The package is not a dumping ground: code entering core must either be needed by
multiple upper layers without naming any tool, or it must be the canonical
contract surface that tools implement. Tool-specific policy, host orchestration,
rendering, persistence repositories, config I/O, and package-manager workflows
must stay outside core.

**Rationale:** Core is broad because it is the trusted kernel all tools and many
substrates depend on. Splitting the documented sub-boundaries into more packages
would increase release-order and dependency-management friction across the
published package set without changing the current direction of knowledge:
upper layers would still need the same contracts. The useful architectural
control is therefore ownership and review scope inside core, backed by the
existing package-level acyclic rules.

**Extraction trigger:** create a new package only when a sub-boundary develops a
stable public surface and one of these conditions is true:

- it introduces a dependency that most core consumers should not inherit;
- it needs an independent compatibility policy or publish cadence;
- it becomes a source of review contention because unrelated kernel changes
  routinely touch the same files;
- moving it would remove a real dependency cycle or unblock ADR-0054 worker
  isolation without widening the trusted computing base.

`plugin-loader` is the most likely future candidate, but not until external
worker isolation defines the host/worker manifest and RPC contract. Extracting
it earlier would mostly shuffle files while preserving the same runtime trust
boundary.

**Consequences:**

- Contributors can reason about core changes by sub-boundary instead of treating
  `packages/core/src/index.ts` as one undifferentiated surface.
- Public exports from core should stay curated and documented; adding a new
  export should name the sub-boundary it belongs to.
- A broad core barrel is acceptable when it re-exports stable kernel contracts;
  it is not evidence by itself that a new package is warranted.
