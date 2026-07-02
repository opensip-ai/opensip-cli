---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0112: No-Init Ephemeral Project Mode

```yaml
id: ADR-0112
title: No-init ephemeral project mode
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0037, ADR-0052, ADR-0093, ADR-0111]
tags: [bootstrap, config, onboarding, suite]
fitness-check: "No check warranted yet — command allowlisting, config synthesis, runtime placement, init migration, and uninstall cleanup are covered by focused unit/e2e tests; the existing architecture checks already guard ToolCliContext and persistence boundaries."
```

**Decision:** `fit`, `graph`, `graph impact`, and `suite run audit` may run in a
directory with no `opensip-cli.config.yml`. The CLI host synthesizes an in-memory
config from language markers, validates it through the same composed config
schema as a file-backed project, and enters `RunScope` with
`ProjectContext.scope: "ephemeral"`. No project files are written. Runtime state
for these no-init runs lives under the user cache at
`~/.opensip-cli/cache/ephemeral/<project-hash>/`.

**Alternatives:**

- Keep failing closed until `opensip init` is run. Rejected because the first
  product experience should prove useful analysis before writing scaffold files.
- Write a temporary `opensip-cli.config.yml` automatically. Rejected because
  project adoption should remain an explicit `opensip init` decision.
- Store no-init sessions in the future project runtime path. Rejected because it
  would create `opensip-cli/` during a command that promised not to initialize.
- Allow every command in no-init mode. Rejected because commands that depend on
  project-authored plugins, installed packs, or persisted catalogs need explicit
  project state.

**Rationale:** The existing config composer and target registry already define
the authoritative runtime contract. Reusing that validation path keeps no-init
mode from becoming a parallel configuration system. The only new behavior is
where the raw document comes from and where runtime state lands before adoption.

The command allowlist is intentionally narrow. `fit` and `graph` can run from
auto-detected source targets, `graph impact` can answer changed-file questions
over those targets, and the built-in `audit` suite can compose the same tools.
Other suites and project-local plugin workflows still require an initialized
project.

**Consequences:**

- Human no-init runs emit a diagnostic hint recommending `opensip init`; JSON,
  help, and SARIF-oriented output stay quiet.
- `opensip init` migrates an existing no-init runtime directory into
  `<project>/opensip-cli/.runtime/` only when that project runtime does not
  already exist.
- `opensip uninstall --project <path>` includes matching no-init runtime state
  in its rebuildable runtime cleanup set.
- Ephemeral config is not a public schema surface and is not persisted in
  sessions as a user-authored config file.
- MCP and commands that replay persisted project state still require initialized
  project state unless a future ADR extends their storage contract.

**Related specs / ADRs:** Spec 25 (no-init first run),
[ADR-0023](ADR-0023-project-config-schema.md),
[ADR-0037](ADR-0037-host-owned-file-targeting.md),
[ADR-0052](ADR-0052-bootstrap-orchestration-state-machine.md),
[ADR-0093](ADR-0093-host-owned-suite-plane.md),
[ADR-0111](ADR-0111-built-in-audit-suite-preset.md).
