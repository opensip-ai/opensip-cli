---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0067: Config validate and schema commands

```yaml
id: ADR-0067
title: Config validate and schema commands
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0023]
tags: [cli, config]
enforcement: not-mechanizable
enforcement-reason: >
  Command-surface parity snapshots, completion inventory, and config-command
  tests enforce the mounted `config validate|schema` surface.
```

**Decision:** Add a host `opensip config` group with `validate` and `schema` subcommands. Reuse `buildConfigDeclarations` and `@opensip-cli/config` composition primitives; do not overload `opensip configure` (user-global cloud key UX) or `opensip init`.

**Alternatives:**
- Add flags to `opensip init` — rejected; init is scaffolding, not ongoing validation.
- Overload `opensip configure` — rejected; name collision with user-global settings.
- Maintain a hand-written JSON Schema mirror — rejected; `toJsonSchema(composeConfigSchema(...))` is the single source of truth.

**Rationale:** Operators need to validate `opensip-cli.config.yml` and export editor JSON Schema without running a tool. The dispatcher already composes strict schemas at pre-action time; exposing that composition as commands avoids drift.

**Consequences:** `config validate` throws `ConfigurationError` on invalid documents (exit 2). `config schema` supports `--out` for file export. Neither command opens the datastore.

**Fitness check:** No check warranted — command-surface snapshots and `config-command.test.ts` cover the surface.

**Related specs / ADRs:** [ADR-0023](ADR-0023-config-package-and-schema-registry.md), [Configuration reference](../public/70-reference/03-configuration.md).