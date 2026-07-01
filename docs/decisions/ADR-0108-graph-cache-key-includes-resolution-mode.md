---
status: active
last_verified: 2026-07-01
owner: opensip-cli
---

# ADR-0108: Graph adapter cache keys must include resolutionMode

```yaml
id: ADR-0108
title: Graph adapter cache keys must include resolutionMode
date: 2026-07-01
status: active
supersedes: []
superseded_by: null
related: [ADR-0105, ADR-0031, ADR-0032, ADR-0010]
tags: [graph, cache, determinism]
enforcement: mechanizable
enforcement-reason: >
  New unit test on makeConfigCacheKey asserting same config path + different
  resolutionMode yields different keys; cache-key tests in graph-adapter-common
  and per-adapter packages.
```

**Decision:** Every graph language adapter cache key MUST incorporate
`resolutionMode` from `CacheKeyInput` (the `MUST`-fold contract documented on the
`CacheKeyInput.resolutionMode` field — distinct from invariant **I-8**, which
governs per-adapter prefix uniqueness / single-language identity). The shared helper
`makeConfigCacheKey` in `@opensip-cli/graph-adapter-common` appends or hashes
`resolutionMode` alongside the config-path hash. Tree-sitter adapters that
customize cache keys (`graph-python`) follow the same rule.

**Alternatives:**

- Document tree-sitter adapters as exact-only and normalize mode at engine —
  rejected; violates the published adapter contract; blocks future fast-tier
  tree-sitter work without another breaking change.
- Hash only at engine level, ignore adapter keys — rejected; adapters own cache
  key construction per ADR-0031 determinism model.
- Include adapter version in key only — insufficient; same config + different
  mode must not collide.

**Rationale:** `packages/graph/engine/src/lang-adapter/types.ts` states adapters
MUST fold `resolutionMode` into keys. `graph-typescript` complies; tree-sitter
adapters via `makeConfigCacheKey` do not. Risk is latent today (no fast mode on
tree-sitter) but violates contract and would cause silent cache reuse bugs when
fast-tier lands.

**Consequences:**

- Update `graph-adapter-common/src/cache-key.ts` and four consumer wrappers.
- Existing cached artifacts naturally miss (key shape change) — no migration.
- Reference implementation remains `graph-typescript/src/cache-key.ts`.

**Related specs / ADRs:** Phase 1 in
`docs/plans/architecture-audit-p1-remediation/`; [ADR-0032](ADR-0032-sharded-engine-default.md).