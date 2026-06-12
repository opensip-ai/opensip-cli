---
status: active
last_verified: 2026-06-06
owner: opensip-cli
---

# ADR-0012: Versioning & release policy — semver-honest, output contract versioned independently, batch majors; stay pre-GA on 2.x, reserve 3.0.0 for the tool-plugin-parity north star

> **Amended 2026-06-06.** The original decision named `3.0.0` as the next tag /
> first GA. That is reversed: GA is deferred to the **tool-plugin-parity north
> star** (`docs/plans/tool-plugin-parity-architecture-2026-06-06.md`), which will
> be `3.0.0`. The project stays pre-GA on the long-lived **2.x** major; the
> accumulated breaking batch (ADR-0011 + ADR-0009 surface) ships as **`2.7.0`**.
> The rest of the policy (semver-honest, independent output-contract version,
> batch majors, deprecate-not-unpublish) is unchanged. Edited in place by
> maintainer decision rather than via a superseding ADR.

```yaml
id: ADR-0012
title: Versioning & release policy — semver-honest, output contract versioned independently, batch majors; pre-GA on 2.x, 3.0.0 reserved for tool-plugin parity
date: 2026-06-04
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0008, ADR-0009]   # the breaking change that prompted this; SignalBatch schemaVersion; public-API surface policy
tags: [versioning, release, semver, packaging, npm]
enforcement: not-mechanizable
enforcement-reason: >
  This is a process/policy decision. Its mechanical half is already guarded:
  `scripts/verify-release.mjs` enforces single-version consistency, a dated
  CHANGELOG entry, and generated-artifact freshness; the output-contract
  versions are real fields in code (`SignalEnvelope.schemaVersion` in
  @opensip-cli/contracts, `SignalBatch.schemaVersion` in @opensip-cli/core).
  The judgment half — "batch breaking changes into deliberate majors; declare GA
  by announcement, not by the integer" — is a maintainer discipline, not a gate.
```

**Decision:** opensip-cli follows **semantic versioning honestly** for its
published package APIs: a breaking change to any `@opensip-cli/*` or the
`opensip-cli` CLI surface requires a **major** bump. Three rules govern how we
apply it:

1. **The machine-output / wire contract is versioned independently of the
   package version.** Consumers of `--json` pin to the envelope's
   `schemaVersion` (`SignalEnvelope.schemaVersion`, currently `2`); cloud
   consumers pin to `SignalBatch.schemaVersion` (currently `1`). These evolve on
   their own cadence and do NOT force — nor are forced by — a package major.
2. **Breaking changes are batched into deliberate major windows**, not cut
   per-change. Within a major, minor/patch stay non-breaking; accumulated
   breaks land together at the next major. Pre-GA, expect **long-lived majors**,
   not a fast-climbing integer.
3. **The project stays pre-GA on the long-lived `2.x` major; the accumulated
   breaking batch ships as `2.7.0`.** GA is **deferred** to the tool-plugin-parity
   north star (`docs/plans/tool-plugin-parity-architecture-2026-06-06.md`), which
   will be declared **`3.0.0`**. Expect several more `2.x` releases (breaking
   changes batched into `2.x` minors) before then, on the existing
   `@opensip-cli/*` + `opensip-cli` names. The "production-ready" signal is
   the GA release announcement at the north star — **not** the version integer.

When GA (`3.0.0`) is cut, the older pre-GA npm versions are retired with
**`npm deprecate`** (a steering message that keeps them installable), never
**`npm unpublish`**. Pre-GA `2.x` releases do not mass-deprecate prior versions.

**Alternatives:**

- *Reset to `1.0.0` on the existing package names ("relaunch as v1").* **Rejected
  — technically impossible.** `@opensip-cli/core@1.0.0` (and other early
  versions) were published then unpublished; npm permanently forbids
  republishing a burned version (`npm view @opensip-cli/core@1.0.0` → 404,
  verified 2026-06-04). A clean `1.0.0` is therefore only achievable at a *new*
  package identity.
