---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0119: Verifiable self-distribution

```yaml
id: ADR-0119
title: Verifiable self-distribution
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0017, ADR-0068, ADR-0094]
tags: [release, supply-chain, provenance]
enforcement: mechanizable
enforcement-reason: >
  scripts/verify-supply-chain.mjs enforces release.yml permissions, pinned
  actions/attest usage, generation and verification of release artifacts, and
  GitHub Release asset wiring. scripts/__tests__/release-artifacts.test.mjs
  locks the manifest/checksum/SBOM contract.
```

**Decision:** OpenSIP CLI releases must publish verifiable release metadata:
a versioned manifest for packed npm tarballs plus the release SBOM,
`SHA256SUMS` for manifest-subject hashes and the manifest hash, and a CycloneDX
release-set SBOM. The release workflow must create pinned GitHub Artifact
Attestations for those artifacts before publishing immutable npm versions.

**Alternatives:**

- Rely only on npm provenance. Rejected because npm provenance is package-scoped
  and does not give users one manifest/checksum/SBOM surface for the whole
  multi-package release.
- Use direct cosign commands in the release workflow. Rejected for now because
  GitHub Artifact Attestations provide the same Sigstore-backed signing path
  with built-in repository association and a simpler verification story for
  GitHub-hosted releases.
- Generate an npm CLI SBOM from the installed tree. Rejected because this repo is
  pnpm-workspace-only and npm's tree walker treats the virtual store/workspace
  layout as invalid. The release-set SBOM is generated deterministically from
  publishable package manifests instead.

**Rationale:** The repo publishes 42 packages as one release train. A release is
not verifiable enough if each package has separate registry metadata but the
release set has no shared manifest. The manifest and checksum file let operators
verify downloaded tarballs offline. GitHub Artifact Attestations bind the same
subjects to the release workflow identity. The release-set SBOM documents the
OpenSIP package set and declared direct dependency graph without depending on
npm workspace discovery.

**Consequences:**

- `scripts/build-release-artifacts.mjs` and
  `scripts/verify-release-artifacts.mjs` are part of the release contract.
- `release.yml` must generate and verify the release artifacts before smoke
  testing and before `npm publish`.
- `SHA256SUMS` is not listed inside the manifest; it has its own attestation.
- Future release changes that remove attestations, permissions, generated
  artifacts, or release asset uploads must update this ADR and the supply-chain
  verifier in the same PR.

**Related specs / ADRs:**

- [ADR-0017](./ADR-0017-release-gate-policy.md)
- [ADR-0068](./ADR-0068-consumption-side-verification-policy.md)
- [ADR-0094](./ADR-0094-cli-cloud-evidence-authority-and-egress-fidelity.md)
- [Verifiable releases](../public/70-reference/13-verifiable-releases.md)
