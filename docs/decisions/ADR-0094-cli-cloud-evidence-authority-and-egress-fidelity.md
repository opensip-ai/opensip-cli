---
status: active
last_verified: 2026-06-28
owner: opensip-cli
---

# ADR-0094: CLI↔Cloud evidence authority and egress fidelity

```yaml
id: ADR-0094
title: CLI↔Cloud evidence authority and egress fidelity
date: 2026-06-28
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0008, ADR-0011, ADR-0036, ADR-0061, ADR-0065, DEC-587, DEC-589, DEC-520]
tags: [platform, cloud, egress, signals, evidence, contracts]
enforcement: not-mechanizable
enforcement-reason: >
  The egress-fidelity portion IS testable and will be guarded by spec-20
  round-trip tests (a fingerprinted Signal must round-trip its identity through
  SARIF `partialFingerprints` and the native envelope; a curated metadata
  allowlist must survive the boundary). But the load-bearing decision — that the
  platform is ONE identity model with THREE explicit authority tiers and
  divergence is reported not hidden — is a cross-repo design contract spanning
  the parent `opensip` Cloud repo; it is a posture, not a single mechanizable
  check.
```

**Decision:** `opensip-cli` and OpenSIP Cloud form **one identity/correlation
model with three explicit evidence-authority tiers** — (1) **cloud-derived**
(server recomputes from its own clone; authoritative for SaaS integrity and
freshness), (2) **CLI-attested** (accepted only with signed run provenance), (3)
**external/untrusted** (stored and correlated, never authoritative). The CLI→Cloud
egress contract MUST be **evidence-fidelity-preserving and authority-tagged**, and
Cloud MAY recompute evidence but MUST **correlate with CLI evidence and report
verdict-level divergence rather than silently maintaining a second truth.** The
shipped SARIF egress — which today *intentionally* drops `Signal.metadata`,
`fingerprint`, and `repair` (`packages/output/src/format/signal-sarif.ts:127`) —
is non-conformant and must be remediated.

**Alternatives:**

- **Pure CLI-authoritative** (Cloud trusts the CLI's deterministic evidence as
  ground truth). Rejected as an *unconditional* model: client evidence is forgeable
  unless the platform proves the CLI binary, inputs, repo commit, config, plugins,
  and runner context — so it survives only as the *conditional* CLI-attested tier,
  gated on signed provenance (specs 09 + 13a).
- **Pure Cloud-authoritative** (Cloud re-derives everything from its own clone; the
  CLI is just a feeder). Rejected: discards the CLI's strongest claim — deterministic
  local evidence usable offline, in CI, and by agents — and demotes spec-01
  determinism from a *platform* invariant to a local quality feature. The marketed
  "deterministic local evidence → Cloud organizational memory" would become
  marketing, not architecture.
- **Leave the lossy SARIF egress as-is (signals only).** Rejected: the marketed
  evidence chain is broken at the wire — `fingerprint` identity and graph context
  reach neither Cloud nor GitHub Code Scanning's cross-run alert dedup.
- **Sync the full CLI graph/baselines into Cloud storage.** Rejected: Cloud already
  builds its own server-side code-graph by cloning the repo (DEC-520), so this both
  duplicates work and reintroduces the heavy multi-tenant state ADR-0008
  deliberately kept server-side. The fix is a *fidelity + authority* contract over
  the existing signal pipe, not bulk artifact sync.

