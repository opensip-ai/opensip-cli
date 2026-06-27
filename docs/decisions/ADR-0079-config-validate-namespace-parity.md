---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0079: config validate uses the same namespace policy as dispatch

```yaml
id: ADR-0079
title: config validate uses the same namespace policy as dispatch
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0043, ADR-0067]
tags: [config, tools, validation, cli]
enforcement: mechanizable
enforcement-reason: >
  The pure namespace-policy helper is covered in config tests, and CLI coherence
  tests compare pre-dispatch and config validate verdicts for benign unknown
  blocks and loaded-tool namespaces with no config declaration.
```

**Decision:** `opensip config validate` must apply the same unclaimed-namespace
policy as normal pre-dispatch config validation. Unknown top-level blocks remain
forward-compatible warnings only when no loaded tool owns that namespace. A
block named after a loaded tool that did not declare config is a configuration
error.

**Alternatives:**

- **Keep `config validate` warning-only for all unclaimed blocks** - rejected;
  it reported success for a document normal command dispatch would reject.
- **Reject every unclaimed top-level block** - rejected; the catchall remains a
  forward-compatibility seam for future tools and external configuration.
- **Duplicate the branching logic in CLI commands** - rejected; drift between
  validate and dispatch was the bug.

**Rationale:** Config validation is useful only if it predicts command behavior.
ADR-0067 made `config validate` reuse the composed schema, but the namespace
claim policy had two call-site implementations. The loaded-tool/no-config case
is an authoring or packaging bug, not a benign future namespace.

**Consequences:**

- The pure `partitionUnclaimedNamespaces` helper owns the policy.
- `config validate` and pre-dispatch validation agree on warning vs error.
- Tools that own a config namespace must declare it through the Tool config
  contribution; otherwise user config for that namespace fails fast.

**Fitness check:** Covered by config command coherence tests. No separate
project-local fitness check is warranted because the invariant is data-policy
parity, not a source-path pattern.
