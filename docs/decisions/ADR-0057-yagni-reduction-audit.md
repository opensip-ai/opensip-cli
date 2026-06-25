---
status: superseded
last_verified: 2026-06-24
owner: opensip-cli
---

# ADR-0057: YAGNI as a bundled Tool with graph evidence seam

> **Superseded by [ADR-0063](ADR-0063-yagni-reduction-coordinator.md)
> (2026-06-24).** The "call-graph body-hash grouping is proven machinery" premise
> below proved to be a *re-implementation* of `graph:duplicated-function-body` that
> diverged in production (430 yagni warnings vs 0 graph findings on the same
> catalog). ADR-0063 retires yagni's own detectors and makes it a freshness-gating
> coordinator over graph rules + fitness checks.

```yaml
id: ADR-0057
title: YAGNI as a bundled Tool with graph evidence seam
date: 2026-06-21
status: superseded
supersedes: []
superseded_by: ADR-0063
related: [ADR-0014, ADR-0036, ADR-0047]
tags: [yagni, graph, tools, architecture]
enforcement: mechanizable
enforcement-reason: >
  dependency-cruiser rules yagni-no-cli, yagni-no-check-packs,
  yagni-no-graph-adapter-packs; graph-evidence.ts is the sole allowlisted
  importer of @opensip-cli/graph/internal.
```

**Decision:** Ship `yagni` as a bundled first-party Tool (`@opensip-cli/yagni`) that consumes graph catalog data through a single in-process evidence seam (`packages/yagni/engine/src/evidence/graph-evidence.ts` importing `@opensip-cli/graph/internal`), not by subprocess or graph adapter packs.

**Alternatives:**

- Fitness recipe — rejected: YAGNI findings need reduction metadata, preservation arguments, and validation steps that do not map cleanly to pass/fail check semantics.
- Subprocess `opensip graph` — rejected: brittle, slow, and couples user workflow to a prerequisite command.
- Import graph adapter packs directly — rejected: violates layering; adapters are language-specific leaves, not cross-tool evidence providers.

**Rationale:** Call-graph body-hash grouping is proven machinery in the graph catalog. A Tool plugin reuses host signals, sessions, baselines, and report compose while keeping advisory semantics (`failOnErrors: 0`). One allowlisted internal import keeps the dependency direction explicit and testable; all other yagni code stays on AST/package evidence and shared core helpers.

**Consequences:**

- `graph-evidence.ts` is the only file permitted to import `@opensip-cli/graph/internal`.
- Graph-backed detectors declare `requiresGraph: true` and surface skips in `session.payload.summary.skippedDetectors`.
- CI dogfood pins `yagni.graphMode: build` (not `auto`) for determinism.
- Dashboard accepts optional `yagniSummary` / `yagniCatalog` keys from `collectReportData`.

**Related specs / ADRs:** `docs/plans/ready/yagni-reduction-audit/plan.md`, ADR-0014 (suppressions), ADR-0036 (baseline fingerprints).
