---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0069: Dependency hygiene automation policy

```yaml
id: ADR-0069
title: Dependency hygiene automation policy
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0012, ADR-0017]
tags: [supply-chain, dependencies]
enforcement: mechanizable
enforcement-reason: >
  scripts/verify-supply-chain.mjs check 6 and package-supply-chain-policy
  dependency-automation checks when config exists.
```

**Decision:** Use **Dependabot** (`.github/dependabot.yml`) for weekly npm/pnpm and
GitHub Actions update PRs. Group patch/minor updates; leave major updates as
separate PRs requiring maintainer review. **No automerge.** Automation must not
edit `pnpm-workspace.yaml` trust-policy exemptions (`allowBuilds`,
`minimumReleaseAgeExclude`, `trustPolicyExclude`).

**Alternatives:**
- Renovate — rejected for this repo; Dependabot is native and sufficient for scope.
- Manual-only cadence — rejected; automation with human review reduces drift.
- Automerge patch updates — rejected; install-script and native-build risk needs eyes.

**Rationale:** `pnpm-workspace.yaml` already enforces release-age and trust policy.
Dependabot opens PRs; CI + `pnpm supply-chain:verify` remain the merge gate.

**Consequences:** Internal process doc owns triage cadence. Supply-chain gates assert
bounded automation config.

**Fitness check:** Check warranted — `dependency-automation-unsafe-automerge` in
`package-supply-chain-policy` and `verify-supply-chain.mjs` check 6.