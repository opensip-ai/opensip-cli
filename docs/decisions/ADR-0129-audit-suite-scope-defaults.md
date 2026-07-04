---
status: active
last_verified: 2026-07-03
owner: opensip-cli
---

# ADR-0129: Record audit suite scope defaults

```yaml
id: ADR-0129
title: Record audit suite scope defaults
date: 2026-07-03
status: active
supersedes: []
superseded_by: null
related: [ADR-0111, ADR-0085, ADR-0093]
tags: [suite, audit, changed-scope, cli]
enforcement: not-mechanizable
enforcement-reason: >
  No check warranted: the stamped SuiteRunResult.scope field is enforced by
  TypeScript, while the default/fallback behavior is host-plane control flow
  covered by resolver, orchestrator, command-spec, and end-to-end tests. Existing
  dependency-cruiser and seam checks already fence the structural boundaries.
```

**Decision:** The built-in `audit` suite runs changed-scope by default when the
host can resolve git changes, exposes `--full` as the whole-repo opt-out, falls
back to full scope with one suite-level notice outside git, and stamps the
resolved scope on `SuiteRunResult.scope`.

**Alternatives:**

- Keep the status quo: blind changed default, per-step degradation, no opt-out,
  and no scope field. Rejected because first-run output hid what was scanned and
  non-git directories produced noisy per-tool fallback behavior.
- Add a top-level `opensip audit` command with separate defaults. Rejected by
  ADR-0111 because it creates a second composition path outside the suite plane.
- Make each tool decide suite defaults independently. Rejected because the
  first-run and PR lane need one host-owned scope story across tools.

**Rationale:** ADR-0111 made `audit` the memorable PR-review preset, but the
changed-by-default behavior shipped before this ADR captured the scope semantics.
The CLI host already owns changed-file resolution through ADR-0085, and the
suite plane already owns multi-tool composition through ADR-0093. Resolving scope
once in the host lets `opensip suite run audit` say exactly whether it is scanning
changed files or the full repo, while compatible steps still run their own
authoritative selector and impact-trust logic.

**Consequences:** CI lanes that require deterministic scope should pass explicit
flags (`--changed`, `--since`, `--files`, or `--full`). Explicit selectors remain
changed-scoped even when suite-level enrichment cannot count files; tool-side
fallback semantics still decide how each step handles unavailable git or graph
evidence. Older stored suite payloads may omit `scope`; renderers treat absence
as "not recorded".

**Related specs / ADRs:** Extends [ADR-0111](ADR-0111-built-in-audit-suite-preset.md)
and relies on [ADR-0085](ADR-0085-change-detection-substrate.md) plus
[ADR-0093](ADR-0093-host-owned-suite-plane.md). Implemented by
`docs/plans/ready/audit-suite-ergonomics/`.
