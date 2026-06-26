---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0074: Open Domain Contract Versions and Compatibility Epochs

```yaml
id: ADR-0074
title: Open Domain Contract Versions and Compatibility Epochs
date: 2026-06-26
status: active
supersedes: [ADR-0047]
superseded_by: null
related: [ADR-0046, ADR-0047, ADR-0061, ADR-0027]
tags: [tool-contract, versioning, plugins, compatibility, capability, architecture]
enforcement: mechanizable
enforcement-reason: >
  opensip-cli/fit/checks/no-first-party-contract-version-fields.mjs enforces the
  open runtime contractVersions map; opensip-cli/fit/checks/adr-plugin-contracts.mjs
  enforces bounded manifest and capability-pack epoch metadata for first-party
  packages.
```

**Decision:** Replace closed first-party runtime contract fields and exact plugin
epoch lockstep with an open, bounded integer compatibility model:

- Runtime domain contract versions use
  `extensionPoints.contractVersions?: Readonly<Record<string, string>>`.
- Named first-party fields (`fitnessContractVersion`, `graphContractVersion`,
  `simulationContractVersion`, `yagniContractVersion`) are removed with no
  runtime shims.
- Whole-tool manifest admission accepts bounded integer epochs:
  `MIN_SUPPORTED_PLUGIN_API_VERSION <= apiVersion <= PLUGIN_API_VERSION`.
- Capability-domain contribution compatibility uses owner-declared current/min
  supported integer epochs plus package-declared `targetDomain` /
  `targetDomainApiVersion`.
- Loose project-local source files are authored against the current CLI/domain
  epoch; they are not portable package-compatible artifacts.

**Alternatives:**

- Richer descriptor list for runtime contracts (rejected: re-closes core over
  first-party domains).
- Semver range syntax for plugin API compatibility (rejected: harder to
  diagnose; integer epochs are sufficient for launch).
- Keep old named fields as runtime shims (rejected: perpetuates closed evolution).
- Treat capability packs as unversioned source forever (rejected: cannot gate
  contribution epochs safely).

**Rationale:** ADR-0047 introduced independent per-tool contract versions but
encoded them as closed `ToolExtensionPoints` fields. That contradicts the
extension bag's open evolution role and forces a core change for every new
domain. Bounded integer epochs keep compatibility coarse, explicit, and easy to
log while avoiding semver parsing in the admission hot path. Capability packs
already load in-process; epoch metadata is compatibility, not isolation.

**Consequences:**

- `MIN_SUPPORTED_PLUGIN_API_VERSION` is exported beside `PLUGIN_API_VERSION`.
- Tool and capability manifests declare min/current epoch ranges.
- First-party capability packages declare `targetDomain` and
  `targetDomainApiVersion`.
- ADR-0047 remains the historical rationale for independent domain contract
  versions; its runtime field shape is superseded by this ADR.
- Public plugin docs describe range admission and the open `contractVersions`
  map.

**Related specs / ADRs:**

- Builds on ADR-0046 (core Tool contract versioning policy).
- Supersedes ADR-0047 for runtime field shape.
- Complements ADR-0061 (trust tiers — compatibility gates are not isolation).