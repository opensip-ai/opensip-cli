---
status: active
last_verified: 2026-07-18
owner: opensip-cli
---

# ADR-0172: Extract the cross-tool analysis runtime into @opensip-cli/shared-analysis

```yaml
id: ADR-0172
title: Extract the cross-tool analysis runtime into @opensip-cli/shared-analysis
date: 2026-07-18
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0055, ADR-0107, ADR-0110, ADR-0124, ADR-0147, ADR-0166]
tags: [packaging, layering, contracts, graph, review-brief, agent-catalog]
enforcement: mechanizable
enforced-by: ['depcruise:shared-analysis-no-tool-or-cli-edges', 'script:core-reexport-completeness.test']
enforcement-reason: >
  The layer edges are enforced by the dependency-cruiser forbidden-edge rule
  (0-error in pnpm lint). The core→contracts facade-completeness half is
  enforced by packages/contracts/src/core-reexport-completeness.test.ts — a
  runtime-binding comparison of both barrels, chosen over a dogfood text check
  because it asserts semantics (the actual export bindings match), needs no
  cross-file path-gating, and runs in the same CI gate.
```

## Decision

Move the cross-tool analysis **runtime** out of `@opensip-cli/contracts` into a
new layer-3 package `@opensip-cli/shared-analysis`:

- the changed→impact compute engine (`graph-impact-async/-sync/-index/
  -cooperative/-shared/-compute`),
- review-brief derivation + correlation (the executable functions; the
  `ReviewBrief*` types, zod schemas, and `REVIEW_BRIEF_VERSION` stay in
  `contracts` — they are the persisted cross-tool contract MCP replays),
- agent-catalog assembly (`buildAgentCatalog`, `assembleAgentCatalog`,
  runtime-fact projection; the `AgentCatalog*` types stay in `contracts`).

`shared-analysis` depends on `core` and `contracts` only; the tool engines and
the host depend on **it**, never the reverse (dependency-cruiser rule
`shared-analysis-no-tool-or-cli-edges`). `contracts` returns to a genuine
type/constant/facade surface, and its core re-export block is kept complete
**mechanically** (the promised export families are compared against core's
actual exports at test time — the check immediately caught four drifted
`*_CONTRACT_VERSION` constants when introduced).

## Alternatives considered

- **Keep the runtime in `contracts`** — rejected: a frozen versioned-ABI facade
  coupled to evolving algorithms is the canonical single-responsibility
  failure, and it showed up as the repo's top coupling nexus
  (`contracts/src/index.ts` churning ~53×, >4,100 LOC of executable analysis
  beside frozen `*_CONTRACT_VERSION` constants).
- **Fold the impact engine into the `graph` engine** — rejected: `fitness`
  consumes impact (`fit --changed` / `--include-impacted`), so it would need a
  `graph` peer edge — exactly the cross-tool coupling the extraction removes.
- **Enforce facade completeness with a generated re-export block** — rejected
  in favor of the runtime-binding test: a generated block without a check can
  still drift silently (the generator itself becomes the unchecked surface).

## Consequences

- The workspace grows to 61 packages (58 publishable); the release order and
  derived inventories (architecture map, package catalog) include
  `shared-analysis`.
- Consumers of the moved runtime import `@opensip-cli/shared-analysis`
  (graph read views, MCP command/persisted-review-brief/catalog-generation,
  the host suite/review path and agent-catalog command). Types stay imported
  from `@opensip-cli/contracts`.
- The impact algorithm moved verbatim — graph output is unchanged
  (determinism do-not-regress held by the existing equivalence suites).
