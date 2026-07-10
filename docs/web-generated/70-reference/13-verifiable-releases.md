---
status: current
last_verified: 2026-07-07
release: v0.5.1
title: "Verifiable releases"
audience: [getting-started, ci-integrators, contributors]
purpose: "How opensip-cli release artifacts are checksummed, attested, published, and verified."
source-files:
  - .github/workflows/release.yml
  - scripts/build-release-artifacts.mjs
  - scripts/verify-release-artifacts.mjs
  - scripts/lib/release-artifacts.mjs
  - scripts/verify-supply-chain.mjs
related-docs:
  - ./08-supply-chain-security.md
  - ../60-guides/03-wire-into-ci.md
---
# Verifiable releases

Every OpenSIP CLI tag release publishes normal npm packages and three GitHub
Release verification files:

| File | Purpose |
|---|---|
| `opensip-cli-release-manifest.v1.json` | JSON manifest for every packed npm tarball plus the release SBOM. Records release version, git tag, git SHA, size, and SHA-256 digest. |
| `SHA256SUMS` | shasum-compatible digest list for every manifest subject plus the manifest itself. |
| `opensip-cli-sbom.cyclonedx.json` | CycloneDX 1.6 release-set SBOM for the publishable OpenSIP packages and their declared direct dependency edges. |

The manifest deliberately does **not** include its own digest. That would be
circular. `SHA256SUMS` is the object that records the manifest digest.

## Release Lane

The release workflow packs the npm tarballs, then runs:

```bash
node scripts/build-release-artifacts.mjs \
  --dir /tmp/tarballs \
  --expected-version "$RELEASE_TAG" \
  --git-tag "$RELEASE_TAG" \
  --git-sha "$GITHUB_SHA"

node scripts/verify-release-artifacts.mjs \
  --dir /tmp/tarballs \
  --manifest /tmp/tarballs/opensip-cli-release-manifest.v1.json \
  --expected-version "$RELEASE_TAG"
```

Only after local hash verification passes does the workflow smoke-test the
packed bytes, publish to npm, promote to `latest`, and create the GitHub Release.

The workflow also creates GitHub Artifact Attestations with a pinned
`actions/attest` commit SHA:

- provenance over the tarballs, manifest, and SBOM listed in `SHA256SUMS`
- a separate provenance attestation for `SHA256SUMS`
- an SBOM attestation using `opensip-cli-sbom.cyclonedx.json`

`pnpm supply-chain:verify` gates these workflow invariants, including the pinned
attestation action, `attestations: write`, `artifact-metadata: write`, and the
release asset upload list.

## Verify Hashes

To verify a full release set from a checkout of this repository:

```bash
VERSION=0.4.2
TAG="v$VERSION"
mkdir -p "/tmp/opensip-cli-$TAG"

gh release download "$TAG" \
  --repo opensip-ai/opensip-cli \
  --dir "/tmp/opensip-cli-$TAG" \
  --pattern opensip-cli-release-manifest.v1.json \
  --pattern SHA256SUMS \
  --pattern opensip-cli-sbom.cyclonedx.json

pushd "/tmp/opensip-cli-$TAG"
while IFS= read -r pkg; do
  if [ "$pkg" = "opensip-cli" ]; then
    npm pack "opensip-cli@$VERSION"
  else
    npm pack "@opensip-cli/$pkg@$VERSION"
  fi
done < <(node /path/to/opensip-cli/scripts/release-package-order.mjs --print names)
popd

node scripts/verify-release-artifacts.mjs \
  --dir "/tmp/opensip-cli-$TAG" \
  --manifest "/tmp/opensip-cli-$TAG/opensip-cli-release-manifest.v1.json" \
  --expected-version "$TAG"
```

The verifier is offline for hashes: it reads local files, validates the manifest
schema, rejects unsafe paths, checks size and SHA-256 for every manifest subject,
requires `SHA256SUMS` to match every manifest subject, and checks that
`SHA256SUMS` includes the manifest digest.

## Verify Provenance

Hash verification proves the local bytes match the release manifest. Provenance
verification proves GitHub signed attestations for those subjects from the
`opensip-ai/opensip-cli` repository.

Online verification through GitHub's attestation service:

```bash
gh attestation verify "/tmp/opensip-cli-$TAG/opensip-cli-release-manifest.v1.json" \
  --repo opensip-ai/opensip-cli

gh attestation verify "/tmp/opensip-cli-$TAG/SHA256SUMS" \
  --repo opensip-ai/opensip-cli
```

For offline or mirrored verification, download the bundle and trusted root first,
then verify with the GitHub CLI:

```bash
gh attestation download "/tmp/opensip-cli-$TAG/opensip-cli-release-manifest.v1.json" \
  --repo opensip-ai/opensip-cli \
  > "/tmp/opensip-cli-$TAG/manifest-attestation.jsonl"

gh attestation trusted-root > "/tmp/opensip-cli-$TAG/trusted-root.jsonl"

gh attestation verify "/tmp/opensip-cli-$TAG/opensip-cli-release-manifest.v1.json" \
  --repo opensip-ai/opensip-cli \
  --bundle "/tmp/opensip-cli-$TAG/manifest-attestation.jsonl" \
  --custom-trusted-root "/tmp/opensip-cli-$TAG/trusted-root.jsonl"
```

`scripts/verify-release-artifacts.mjs --bundle ... --trusted-root ...` does not
claim provenance itself; it prints the exact `gh attestation verify` command
after local hash verification succeeds.
