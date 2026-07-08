---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0121: Platform Compatibility LTS Policy

```yaml
id: ADR-0121
title: Platform compatibility LTS policy
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0012, ADR-0024, ADR-0065, ADR-0074, ADR-0119]
tags: [compatibility, contracts, config, json, ci]
enforcement: partially-mechanized
enforced-by: ['script:compat:matrix:check']
enforcement-reason: >
  The compatibility registry is source-level code, public fixtures are checked by
  `pnpm compat:matrix:check`, `config migrate --check` covers committed project
  config migration readiness, and command-surface snapshots pin CLI shape. Human
  review is still required for deprecation notes and release communication.
```

**Decision:** OpenSIP CLI records public compatibility surfaces as named
contract classes with explicit version markers, owners, deprecation windows, and
breaking-change gates. Project config changes go through `opensip config
migrate`; public JSON and cloud wire shapes are checked against fixtures in CI.

**Alternatives:**

- Single package semver only: rejected because the CLI has several independent
  contracts (`SignalEnvelope`, cloud wire, config schema, command surface, plugin
  API) that can evolve at different speeds.
- Documentation-only compatibility policy: rejected because stale docs would not
  block regressions. The policy must be represented in code and checked by CI.
- Automatic migration in the strict loader: rejected because a pre-action
  validator should fail closed and deterministic edits should be an explicit
  operator command.

**Rationale:** Spec 11 needs a contributor-visible LTS posture without adding a
platform runtime or model call. A small registry plus a script gate gives release
reviewers one place to inspect compatibility classes, while `config migrate
--check` gives CI a non-mutating way to catch stale project config.

**Consequences:**

- `COMPATIBILITY_POLICIES` is the source of truth for contract classes.
- `SIGNAL_ENVELOPE_SCHEMA_VERSION`, `COMMAND_OUTCOME_CONTRACT_VERSION`, and
  `SIGNAL_BATCH_SCHEMA_VERSION` are exported public version markers.
- `.config/compatibility-matrix.json` and `scripts/compat/fixtures/` are part of
  the release gate.
- Future config schema bumps must ship a migration before the strict loader
  requires the new shape.

**Related specs / docs:**

- `docs/plans/completed/11-platform-compatibility-lts-and-migration.md`
- [Compatibility policy](../public/70-reference/15-compatibility-policy.md)
- [Configuration](../public/70-reference/03-configuration.md)
- [JSON output schema](../public/70-reference/04-json-output-schema.md)
