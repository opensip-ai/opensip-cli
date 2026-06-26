---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0071: Credential handling policy

```yaml
id: ADR-0071
title: Credential handling policy
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0008, ADR-0023]
tags: [security, config, credentials]
enforcement: mechanizable
enforcement-reason: >
  cliConfigSchema rejects project cli.apiKey; whole-document and loadCliDefaults
  tests enforce the decision.
```

**Decision:** API keys are accepted only from **`--api-key`**, **`OPENSIP_API_KEY`**,
or **`~/.opensip-cli/config.yml#apiKey`**. **Reject** `cli.apiKey` in project
`opensip-cli.config.yml` with `CONFIGURATION_ERROR`. Preserve atomic **`0o600`**
writes for user config. `configure` continues to mask keys in output.

**Alternatives:**
- Retain project `cli.apiKey` for controlled environments — rejected; commit risk
  outweighs convenience.
- Platform keychain storage — deferred; file-based user config with `0o600` is sufficient
  for current scope.

**Rationale:** Project config is version-controlled; literal keys leak via git. User
config is the intended persistent secret store with tightened permissions.

**Consequences:** Config docs and precedence updated. Permissive `loadCliDefaults`
drops project `apiKey` silently; strict composer validation errors.

**Fitness check:** Check warranted — config schema/tests forbid project literal keys;
no separate fitness check needed beyond those tests.