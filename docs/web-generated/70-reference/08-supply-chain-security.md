---
status: current
last_verified: 2026-06-07
release: v0.1.13
title: "Supply-chain security"
audience: [getting-started, ci-integrators, plugin-authors, contributors]
purpose: "How opensip-cli reduces npm-family install risk for customers and how teams can use the package-supply-chain-policy check."
source-files:
  - pnpm-workspace.yaml
  - scripts/verify-supply-chain.mjs
  - packages/fitness/checks-universal/src/checks/security/package-supply-chain-policy.ts
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
related-docs:
  - ./05-checks-index.md
  - ../00-start/00-quick-start.md
  - ../50-extend/03-publishable-packs.md
---
# Supply-chain security

OpenSIP CLI is distributed through npm, so customer safety depends on two
layers:

1. **The artifacts we publish.** OpenSIP releases must not contain package-level
   install hooks, must be built from frozen dependencies, and must be published
   with npm trusted publishing/provenance.
2. **The customer's package manager.** npm, pnpm, and Bun can still execute
   dependency lifecycle scripts during install unless the customer disables or
   allowlists them. That means the curl installer is safer
   after these gates, but it is not a zero-risk operation.

The project intentionally does not rely on a custom chained-checksum system.
Lockfiles already contain integrity hashes for registry tarballs, package
manager pins keep the install tool stable, and npm provenance ties published
packages back to the GitHub Actions release job. The checks below make those
standard controls explicit and fail closed.

---

## What OpenSIP enforces before publish

`pnpm supply-chain:verify` runs in both CI and the release workflow. It fails if:

- Any publishable OpenSIP package declares `preinstall`, `install`, or
  `postinstall`.
- The root package manager is not pinned as an exact `pnpm@...+sha512...`
  Corepack value.
- `pnpm-workspace.yaml` loses the hardened install policy:
  `allowBuilds`, `minimumReleaseAge`, `minimumReleaseAgeStrict`,
  `minimumReleaseAgeIgnoreMissingTime`, `trustPolicy: no-downgrade`,
  `trustLockfile: false`, and `blockExoticSubdeps: true`.
- GitHub workflows use mutable dependency install commands without lockfile
  enforcement, such as pnpm without `--frozen-lockfile` or Bun without
  `--frozen-lockfile`.
- An npm publish workflow lacks `id-token: write`, omits `--provenance` on an
  executable `npm publish` step (including commands inside shell functions), or
  references long-lived npm publish tokens in a publish step. A classic token used
  solely for `npm dist-tag add` promotion in an OIDC publish workflow is the
  documented exception (OIDC does not cover dist-tag).

### Producer provenance lane

Ordinary OpenSIP releases publish with **OIDC trusted publishing** and
`npm publish <tarball> --provenance`. `pnpm supply-chain:verify` gates this in CI
and `release.yml` before publish. The only documented non-provenance exception is
the one-time bootstrap for brand-new package names — see `RELEASING.md`.

**Consumption-side verification** (install/load provenance checks for third-party
packages) is a separate trust gate coordinated with
[ADR-0068](https://github.com/opensip-ai/opensip-cli/blob/v0.1.13/docs/decisions/ADR-0068-consumption-side-verification-policy.md) and
[ADR-0061](https://github.com/opensip-ai/opensip-cli/blob/v0.1.13/docs/decisions/ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md).
It is **not** enforced by the reusable check or the release gate in this repo yet.

The release workflow still installs npm 11 into a separate prefix because npm
11 is required for the trusted-publishing token exchange. The supply-chain gate
allows that package-manager bootstrap while continuing to reject mutable project
dependency installs.

### Dependency update hygiene

Dependency update PRs are opened by **Dependabot** (see
[ADR-0069](https://github.com/opensip-ai/opensip-cli/blob/v0.1.13/docs/decisions/ADR-0069-dependency-hygiene-automation-policy.md)) on a
weekly cadence. Automation is additive — it does not replace human review.

Every dependency merge still passes:

- `pnpm install --frozen-lockfile` in CI
- `pnpm-workspace.yaml` release-age and trust-policy controls (`minimumReleaseAge`,
  `trustPolicy: no-downgrade`, exact `trustPolicyExclude` / `minimumReleaseAgeExclude`
  entries reviewed by maintainers)
- `pnpm supply-chain:verify`

Trust-policy exemptions are exact-version and hand-reviewed; Dependabot does not
edit `pnpm-workspace.yaml` automatically.

---

## Customer install risk

For the global CLI install:

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
```

OpenSIP's release gate protects customers from OpenSIP package-level install
hooks and from releases published with long-lived npm tokens. The remaining
risk is mostly outside the OpenSIP tarballs:

- The installer script is source-controlled at `scripts/install.sh` and presents
  quieter customer-facing output.
- npm may run lifecycle scripts from third-party dependencies during install.
- A freshly compromised dependency version could be pulled if the customer asks
  for `latest` before the ecosystem has had time to take it down.
- A compromised registry account, package-manager bug, or local machine
  compromise can still affect the install.

For highly sensitive environments, prefer a pinned version and install through
an internal mirror or vetted cache:

```bash
curl -fsSL https://opensip.ai/cli/install.sh | OPENSIP_CLI_VERSION=0.1.13 bash
```

Customers who globally disable npm lifecycle scripts should test the CLI in
their environment first; native dependencies in the dependency graph may require
their own install/build step even when OpenSIP packages do not.

---

## Using the reusable check

The universal check pack now includes `package-supply-chain-policy`. It inspects
package metadata, root lockfiles, package-manager config, and GitHub workflows
for npm/pnpm/Bun projects.

Run it directly:

```bash
opensip fit --check package-supply-chain-policy
```

It reports:

- Missing or non-exact `packageManager` pins.
- Missing or conflicting lockfiles.
- Registry or remote lockfile entries without integrity hashes.
- Mutable git, URL, tarball, or local path dependency specs.
- Package install lifecycle hooks.
- Missing pnpm `allowBuilds`, npm script policy, or Bun
  `trustedDependencies`.
- Missing release-age gates.
- CI install commands that are not frozen.
- npm publish workflows that lack OIDC/provenance or still use publish tokens.

This check is useful for OpenSIP customers too: it turns the same supply-chain
posture into a normal fitness rule they can add to their own CI.
