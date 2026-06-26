---
status: superseded
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0047: Per-Tool Contract Versioning

```yaml
id: ADR-0047
title: Per-Tool Contract Versioning
date: 2026-06-12
status: superseded
supersedes: []
superseded_by: ADR-0074
related: [ADR-0046, ADR-0027, ADR-0012, ADR-0023]
tags: [tool-contract, versioning, plugins, fitness, graph, simulation, compatibility, architecture]
enforcement: mechanizable
enforcement-reason: >
  Each tool's engine exports its own FOO_CONTRACT_VERSION constant.
  The tool's Tool descriptor declares it under extensionPoints (or a dedicated
  tool-specific slot). A small per-tool architecture fitness check (e.g.
  fitness-contract-version-policy) plus the core tool-contract-version-policy
  (updated) enforce the documentation/ADR reference obligation when any of
  these constants change. The core TOOL_CONTRACT_VERSION (ADR-0046) remains
  the bus-level marker.
```

**Decision:** Introduce independent contract versions for each tool's rich surface (`FITNESS_CONTRACT_VERSION`, `GRAPH_CONTRACT_VERSION`, `SIMULATION_CONTRACT_VERSION`, etc.), separate from the core `TOOL_CONTRACT_VERSION` (ADR-0046).

- Core `TOOL_CONTRACT_VERSION` covers only the generic `Tool` interface / dispatcher surface / `ToolExtensionPoints` bag / `ToolCliContext` seams.
- Each tool owns and exports its own `*CONTRACT_VERSION` for its domain-specific contract (defineCheck + check packs + recipes for fitness; rules + catalog + execution model for graph; scenarios + recipes for simulation).
- The tool's `Tool` object declares the per-tool version via `extensionPoints` (or a lightweight dedicated sub-object) so it is discoverable by the host, by `agent-catalog`, by compatibility logic, and by external tool authors.
- Per-tool versions follow the same bumping rules as the core contract (only on actual semantic/surface changes; value = major.minor of the CLI release that ships the change) and are documented in their own (or sectional) ADRs.

**Alternatives:**
- Single version for everything under the Tool contract (rejected: couples unrelated surfaces; a fitness check API change would appear to be a core Tool contract change, increasing noise and forcing unnecessary bumps for graph/sim authors).
- Put per-tool versions directly on the top-level `Tool` interface (rejected: bloats the "one cohesive interface" that every tool implements; violates the evolution rule established in ADR-0046 and the `ToolExtensionPoints` design).
- Version only the core and leave per-tool surfaces unversioned (rejected: third-party fitness check packs, graph rule authors, etc. have no stable signal for compatibility; makes independent ratcheting impossible).

**Rationale:** The `Tool` contract is deliberately narrow and stable (the "bus"). The real surface area and evolution velocity lives inside the individual tools. Fitness already has a large, independently evolving API (`defineCheck`, three analysis modes, check packs, recipe semantics, etc.). Graph has its rule shape, catalog, selection/execution invariants, etc. Simulation has scenarios. Treating these as peer contracts under the Tool umbrella gives:

- Finer-grained compatibility for tool authors and pack authors.
- The ability to evolve one tool's surface without "polluting" the core Tool contract version or the other tools.
- Consistent policy and tooling (ADRs + JSDoc + fitness architecture checks) across all contract surfaces.
- Better alignment with the "tools are peers" model (each tool contributes its own `contributeScope` slot, its own `fingerprintStrategy`, its own `sessionReplay`, its own capability domains, etc.).

This is a direct extension of the pattern already used for `PLUGIN_API_VERSION` (manifest) vs. the runtime `Tool` shape (ADR-0027), and for the host-owned planes (ADR-0042 / hygiene work).

**Consequences:**
- New exported constants (e.g. `FITNESS_CONTRACT_VERSION`) from each tool's engine barrel.
- The `fitnessTool` (and siblings) will declare the per-tool version in `extensionPoints` (or a small dedicated bag).
- Each tool gets (or shares) a lightweight architecture check that enforces the ADR-0046-style documentation obligation when *its* contract version changes.
- Public docs (tool-plugin-model, full-tool-plugins, contract-surfaces) must describe both the core contract version and the per-tool versions.
- Tool authors extending a specific tool (e.g. a custom fitness check pack) now have a first-class version to pin against.
- The core `TOOL_CONTRACT_VERSION` changes even less often.

**Related specs / ADRs:**
- Builds directly on ADR-0046 (core Tool contract versioning).
- Will drive small follow-up ADRs or sections per tool (e.g. "Fitness Check API Versioning").
- Implementation sketch lives in the fitness engine `tool.ts` and a new (or extended) fitness architecture check.
