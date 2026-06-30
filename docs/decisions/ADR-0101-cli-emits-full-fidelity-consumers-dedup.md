---
status: active
last_verified: 2026-06-30
owner: opensip-cli
---

# ADR-0101: The CLI emits full-fidelity signals; deduplication is the consumer's responsibility

```yaml
id: ADR-0101
title: The CLI emits full-fidelity signals; deduplication is the consumer's responsibility
date: 2026-06-30
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0094, ADR-0098, ADR-0008, ADR-0036]
tags: [signals, output, egress, fidelity, cloud, sarif]
enforcement: not-mechanizable
enforcement-reason: >
  The decision is the ABSENCE of a transform: the CLI ships the tool's signal
  set unchanged to every render and egress path. There is no host dedup module to
  guard; the invariant is "no normalization step is inserted before output/egress",
  reinforced by ADR-0094's egress-fidelity round-trip tests.
```

**Decision:** `opensip-cli` does **not** deduplicate signals. Every output and
egress path — terminal render, `--json`, SARIF (`writeSarif` file and
`--report-to`), and OpenSIP Cloud sync — receives the tool's **full, unmodified**
signal set. Duplicate suppression is the **consumer's** responsibility: OpenSIP
Cloud already deduplicates server-side, and external SARIF receivers own their own
dedup (a receiver that wants it adds a dedup step at ingestion). This reverses the
host-owned signal-dedup decision of [ADR-0098](ADR-0098-host-owned-signal-dedup-and-precision-heatmaps.md);
the precision-heatmap / suppression-taxonomy decision of ADR-0098 is unaffected
and remains active.

**Alternatives:**

- **Host-owned dedup before every sink (ADR-0098 as shipped).** Rejected. The
  near-identity dedup key ignores `column` and `fingerprint`, so it can collapse two
  signals with **distinct fingerprints**, dropping one before egress. Because the
  gate baseline (`saveBaseline`/`compareBaseline`) reads the raw signal set, the
  CLI gate kept the full set while Cloud / GitHub Code Scanning received a deduped
  set — exactly the silent CLI↔Cloud identity drift [ADR-0094](ADR-0094-cli-cloud-evidence-authority-and-egress-fidelity.md)
  exists to eliminate.
- **Display-only dedup (dedup terminal + `--json`, full set to egress).** Rejected
  as unnecessary scope: it still makes the CLI carry dedup logic and identity keys,
  and it splits the contract (what a human sees vs what ships) for marginal local
  noise reduction. Consumers that want dedup are better placed to do it with their
  own identity model.
- **Exact-fingerprint-only dedup at egress.** Rejected: near-zero practical effect
  (exact-fingerprint duplicates are rare) for added code and a second identity path.

**Rationale:** [ADR-0094](ADR-0094-cli-cloud-evidence-authority-and-egress-fidelity.md)
makes egress **fidelity-preserving** the load-bearing contract: every fingerprinted
signal must round-trip its identity to Cloud and Code Scanning so the platform is
one identity model, not two. Any CLI-side dedup is in tension with that — and the
shipped near-identity dedup actively violated it by dropping distinct fingerprints
from the wire while the gate baseline retained them. The cleanest resolution is for
the CLI to be a faithful evidence producer and let each authority tier
(cloud-derived, CLI-attested, external) deduplicate under its own correlation model.
This also keeps the CLI simpler: no identity-key heuristics, no recomputed
`units`/`summary`, fewer ways for the local view and the evidence wire to disagree.

**Consequences:**

- Output and egress paths emit the tool's signals verbatim; there is no
  `normalizeSignalEnvelope` step. `signals[]`, `units[].violationCount`, and
  `verdict.summary` are the tool's own counts everywhere.
- A run that genuinely produces near-duplicate findings shows them all locally;
  consumers that find this noisy deduplicate at ingestion (Cloud does this today).
- The CLI↔Cloud and CLI↔Code-Scanning views agree on the signal set, restoring the
  ADR-0094 fidelity invariant.
- The precision work from ADR-0098 (suppression heatmaps + the
  `false-positive`/`accepted-risk`/`design-mismatch` taxonomy) stays — that is a
  triage aid, independent of dedup.

**Related specs / ADRs:** Reverses the dedup half of ADR-0098 (Plan 02). Restores
[ADR-0094](ADR-0094-cli-cloud-evidence-authority-and-egress-fidelity.md) egress
fidelity. Builds on [ADR-0011](ADR-0011-signal-output-currency-formatter-sink.md)
(signal output currency) and [ADR-0008](ADR-0008-opensip-cloud-signal-sync.md)
(cloud sync).

**Fitness check:** No check warranted. The decision is the *absence* of a
transform — there is no host dedup module or seam to guard, and re-introduction
would be a visible new module on the output/egress path caught in review. ADR-0094's
egress round-trip fidelity tests are the positive enforcement that signal identity
survives the wire.
