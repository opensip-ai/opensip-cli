---
status: active
last_verified: 2026-06-30
owner: opensip-cli
---

# ADR-0098: Host-owned signal dedup and precision heatmaps

```yaml
id: ADR-0098
title: Host-owned signal dedup and precision heatmaps
date: 2026-06-30
status: active
supersedes: []
superseded_by: null
related: [ADR-0001, ADR-0011, ADR-0014, ADR-0024, ADR-0036, ADR-0064, ADR-0097]
tags: [signals, output, precision, graph, fitness, agents]
enforcement: mechanizable
enforcement-reason: >
  Signal dedup is routed through the CLI host output seams before JSON,
  terminal rendering, SARIF, cloud, and report egress. Unit tests assert
  conservative identity and near-identity collapse. Suppression catalog
  generation carries the disposition taxonomy used for precision heatmaps.
```

> **Amendment (2026-06-30, [ADR-0101](ADR-0101-cli-emits-full-fidelity-consumers-dedup.md)):**
> The **signal-deduplication** decision below is **REVERSED**. The CLI no longer
> deduplicates signals on any path — it emits the tool's full, unmodified set to
> render and egress, and deduplication is the consumer's responsibility (this
> restores [ADR-0094](ADR-0094-cli-cloud-evidence-authority-and-egress-fidelity.md)
> egress fidelity, which host-side dedup violated by dropping distinct fingerprints
> from the wire). The **precision-heatmap / suppression-taxonomy** decision in this
> ADR is **unaffected and remains active**. Read the dedup portions below as
> historical context only.

**Decision:** Duplicate signal reduction is a host-owned output-plane
normalization step over `SignalEnvelope`, not a per-tool formatter or rule
responsibility. The host collapses exact identity duplicates and conservative
near-identity duplicates before presentation and egress, while preserving the
tool-computed `verdict.passed` boolean.

Suppression catalogs are precision heatmaps, not proof. A high waiver count
prioritizes inspection; each suppression bucket must be classified with the
taxonomy `false-positive`, `accepted-risk`, or `design-mismatch` before the team
treats it as a rule bug or product bug.

**Alternatives:**

- **Dedup inside each tool.** Rejected. Fit, graph, sim, and YAGNI would drift,
  and external tools would not get the same noise reduction.
- **Dedup in SARIF only.** Rejected. JSON, terminal output, cloud sync, sessions,
  and agents read the envelope directly; dedup must happen before every sink.
- **Change gate verdicts from dedup alone.** Rejected for this release. The host
  does not have the tool's verdict policy at output time, so it reduces duplicate
  noise without silently changing pass/fail semantics.
- **Treat suppression counts as facts.** Rejected. Suppressions can mean an
  accepted risk, an intentionally deferred design mismatch, or a check
  false-positive.

**Rationale:** ADR-0011 makes `SignalEnvelope` the shared run currency. That
creates one natural place to remove identity duplicates: the host output plane
that every render and egress path already crosses. This is especially important
for graph-derived rules and reduction tools, where near-identical findings can
make an agent or human triager spend time on the same fact repeatedly.

The suppression catalog already showed where the precision work should start,
but raw counts were too easy to over-read. The explicit taxonomy lets an agent or
maintainer distinguish "fix the check" from "fix the code/design" from "accepted
and documented."

**Consequences:**

- New envelope output paths must call the host normalization helper before they
  serialize, render, upload, or write SARIF.
- Tools should keep emitting their full local signal set. They should not copy
  the host's dedup logic into rule implementations or formatters.
- Dedup keys must remain conservative: include rule/source/location/message, or
  a stamped fingerprint scoped to the same provider/source/rule, and never
  collapse unrelated findings across files or rules.
- Suppression triage docs and JSON must expose the expanded taxonomy so agents
  can reason about precision work without reading tribal shorthand.

**Related specs / ADRs:** Implements Plan 02 from
`docs/plans/README.md` (precision and dedup hardening). Builds on ADR-0011
(signal output currency), ADR-0036 (baseline identity), ADR-0064 (shared clone
detection substrate), and ADR-0097 (gate verdict determinism).
