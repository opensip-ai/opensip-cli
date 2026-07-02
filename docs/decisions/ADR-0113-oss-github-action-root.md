---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0113: Make The Root GitHub Action OSS-First

```yaml
id: ADR-0113
title: Make the root GitHub Action OSS-first
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0093, ADR-0110, ADR-0111, ADR-0112]
tags: [github-actions, ci, suite, review-brief]
fitness-check: "No check warranted — the invariant is action metadata and script behavior outside packages/; script tests assert the root action has no Cloud inputs and the nested Cloud action keeps its upload inputs, while existing lint/dependency-cruiser rules still guard package layering."
```

**Decision:** The repository root action `opensip-ai/opensip-cli@v1` is the OSS
PR-feedback action. It wraps local `opensip` evidence, runs the built-in `audit`
suite by default, and emits annotations, optional SARIF, optional sticky PR
comments, and stable outputs without requiring OpenSIP Cloud.

Cloud signal handoff is a separate nested action at
`.github/actions/upload-sarif/action.yml` and a direct CLI workflow over
`opensip fit --report-to`.

**Alternatives:**

- Keep the root action as Cloud handoff. Rejected because the root Marketplace
  contract would still require an API key before a new OSS user can get PR
  feedback.
- Add a `mode` or `cloud-token` switch to the root action. Rejected because it
  mixes local review feedback with Cloud upload failure modes and expands the
  root action's trust/secret surface.
- Move OSS feedback to a new repository action immediately. Rejected because the
  `opensip-cli` repository is the natural distribution point for the local CLI
  and already contains the review-brief substrate.

**Rationale:** Specs 05, 24, and 25 made the local path strong enough for a
zero-Cloud action: `suite run audit --json` now works before `init` and returns a
bounded, host-owned review brief. The action can consume that public
`CommandOutcome.data.reviewBrief` contract without adding a new CLI command or
teaching tools about GitHub.

**Consequences:**

- The root action has no `api-key`, `cloud-url`, or Cloud upload inputs.
- `comment: true` uses only the GitHub-provided token and pull-request comments;
  API failures warn and do not change the scan verdict.
- Action-generated SARIF is a bounded projection of the review brief, intended
  for PR annotation convenience. Source-tool SARIF from `fit` and `graph` remains
  the high-fidelity CLI-owned path.
- The prior Cloud action behavior remains available only through the nested
  upload-sarif action path or direct CLI handoff.

**Related specs / ADRs:** Spec 26 (OSS GitHub Action),
[ADR-0011](ADR-0011-signal-output-currency-formatter-sink.md),
[ADR-0093](ADR-0093-host-owned-suite-plane.md),
[ADR-0110](ADR-0110-host-owned-review-brief-contract.md),
[ADR-0111](ADR-0111-built-in-audit-suite-preset.md),
[ADR-0112](ADR-0112-no-init-ephemeral-project-mode.md).
