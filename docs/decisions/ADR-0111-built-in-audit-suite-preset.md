---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0111: Ship Audit As A Built-In Suite Preset

```yaml
id: ADR-0111
title: Ship audit as a built-in suite preset
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0093, ADR-0100, ADR-0110]
tags: [suite, agents, audit, cli]
fitness-check: "No check warranted — dependency-cruiser, command-spec tests, and e2e tests enforce this local suite-plane behavior; no new cross-package structural invariant is introduced."
```

**Decision:** Ship `audit` as a CLI-owned built-in suite preset. `opensip suite
run audit` resolves to data shaped like `SuiteDefinition` when the user has not
defined `suites.audit`; a user-defined `suites.audit` wins. The preset composes
existing first-party tools through the host-owned suite plane and returns the
same `SuiteRunResult` / `ReviewBrief` contract as any other suite.

**Alternatives:**

- Add a new top-level `opensip audit` command. Rejected because it would bypass
  ADR-0093's suite plane and create a second composition path for multi-tool
  review workflows.
- Document a copy-paste suite recipe only. Rejected because the first-run and PR
  review lane needs one memorable command before a user has learned suite YAML.
- Add suite-level aggregate SARIF now. Rejected for this phase because ADR-0110
  explicitly defers review-brief SARIF until an evidence-authority or GitHub
  Action decision defines the aggregate mapping.

**Rationale:** The suite runner already owns one-scope orchestration, per-step
verdict aggregation, and host-owned review brief construction. A built-in suite
preset gives new users the product workflow without weakening the underlying
guardrails: every step still validates through `validateSuite`, tool output still
flows through documented host seams, and source tools keep their own SARIF and
baseline behavior.

**Consequences:**

- `opensip suite run audit` and `opensip suite run audit --changed --json` work
  without a user-authored `suites.audit` block.
- The built-in preset stores command-spec names (`fitness`, `impact`, `yagni`);
  CLI aliases such as `fit` stay presentation sugar at the Commander layer.
- `opensip suite list` includes the built-in `audit` suite unless config defines
  `suites.audit`.
- Suite-level workflow flags (`--changed`, `--since`, `--files`) propagate only
  to steps whose `CommandSpec` declares the matching option; explicit step args
  override propagated values.
- There is still no top-level `opensip audit` command.
- Aggregate suite SARIF remains deferred; users keep using source-tool SARIF
  until the GitHub Action/evidence-authority work defines that contract.

**Related specs / ADRs:** Spec 24 (audit suite preset),
[ADR-0093](ADR-0093-host-owned-suite-plane.md),
[ADR-0100](ADR-0100-suite-per-step-verdict-and-aggregate-output.md),
[ADR-0110](ADR-0110-host-owned-review-brief-contract.md).
