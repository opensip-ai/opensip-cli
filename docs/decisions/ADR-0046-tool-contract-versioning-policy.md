---
status: active
last_verified: 2026-06-12
owner: opensip-cli
---

# ADR-0046: Tool Contract Versioning Policy

```yaml
id: ADR-0046
title: Tool Contract Versioning Policy
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0012, ADR-0027, ADR-0038]
tags: [tool-contract, versioning, plugins, compatibility, architecture]
enforcement: mechanizable
enforcement-reason: >
  A dedicated fitness check (`tool-contract-version-policy` in
  checks-universal/architecture) plus the requirement that changes to
  `TOOL_CONTRACT_VERSION` must be accompanied by an update to this ADR
  (or a superseding ADR) and an update to the JSDoc on the constant itself.
```

**Decision:** `TOOL_CONTRACT_VERSION` (exported from `@opensip-cli/core`) is bumped **only** when the shape or documented semantics of the `Tool` interface (or its `ToolExtensionPoints` contract) actually change in a way that could affect tool authors. When a contract change ships, the new value is set to the major.minor of the CLI release in which the change is first released (e.g. a breaking contract change released in CLI v1.2.0 results in `TOOL_CONTRACT_VERSION = '1.2'`). The constant remains at its previous value across releases that do not touch the Tool contract.

**Alternatives:**
- Bump the contract version on every CLI minor release (rejected: produces noisy versions with no actual contract delta; defeats the purpose of a separate stability marker for tool authors).
- Keep an independent contract semver that never aligns with CLI versions (rejected: makes it harder for humans and tooling to correlate "which CLI introduced the contract change I care about").
- Treat `contractVersion` as a free-form string with no policy (rejected: invites drift and makes compatibility reasoning impossible).

**Rationale:** The `Tool` interface is the single cohesive contract that every tool (bundled or third-party) implements (see the file-length ignore comment and JSDoc in `packages/core/src/tools/types.ts`). Most CLI releases do not mutate this contract. Tool authors need a stable, low-churn signal for "the contract I wrote against is still the one the host expects." Aligning the contract version number with the CLI release *only at the moment of an actual change* gives the best of both worlds: easy correlation with release notes + truthful "no change" signals across intervening releases. This is consistent with how `PLUGIN_API_VERSION` works for the manifest gate (ADR-0027) and the general release-gate and dogfood philosophy (ADR-0012, ADR-0017, ADR-0020).

The `extensionPoints` bag (and the explicit rule to prefer it over new top-level members) remains the primary evolution mechanism; `contractVersion` is only a marker.

**Consequences:**
- Tool authors can safely pin `contractVersion: TOOL_CONTRACT_VERSION` (or a string literal) and know that an unchanged value means their implementation surface has not been altered by the host.
- Any change to the value of `TOOL_CONTRACT_VERSION` in source now requires:
  - An update (or new superseding ADR) documenting the exact contract delta.
  - An update to the JSDoc on the constant itself.
  - The fitness check `tool-contract-version-policy` will flag the source if the policy comment/ADR reference is missing or malformed.
- The constant will frequently lag the CLI version (e.g. stay at '1.0' through v1.1.0, v1.1.5, etc.) — this is intentional and must be documented in release notes when relevant.
- Future compatibility logic (in the plugin loader, `compatibility.ts`, or host planes) can key off this value without being coupled to full CLI semver.

**Related specs / ADRs:**
- This ADR formalizes the lightweight future-proofing introduced when `TOOL_CONTRACT_VERSION` was first added (see hygiene work around ADR-0042 / host planes and the Tool contract surface).
- Implementation: fitness check in `packages/fitness/checks-universal/src/checks/architecture/tool-contract-version-policy.ts`, JSDoc updates in `packages/core/src/tools/types.ts`, and this ADR itself.
