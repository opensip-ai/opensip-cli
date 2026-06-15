---
status: active
last_verified: 2026-06-13
owner: opensip-cli
---

# ADR-0012: Versioning & release policy — semver-honest, output contract versioned independently; rebranded to the @opensip-cli/* identity and restarted at 0.1.0 (pre-1.0)

> **Amended 2026-06-13 (retires the prior conclusion).** The product
> **rebranded** from the `@opensip-tools/*` identity (which reached `3.0.0` GA;
> latest published `2.13.0`) to a **fresh npm identity** — the `@opensip-cli/*`
> scope plus the unscoped `opensip-cli` CLI, nothing published yet (`npm view`
> → 404 as of 2026-06-13) — and **restarts versioning at `0.1.0` (pre-1.0 /
> `0.x`)** on that clean identity. This is the "intentional rebrand → clean low
> version on a new name" path the 2026-06-04 Alternatives reserved as the *only*
> justification for a rename; it has now happened, so the "stay pre-GA on `2.x`,
> next tag `2.7.0`, reserve `3.0.0` for GA" conclusion below is **retired**.
> New policy: the `@opensip-cli/*` identity is `0.x` until its public API
> stabilizes — breaking changes may land on **minor** (`0.y`) bumps (npm/Cargo
> caret locks `^0.y.z` to the minor) — and **`1.0.0` is earned** when the API
> freezes and real users depend on it, declared by announcement, not by the
> integer. The still-valid halves are unchanged: **semver-honest** package APIs,
> the **independently-versioned machine-output contract**
> (`SignalEnvelope.schemaVersion`, `SignalBatch.schemaVersion`), batched breaking
> changes, and **deprecate-not-unpublish**. The old `@opensip-tools/*` packages
> are retired via `npm deprecate` pointing at `@opensip-cli/*` — never
> unpublished. Edited in place by maintainer decision.
>
> **Amended 2026-06-06 (historical — itself overtaken by the 2026-06-13
> rebrand).** The original decision named `3.0.0` as the next tag / first GA.
> That was reversed to: GA deferred to the tool-plugin-parity north star
> (`3.0.0`), pre-GA on the long-lived **2.x**, accumulated breaking batch as
> **`2.7.0`**. This applied to the `@opensip-tools/*` identity and is overtaken
> by the rebrand above.

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
3. **The product runs on the rebranded `@opensip-cli/*` + `opensip-cli`
   identity, restarted at `0.1.0` (pre-1.0).** The prior `@opensip-tools/*`
   identity reached `3.0.0` GA (latest published `2.13.0`) and is retired (see
   Consequences). On the fresh identity the public API (the Tool contract, the
   check authoring API, the config + payload schemas, the CLI surface) is **not
   frozen while `0.x`**: breaking changes may land on **minor** (`0.y`) bumps —
   a caret range locks `^0.y.z` to the minor, so each `0.y` is a deliberate
   migration. **`1.0.0` (GA) is earned**, not scheduled: declared by
   announcement when the API stabilizes and real users depend on it — **not** by
   the version integer.

When GA (`3.0.0`) is cut, the older pre-GA npm versions are retired with
**`npm deprecate`** (a steering message that keeps them installable), never
**`npm unpublish`**. Pre-GA `2.x` releases do not mass-deprecate prior versions.

**Alternatives:**

- *Reset to `1.0.0` on the existing package names ("relaunch as v1").* **Rejected
  at the time — technically impossible on the then-current names.** Early
  versions were published then unpublished; npm permanently forbids republishing
  a burned version. A clean restart is therefore only achievable at a *new*
  package identity. **Update (2026-06-13):** that *new identity* is exactly what
  the rebrand created — the `@opensip-cli/*` scope and unscoped `opensip-cli`
  have nothing published (`npm view` → 404), so a clean `0.1.0` publishes
  cleanly there. (The burned-version constraint only ever bound the legacy
  `@opensip-tools/*` names.)
- *Rename to a new scope/name to obtain a clean low version, deprecating the old
  packages.* **Rejected at the time** — the rename cost (30 packages + the
  `opensip-cli` CLI binary + every doc + the `opensip.ai/docs` paths +
  SEO/stars/link continuity, and stranding existing installers —
  `@opensip-tools/core` ~4.3k, the legacy CLI ~476 downloads/week as of
  2026-06-04) was judged not justified merely to obtain a lower integer; worth
  it ONLY as part of an intentional rebrand. **Update (2026-06-13): this is now
  the chosen path.** An intentional rebrand to `@opensip-cli/*` + `opensip-cli`
  did happen (commit `a71a0c0d` "cut over to OpenSIP CLI"); the new identity
  restarts at `0.1.0` and the legacy `@opensip-tools/*` packages are deprecated
  toward it.
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

- **`0.1.0` is the first tag on the `@opensip-cli/*` identity.** It is the
  initial public release of the rebranded product. The 35 shared `package.json`
  versions, `CHANGELOG.md`, the `SECURITY.md` supported-release table, and the
  doc set all carry `0.1.0` — the full surface is enumerated in `RELEASING.md`
  → "Version Surfaces (what a bump touches)", and the mechanical sweep is
  automated by `scripts/bump-version.mjs` (with a `--check` drift guard).
- While `0.x`, breaking changes batch into **minor** (`0.y`) bumps; there is no
  no-break-within-a-major guarantee yet. **At `1.0.0` (GA) the strict
  no-break-within-a-major rule begins**, and from then on minor/patch within
  `1.x` remain non-breaking.
- Docs instruct machine-output consumers to pin `schemaVersion`, not the package
  version (see the `--json` reference). The legacy `2.7` migration guide
  (`docs/public/70-reference/07-migrating-to-2.7.md`) belonged to the
  `@opensip-tools/*` identity and does not apply to the fresh `0.x` line.
- **Retire the legacy identity via deprecation, not unpublish.** The
  `@opensip-tools/*` packages (latest `2.13.0`) are retired with
  `npm deprecate '@opensip-tools/<pkg>@*'` (and the legacy CLI name) carrying a
  message that points at the `@opensip-cli/*` / `opensip-cli` replacement —
  **never `npm unpublish`** (irreversible, and blocked anyway by npm's
  300-downloads/week threshold). Run at or after the `0.1.0` launch.
- The release gate is unchanged: `scripts/verify-release.mjs` (single-version
  consistency, dated CHANGELOG entry, generated-doc freshness) + the tag-driven
  `release.yml`.
- **`1.0.0` (GA) is declared via the release announcement + CHANGELOG** when the
  public API freezes and real users depend on it, referencing this ADR.

**Related specs / ADRs:** ADR-0011 (the breaking migration this batch ships, and
the source of the independent `SignalEnvelope.schemaVersion`), ADR-0008
(`SignalBatch.schemaVersion`, the cloud wire-contract version), ADR-0009
(public-API surface policy — the other breaking changes in this batch). Release
mechanics live in `RELEASING.md`; the `2.7.0` change log in `CHANGELOG.md`; the
deferred-GA north star in
`docs/plans/tool-plugin-parity-architecture-2026-06-06.md`.
