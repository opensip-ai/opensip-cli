---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0127: Preserve evidence authority across egress

```yaml
id: ADR-0127
title: Preserve evidence authority across egress
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0008, ADR-0011, ADR-0036, ADR-0094, ADR-0097, ADR-0119, ADR-0126, DEC-587, DEC-520]
tags: [egress, sarif, evidence, cloud, contracts]
enforcement: mechanizable
enforced-by: ['local:no-lossy-evidence-egress']
enforcement-reason: >
  The local invariant is guarded by opensip-cli/fit/checks/no-lossy-evidence-egress.mjs:
  shared SARIF output must preserve OpenSIP fingerprints/properties, and native
  SignalBatch output must keep the optional evidence authority header.

**Decision:** The CLI preserves OpenSIP evidence identity across both egress
formats. SARIF carries `Signal.fingerprint` in
`partialFingerprints.opensipFingerprint` plus bounded OpenSIP property bags, and
native `SignalBatch` carries an optional `evidence` authority header. Missing or
incomplete local provenance downgrades to `external-untrusted`; only verified
bundled provenance plus complete declared inputs can become `cli-attested`.

**Alternatives:**

- **Leave SARIF lossy.** Rejected because GitHub Code Scanning and compatible
  consumers cannot deduplicate on the same identity the baseline plane uses.
- **Dump all `Signal.metadata` into SARIF.** Rejected because signal metadata is
  open plugin vocabulary and may contain large or sensitive context.
- **Make CLI evidence unconditionally authoritative.** Rejected because local
  client output is forgeable unless the binary, inputs, config, and provenance
  are proven. This survives only as the conditional `cli-attested` tier.
- **Build parent Cloud divergence enforcement here.** Rejected because
  cross-run/cloud-derived authority is parent `opensip` platform work, not an
  OSS CLI-local feature.

**Rationale:** `SignalEnvelope` is already the single output currency and
fingerprints are stamped at envelope construction. The previous SARIF formatter
discarded that identity, while native `SignalBatch` had no authority header for
Cloud to distinguish first-party local evidence from arbitrary external uploads.
Adding optional fields preserves compatibility and keeps the host-owned egress
path single: tools still return envelopes, the CLI composition root maps them to
SARIF/native delivery, and output formatting remains in `@opensip-cli/output`.

**Consequences:**

- Consumers that understand the new fields can correlate SARIF and native
  evidence with the host baseline plane.
- Consumers that do not understand them can ignore the optional fields; absence
  means `external-untrusted`.
- Bounded SARIF properties may include selected baseline/impact/repair metadata,
  but never arbitrary metadata dumps or raw file contents.
- Parent Cloud must still implement ingest-side storage, authority enforcement,
  and verdict-level divergence reporting.

**Fitness check:** Check warranted —
`opensip-cli/fit/checks/no-lossy-evidence-egress.mjs` guards the SARIF
fingerprint/property mapping and the native `SignalBatch.evidence` header.

**Related ADRs:** The CLI-local portion of and the ready Builds on [ADR-0094](./ADR-0094-cli-cloud-evidence-authority-and-egress-fidelity.md), [ADR-0097](./ADR-0097-gate-verdict-determinism.md), [ADR-0119](./ADR-0119-verifiable-self-distribution.md), and [ADR-0126](./ADR-0126-cli-local-trust-policy-md).
