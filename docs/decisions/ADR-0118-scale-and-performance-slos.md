---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0118: Measure Scale and Performance SLOs with a Script Lane

```yaml
id: ADR-0118
title: Measure Scale and Performance SLOs with a Script Lane
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: []
tags: [ci, performance, graph, fitness]
enforcement: mechanizable
enforced-by: ['script:bench:slo:ci']
enforcement-reason: >
  `pnpm bench:slo:ci` enforces configured budgets in CI, and
  `pnpm docs:performance-slos:check` keeps the public SLO documentation derived
  from `.config/performance-slos.json`.
```

**Decision:** Performance SLOs for opensip-cli are measured by a root-level,
dependency-free script lane over deterministic synthetic corpora. The lane runs
the built CLI as an external process, records duration and process-tree RSS, and
emits a JSON artifact with budget comparisons and `performance-slo:*` signals.

**Alternatives:** A first-class `opensip bench` tool was rejected because
benchmarking the repository's own CLI is contributor infrastructure, not a
product analysis domain. Reusing raw `.runtime` logs or SQLite internals was
rejected because logs are event streams and stored sessions do not provide the
process-tree RSS contract this SLO needs. Real-world public benchmark corpora
were rejected for this phase because they add network, licensing, and drift risk
to PR validation.

**Rationale:** The SLO lane needs to validate the whole built CLI, including
bootstrap, config resolution, tool loading, graph cache behavior, and suite
orchestration. Running subprocesses from `scripts/bench-slo.mjs` preserves that
boundary without adding model calls, autonomous mutation, or a new runtime
package. Single-sourcing budgets in `.config/performance-slos.json` lets CI,
docs, and tests agree on the same thresholds.

**Consequences:** CI now runs the PR SLO profile after build and uploads
`slo-report.json`. Contributors changing graph, fitness, suite orchestration, or
bootstrap behavior should inspect the artifact when the lane fails instead of
loosening budgets by default. Budget changes must update the JSON source and
regenerate the public SLO reference.

**Related specs / ADRs:** Implements the scale-and-performance SLO plan promoted
from the scale-and-performance-slos planning work.
