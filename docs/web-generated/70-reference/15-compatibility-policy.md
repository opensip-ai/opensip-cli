---
status: current
last_verified: 2026-07-02
release: v0.5.1
title: "Compatibility policy"
audience: [ci-integrators, plugin-authors, contributors]
purpose: "The public compatibility contract classes, version markers, deprecation posture, and migration/check lanes for opensip-cli."
source-files:
  - packages/core/src/lib/compatibility-policy.ts
  - packages/core/src/lib/config-version.ts
  - packages/config/src/migration.ts
  - packages/contracts/src/signal-envelope.ts
  - packages/contracts/src/command-outcome.ts
  - packages/core/src/types/signal-batch.ts
  - scripts/compatibility-matrix.mjs
related-docs:
  - ./01-cli-commands.md
  - ./03-configuration.md
  - ./04-json-output-schema.md
  - ./13-verifiable-releases.md
  - ../../decisions/ADR-0121-platform-compatibility-lts-policy.md
---
# Compatibility policy

OpenSIP CLI has multiple public surfaces. They do not all version the same way,
so the CLI records them as named compatibility contract classes in
`COMPATIBILITY_POLICIES`.

| Contract class | Current marker | Owner | Compatibility rule |
|---|---:|---|---|
| `cli-command-surface` | 1 | `opensip-cli` | Command removals or semantic flag changes require a command-surface snapshot update and release note. |
| `project-config` | 1 | `@opensip-cli/config` | Schema bumps require `opensip config migrate` support before the strict loader can require the new shape. |
| `public-json` | 2 | `@opensip-cli/contracts` | `SignalEnvelope.schemaVersion` is the inner run-output version; optional fields are additive. |
| `tool-plugin-api` | current `PLUGIN_API_VERSION` | `@opensip-cli/core` | Tool manifests are admitted through the plugin API compatibility range. |
| `cloud-wire` | 1 | `@opensip-cli/core` | `SignalBatch.schemaVersion` is the OpenSIP Cloud egress wire version. |
| `release-artifact` | 1 | root release scripts | Release manifest/SBOM/attestation shape changes require verifier updates. |
| `datastore-payload` | 1 | `@opensip-cli/datastore` | Generic session rows stay host-owned; payload additions must be optional or migrated. |

The registry lives in
[`packages/core/src/lib/compatibility-policy.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.5.1/packages/core/src/lib/compatibility-policy.ts)
and is re-exported from `@opensip-cli/contracts` for public consumers.

## Project config migration

Use:

```bash
opensip config migrate
opensip config migrate --dry-run
opensip config migrate --check
```

`--check` is the CI form. It does not write and exits 2 if the config would be
changed. The current migration normalizes legacy files to `schemaVersion: 1`;
future schema bumps add deterministic transforms here before the strict
dispatcher loader requires the new version.

## Compatibility matrix gate

CI runs:

```bash
pnpm compat:matrix:ci -- --out compatibility-matrix-report.json
```

The matrix checks:

- every registered contract class has a policy row;
- policy versions match exported code constants;
- public JSON fixtures match `SIGNAL_ENVELOPE_SCHEMA_VERSION` and
  `COMMAND_OUTCOME_CONTRACT_VERSION`;
- cloud wire fixtures match `SIGNAL_BATCH_SCHEMA_VERSION`;
- project-config fixtures migrate deterministically.

The checked-in matrix is `.config/compatibility-matrix.json`; public fixtures
live under `scripts/compat/fixtures/`.

## Contributor rule

If a change touches any public contract surface, update the policy, fixture,
documentation, and tests in the same PR. Do not weaken a guardrail just to make a
breaking change pass quietly.
