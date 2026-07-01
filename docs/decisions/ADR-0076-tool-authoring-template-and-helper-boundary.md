---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0076: Tool authoring template and helper boundary

```yaml
id: ADR-0076
title: Tool authoring template and helper boundary
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0046, ADR-0061, ADR-0074]
tags: [tools, plugins, authoring, templates, architecture]
enforcement: mechanizable
enforcement-reason: >
  opensip-cli/fit/checks/no-implicit-tool-extension-defaults.mjs enforces absence
  defaults in createTool/defineTool; template tests validate manifest/runtime
  coherence through loadToolManifest and assertManifestMatchesTool.
```

**Decision:** Add `createTool()` as a thin public wrapper over `defineTool()`;
ship `minimal-js` and `ts-local` project-local scaffolds first; keep safe
extension-point defaults as absence (no synthesized lifecycle hooks); defer a
publishable npm template until consumption-side verification and trust enforcement
mature.

**Alternatives:**

- Broaden `defineTool()` with implicit hook defaults (rejected: hides host-plane
  participation from new authors).
- Replace `defineTool()` with a new descriptor builder (rejected: duplicates
  validation and derivation).
- Ship a publishable npm template now (rejected: needs plan-02/03 provenance and
  plan-06 trust posture for public distribution).
- Keep hand-written minimal manifests without `identity` (rejected: fails real
  sidecar validation).

**Rationale:** `defineTool()` is the canonical low-level contract with explicit
identity normalization and derived fields. New authors need ergonomics without
changing validation semantics. Project-local tools remain deny-by-default
(ADR-0061). Plan 03 landed bounded `apiVersion` epochs (ADR-0074); templates
emit conformant sidecars immediately. Typed local packages can depend on
`@opensip-cli/core` while publishable distribution waits for verification policy.

**Consequences:**

- `createTool`, `CreateToolInput` export from `@opensip-cli/core`.
- `opensip tools create --template ts-local` writes a buildable typed package.
- Generated manifests include `identity` and `stableId`.
- Recipe listing uses shared display helpers; execution stays tool-owned.
- Fitness check `dogfood-no-implicit-tool-extension-defaults` guards helper changes.
- 2026-07-01 note: `createTool()` remains exported as a compatibility wrapper
  for older authored tools, but `opensip tools create --template ts-local` now
  teaches `defineTool()` plus command-spec drafts directly.

**Related specs / ADRs:**

- ADR-0046 — core `TOOL_CONTRACT_VERSION` marker policy.
- ADR-0061 — project-local deny-by-default trust.
- ADR-0074 — `apiVersion` epoch and open `contractVersions` map.

**Fitness check:** Check warranted —
`opensip-cli/fit/checks/no-implicit-tool-extension-defaults.mjs`.
