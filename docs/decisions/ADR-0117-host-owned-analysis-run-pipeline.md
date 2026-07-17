---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0117: Promote the host-owned analysis run pipeline

```yaml
id: ADR-0117
title: Promote the host-owned analysis run pipeline
date: 2026-07-02
status: active
supersedes: [ADR-0104]
superseded_by: null
related: [ADR-0036, ADR-0051, ADR-0058, ADR-0065, ADR-0097]
tags: [cli, tools, run-pipeline, diagnostics, gates]
enforcement: mechanizable
enforced-by: ['local:deferred-run-pipeline-boundary']
enforcement-reason: >
  The project-local fitness check deferred-run-pipeline-boundary now permits the
  promoted contracts APIs only at approved boundaries and still forbids local
  RunCommandPipeline copies or tool-owned helper definitions.

**Decision:** Promote the deferred host-owned run pipeline as
`defineAnalysisRunCommand` in `@opensip-cli/contracts`, with companion
`readToolConfig` / `readOptionalToolConfig` config helpers and typed lifecycle
event names. A verdict-producing analysis tool supplies domain adapters
(normalize, execute, envelope, session, presentation, optional live, optional
gate); the shared helper owns the repeated command tail: JSON/agent-filtered
output, human rendering, gate dispatch, signal delivery, report opening, SARIF,
lifecycle diagnostics, and session contribution return.

**Alternatives:**

- *Broad all-tool rewrite in one pass.* Rejected: `fit`, `graph`, `sim`,
  external scanners, and `yagni` have different live/worker surfaces. The helper
  boundary should prove itself on one small first-party tool before broader
  migrations.
- *Put the helper in `opensip-cli`.* Rejected: tools cannot depend on the CLI
  composition root, and the command-spec helper is part of the Tool-to-runner
  contract surface.
- *Let tools keep private run helpers.* Rejected: private helpers are how gate,
  delivery, report opening, SARIF, and session behavior drifted. The boundary
  must be shared and guarded.
- *Introduce a broad `RunCommandPipeline` abstraction now.* Rejected: the current
  slice only needs a declarative command helper over existing `ToolCliContext`
  seams. A larger abstraction can be justified later if more migrations expose
  real complexity.

**Rationale:** ADR-0036, ADR-0051, ADR-0058, ADR-0065, and ADR-0097 already make
the host responsible for generic gate policy, timing/session persistence,
shared live shells, public JSON/raw-stream policy, and declared-input stamping.
Before this ADR, a primary analysis command still had to hand-compose much of
that policy in its tool package. `yagni` was the right first migration because it
has a compact command surface but exercises every relevant path: static JSON,
agent filters, human presentation, live rendering, `--gate-save`,
`--gate-compare`, `--sarif`, report opening, advisory exit policy, and returned
session contributions.

The chosen package boundary keeps the helper in `contracts` beside
`definePrimaryRunCommand` and `runHostGateDispatch`. Tools continue to own their
domain work and presentation wording; the helper owns only cross-tool host
choreography over documented `ToolCliContext` seams.

**Consequences:**

- `defineAnalysisRunCommand` is the default authoring helper for new
  verdict-producing primary analysis commands.
- Production tool command normalization should read composed config through
  `readToolConfig` / `readOptionalToolConfig` from `cli.scope.toolConfig`, not by
  re-reading YAML. Scope-less test or worker fallback loaders may remain only as
  explicit legacy/test bridges.
- `RunCommandPipeline` remains reserved. A broader pipeline object needs a new
  ADR/spec and an updated guard boundary.
- `yagni` no longer owns a separate gate-mode command helper. Its command uses
  the shared helper and the existing `runHostGateDispatch` host plane.
- The `deferred-run-pipeline-boundary` fitness check stays active, renamed in
  meaning: it now enforces approved boundaries instead of total deferral.

**Related ADRs:** Supersedes [ADR-0104](ADR-0104-defer-host-owned-run-pipeline.md). the promoted host-owned run pipeline roadmap item. See [ADR-0036](ADR-0036-host-owned-baseline-ratchet-md), [ADR-0051](ADR-0051-host-owned-run-lifecycle-timing.md), [ADR-0058](ADR-0058-shared-live-run-shell.md), [ADR-0065](ADR-0065-public-json-output-and-raw-stream-policy.md), and [ADR-0097](ADR-0097-gate-verdict-determinism.md).
