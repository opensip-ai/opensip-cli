---
status: active
last_verified: 2026-07-23
owner: opensip-cli
---

# ADR-0181: Structured error definitions and failure envelope

```yaml
id: ADR-0181
title: Structured error definitions and failure envelope
date: 2026-07-23
status: active
supersedes: []
superseded_by: null
related: [ADR-0060, ADR-0066, ADR-0077, ADR-0078, ADR-0135, ADR-0175, ADR-0176, ADR-0180]
tags: [errors, contracts, core, cli]
enforcement: mechanizable
enforced-by: ['type-structural', 'script:error-resiliency-inventory.test.mjs', 'script:failure-envelope.test', 'script:error-definition.test', 'script:error-catalog.test']
```

**Decision:** Application failures use immutable `ErrorDefinition` values (orthogonal source, responsibility, kind, retry, severity, exposure, exit class) assembled via package/tool catalogs — never import-time mutable registries. Thrown values normalize once into a versioned `FailureEnvelope` with public/machine/operator projections; human messages and class names do not drive machine classification.

**Alternatives:**

- **Subclass-only hierarchy** — rejected; collides with cross-copy `instanceof` under pnpm inject and overloads kind/source/responsibility into one type tree.
- **Message-substring control plane** — rejected; brittle for agents, localization, and worker IPC.
- **Process-global error registry** — rejected; violates RunScope/per-invocation composition and plugin isolation.

**Rationale:** OpenSIP must distinguish user, application, infrastructure, and external failures for gates, MCP, and operators. Definitions travel with errors (and wire projections) so dynamic tools need not share a host-local registry. The envelope is total (hostile inputs degrade per node) and reuses ADR-0175/0180 bounded JSON/finite-number planes. Execution severity stays distinct from `SignalSeverity` and `ToolRunOutcome` (ADR-0060); host derives outcomes from phase + credible evidence.

**Consequences:**

- Authors register codes in frozen catalogs (`defineErrorCatalog`); tools optionally contribute via `ToolExtensionPoints.errorCatalog` (`TOOL_CONTRACT_VERSION` ≥ 1.1.0).
- `ToolError` preserves definition, bounded metadata, structural brand; prefer `createToolError(def, message)`.
- CLI `reportFailure` / last-resort net / worker wire consume envelope projections; raw stacks are not the primary public surface.
- Published codes are append-only public API; replacements use `supersededBy`.

**Related ADRs:** ADR-0060 (diagnostics/run outcomes), ADR-0077 (`reportFailure`), ADR-0175 (JSON-safe diagnostics), ADR-0176 (bootstrap diagnostics fold), ADR-0180 (finite numbers), ADR-0183 (retry/cancel/sinks).
