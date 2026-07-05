---
status: active
last_verified: 2026-07-05
owner: opensip-cli
---

# ADR-0133: Allowlist-form layer rules

```yaml
id: ADR-0133
title: Allowlist-form layer rules
date: 2026-07-05
status: active
supersedes: []
superseded_by: null
related: [ADR-0037, ADR-0058, ADR-0064]
tags: [architecture, dependency-cruiser, layering]
enforcement: not-mechanizable
enforcement-reason: >
  Dependency-cruiser and verify-gate-live.mjs enforce the actual import
  boundaries. The authoring convention that from-side layer rules use
  negative-lookahead allowlists is config-review judgment, recorded here and in
  .config/dependency-cruiser.cjs.
```

**Decision:** Cross-package from-side layer rules in
`.config/dependency-cruiser.cjs` are authored as negative-lookahead allowlists:
for a package or package family, the rule states the packages it may import and
forbids every other workspace package by construction.

**Alternatives:**

- **Enumerated denylists.** Rejected because they silently rot as the workspace
  grows; the architecture review found layer rules that missed newer packages.
- **Generate rules from a package manifest.** Rejected because layer policy must
  stay independently readable and reviewable in the dependency-cruiser config.
- **Mirror layer boundaries with a fitness check.** Rejected because depcruise is
  already the source-of-truth graph gate, and `verify-gate-live.mjs` proves the
  gate fires.

**Rationale:** A denylist can look correct while omitting a newly added package.
The allowlist form makes the default answer "no" for every future package until
the rule is reviewed. Existing exemplars such as the targeting, cli-live, and
clone-detection rules already used this shape; this ADR makes it the durable
authoring convention.

**Consequences:**

- New package-family layer rules should use `to.path: '^packages/(?!allowed/|self/)'`
  or an equivalent negative-lookahead allowlist.
- Adding a package may require consciously updating relevant allowlists.
- If a rule truly needs a different shape, its comment must explain why and the
  layer-policy docs must describe the exception.

**Fitness check:** No new check warranted. The boundary is enforced by
`pnpm depcruise`, `pnpm depcruise:types`, and `node scripts/verify-gate-live.mjs`;
the authoring form itself is a review convention.

**Related specs / ADRs:** Aligns with the allowlist precedent in
[ADR-0037](ADR-0037-generic-targeting-runtime.md),
[ADR-0058](ADR-0058-shared-live-run-shell.md), and
[ADR-0064](ADR-0064-shared-clone-detection-substrate.md).