- *Rename to a new scope/name to obtain a clean `1.0.0`, deprecating the old
  packages.* **Rejected** — the rename cost (30 packages + the `opensip-cli`
  CLI binary + every doc + the `opensip.ai/docs` paths + SEO/stars/link
  continuity, and stranding existing installers — `@opensip-cli/core` ~4.3k,
  `opensip-cli` ~476 downloads/week as of 2026-06-04) is not justified merely
  to obtain a lower integer. Worth it ONLY as part of an intentional rebrand,
  which is not on the table.
- *Cut a new major for each breaking change, no batching policy.* **Rejected** —
  that is precisely the cadence-inflation that prompted this ADR (two majors in
  ~6 months: `1.0`→`2.0`→ proposed `3.0`). Many small majors read as churn; one
  substantial, well-documented major reads as maturity.
- *Tie the output-contract version to the package version.* **Rejected** — it
  forces a package major for any `--json` shape change and conflates two
  contracts that evolve independently. The envelope already carries its own
  `schemaVersion` (ADR-0011); use it.
- *Self-`unpublish` the old versions for a clean registry.* **Rejected** —
  irreversible, and blocked anyway: both `@opensip-cli/core` (~4.3k/wk) and
  `opensip-cli` (~476/wk) exceed npm's 300-downloads/week self-unpublish
  threshold. `npm deprecate` is the correct, reversible instrument.

**Rationale:** The independent output-contract version already exists in code —
`SignalEnvelope.schemaVersion` and `SignalBatch.schemaVersion` — so decoupling
is finishing a design the codebase started, not inventing one. The npm registry
is append-only by design (a published version's meaning can never change), which
is *why* a same-name downgrade-republish to `1.0.0` is impossible and why
`deprecate` (not `unpublish`) is the steering tool. A high major number is not a
maturity signal in either direction — mature, widely-used tools routinely sit at
high majors; what communicates stability is a clear changelog, a stated support
policy, and a GA declaration. Batching breaking changes into deliberate windows
keeps the integer meaningful (a major means "we accumulated enough to warrant
migration effort") instead of noisy.

**Consequences:**

- **`2.7.0` is the next tag.** It bundles the accumulated breaking changes —
  ADR-0011 (signals as the universal output currency; `CliOutput` retired;
  `reporting`→`output`; `recipeUnitConfig`; 4-level `--json` severity) and the
  ADR-0009 surface tightening (audit Findings 2–4) — into one deliberate, batched
  pre-GA `2.x` minor (consistent with how `2.6.0` / `2.3.0` / `2.0.0` shipped
  their breaks).
- Pre-GA, breaking changes continue to batch into `2.x` minors toward the GA
  cutover. **At GA (`3.0.0`, the tool-plugin-parity north star) the strict
  no-break-within-a-major rule begins**, and from then on minor/patch within
  `3.x` remain non-breaking.
- Docs instruct machine-output consumers to pin `schemaVersion`, not the package
  version (see the `--json` reference + the 2.7 migration guide,
  `docs/public/70-reference/07-migrating-to-2.7.md`).
- **At GA publish time (not before):** `npm deprecate '@opensip-cli/<pkg>@<3.0.0'`
  (and the unscoped CLI) with a message pointing at the GA; do NOT unpublish.
- The release gate is unchanged: `scripts/verify-release.mjs` (single-version
  consistency, dated CHANGELOG entry, generated-doc freshness) + the tag-driven
  `release.yml`.
- GA is declared via the release announcement + CHANGELOG at `3.0.0`, referencing
  this ADR.

**Related specs / ADRs:** ADR-0011 (the breaking migration this batch ships, and
the source of the independent `SignalEnvelope.schemaVersion`), ADR-0008
(`SignalBatch.schemaVersion`, the cloud wire-contract version), ADR-0009
(public-API surface policy — the other breaking changes in this batch). Release
mechanics live in `RELEASING.md`; the `2.7.0` change log in `CHANGELOG.md`; the
deferred-GA north star in
`docs/plans/tool-plugin-parity-architecture-2026-06-06.md`.