**Rationale:** Verified in code — the SARIF formatter emits only
`ruleId`/`level`/`message`/`location` and explicitly drops the transitive context
in `Signal.metadata`; it carries no `fingerprint`, `partialFingerprints`, or
`properties`. A native full-fidelity `SignalBatch` path exists
(`cloud-signal-sink.ts`, `schemaVersion: 1`) but ADR-0008 records that its
ingestion endpoint is not yet built; the parent exposes only `POST /v1/ingest`
for signal arrays and **re-fingerprints server-side** [DEC-587]. Independently,
the parent Cloud **re-computes its own code-graph/catalog/assessment** from a
server-side clone (DEC-520) and runs an autonomous fix pipeline (DEC-537) —
so two analysis engines are loosely coupled by a lossy wire, guaranteeing silent
CLI↔Cloud identity drift. The open-core/billing boundary (DEC-589: ingest is
RBAC-only; billing gates downstream at process dispatch) places monetization at
the *process* tier, consistent with the platform division-of-labor rule (an
artifact/capability belongs in Cloud iff it needs >1 repo, >1 run, or >1 actor).

**Consequences:**

- **Implemented by spec 20** (Platform Evidence Authority and Egress Contract):
  full-fidelity, authority-tagged egress + a **divergence-severity model** (only
  divergence that would change a gate/ticket outcome surfaces; sub-verdict
  divergence is suppressed). Depends on **spec 05** (cross-engine identity tiers),
  **spec 09** (provenance/signing for the CLI-attested tier), **spec 13a** (signed
  distribution), **spec 11** (wire-contract versioning), and spec 01's
  declared-inputs manifest.
- **Near-term, low-cost step:** map `signal.fingerprint → SARIF
  `partialFingerprints`` and a *curated allowlist* of `metadata` →
  `result.properties`. This helps GitHub Code Scanning cross-run alert identity
  immediately; it improves OpenSIP Cloud fidelity only when paired with parent
  `sarif-transform` consumption (today it ignores `properties`/`partialFingerprints`).
  The map MUST be a bounded allowlist, not a metadata dump — `signal-sarif.ts:127`
  drops metadata *by design* for portability, and this ADR scopes the reversal.
- **Parent-repo follow-ups** (out of CLI implementation scope; recorded here for
  cross-repo coordination): the full-fidelity ingest contract, SARIF-transform
  fidelity, and server-side authority/divergence enforcement live in the parent
  `opensip` repo and should be tracked there with a `DEC-NNN`.
- **Dangling cross-repo doc:** ADR-0008 cites `docs/internal/consumers/opensip.md`,
  which is absent on disk. Recreate it as the CLI-side mirror of DEC-587 + the
  `SignalBatch schemaVersion:1` contract, owned under spec 11, and update it in the
  same PR as any egress-fidelity change.
- **Confidence / verification debt:** the CLI-side lossy-egress finding is **high
  confidence** (read in code). The parent-repo recompute/divergence facts are
  **medium-high** (agent-gathered, cited to parent schema + DEC-520/537/546/589, not
  re-read line-by-line) — spot-check before parent implementation begins. The
  *posture* in this ADR stands on the verified CLI-side evidence alone: even if
  Cloud did not recompute, the lossy egress by itself requires a fidelity contract.
- **Product-gated timing, not posture:** priority/sequencing of spec 20 is gated by
  two open product decisions (spec-04 platform positioning; whether autonomous Cloud
  remediation is the platform moat — see spec 21). Those affect *when*, not *whether*,
  the authority model holds.

**Related specs / ADRs:** Implemented by `docs/plans/specs/20-platform-evidence-authority-and-egress-contract.md`
and `docs/plans/specs/09-enterprise-trust-policy-plane.md` (local-only). Builds on
[ADR-0008](./ADR-0008-opensip-cloud-signal-sync.md) (Cloud signal sink + open-core
boundary), [ADR-0011](./ADR-0011-signal-output-currency-formatter-sink.md) (output
plane), [ADR-0036](./ADR-0036-host-owned-baseline-ratchet-plane.md) (fingerprint
identity), [ADR-0061](./ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md)
(trust tiers — provenance/signing the CLI-attested tier reuses), and
[ADR-0065](./ADR-0065-public-json-output-and-raw-stream-policy.md) (public output
contract). Cites parent decisions DEC-587 (SARIF handoff wire contract), DEC-589
(ingest RBAC-only, billing downstream), DEC-520 (multi-repo materialization).
