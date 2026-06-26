# Supply-chain dependency hygiene improvement process

Internal contributor workflow for dependency updates. Public posture:
`docs/public/70-reference/08-supply-chain-security.md`. Decision record:
[ADR-0069](../decisions/ADR-0069-dependency-hygiene-automation-policy.md).

## Automation

- **Tool:** Dependabot (`.github/dependabot.yml`)
- **Owner:** `opensip-cli` maintainers
- **Cadence:** weekly (Monday) for npm/pnpm and GitHub Actions
- **Scope:** root `package.json` + `pnpm-lock.yaml`; `.github/workflows/*.yml`
- **Out of scope:** `pnpm-workspace.yaml` trust-policy exemptions (`trustPolicyExclude`,
  `minimumReleaseAgeExclude`, `allowBuilds`) — human-reviewed only

## Triage

1. Read the Dependabot PR title/labels (`dependencies`, `github-actions`).
2. Confirm CI is green: `pnpm install --frozen-lockfile`, `pnpm supply-chain:verify`,
   `pnpm test`, `pnpm lint`.
3. For patch/minor grouped PRs: spot-check release notes for install-script or
   native-build changes.
4. For **major** PRs (separate, ungrouped): require maintainer review of breaking
   changes and dogfood gates (`pnpm fit:ci`, `pnpm graph:ci`).

## Packages lacking provenance attestation

When a dependency version lacks npm provenance attestation:

- Prefer waiting for `minimumReleaseAge` to elapse unless a security advisory
  forces an exception.
- Document the exception in the PR body; do not add a standing `trustPolicyExclude`
  without justification.

## Updating trust-policy exemptions

Edits to `pnpm-workspace.yaml` `minimumReleaseAgeExclude` or `trustPolicyExclude`:

1. Use **exact versions** only (no ranges).
2. State the reason in the PR (upstream bug, missing attestation, blocked release).
3. Re-run `pnpm supply-chain:verify` — the gate asserts policy shape stays
   fail-closed.

## Manual fallback

If automation is disabled, run a monthly manual audit:

```bash
pnpm outdated -r
pnpm supply-chain:verify
pnpm install --frozen-lockfile && pnpm test && pnpm lint
```

Record the audit date in this file's `last_verified` frontmatter when performed.