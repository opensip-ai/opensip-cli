---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0120: Measure Detection Quality In A Script Lane

```yaml
id: ADR-0120
title: Measure detection quality in a script lane
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0118]
tags: [fitness, quality, ci, docs]
enforcement: not-mechanizable
enforcement-reason: >
  Fitness check: No check warranted. The invariant is script-only: no runtime
  package boundary, ToolCliContext seam, session writer, datastore schema, or
  command registration is added. Regression is enforced by
  `quality:measure:check`, script tests, generated suppression-catalog checks,
  docs checks, and CI.

**Decision:** Measure detection quality with a root-level script lane over a
checked-in labeled OSS corpus and committed baseline. Do not add a new OpenSIP
runtime tool, session surface, datastore table, or platform-only private corpus
as the primary mechanism.

**Alternatives:**

- Runtime OpenSIP tool: rejected because this is repo quality infrastructure,
  not user-facing project analysis. A tool would imply command specs, sessions,
  output seams, and plugin contracts that are not needed.
- Private-only corpus: rejected because contributors and OSS adopters could not
  reproduce or audit the quality gate.
- Waiver heatmap only: rejected because suppressions can estimate false-positive
  pain but cannot measure recall or true negatives.

**Rationale:** Spec 17 requires per-check precision/recall, FPR, release-over-
release regression detection, multi-language coverage, and a feedback loop into
suppression triage. The existing SLO lane already proves that root scripts are
the right home for repository quality measurements that need built workspace
artifacts but should not become product commands.

**Consequences:**

- The default corpus is deterministic and redistributable under
  `scripts/quality/fixtures/`.
- `.config/detection-quality-baseline.json` is a committed quality baseline.
- `.config/suppression-triage.md` consumes measured quality metrics when ranking
  triage priorities.
- Contributors changing checks should add or update labeled quality cases when a
  behavior change would affect precision, recall, or FPR.

- [ADR-0118](./ADR-0118-scale-and-performance-slos.md)
- [Detection Quality](../public/70-reference/14-detection-quality.md)
