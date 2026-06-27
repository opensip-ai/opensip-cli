---
status: active
last_verified: 2026-06-27
owner: opensip-cli
---

# ADR-0086: Additive `signal.repair` structured-repair contract

```yaml
id: ADR-0086
title: Additive signal.repair structured-repair contract
date: 2026-06-27
status: active
supersedes: []
superseded_by: null
related: [ADR-0050]
tags: [signals, agents, contracts]
enforcement: not-mechanizable
enforcement-reason: >
  Field shape is TypeScript-enforced; additivity follows the persistence policy;
  producer honesty ("never invent a fake autofix") is a semantic judgment not
  structurally detectable.
```

**Decision:** Add an optional nested `signal.repair?: SignalRepair` on core
`Signal` (not flattened top-level fields), additive with no
`SignalEnvelope.schemaVersion` bump. It round-trips through the opaque session
payload and OpenSIP JSON output; SARIF deliberately omits it (no native slot).

**Alternatives:**

- **Flatten `repairKind` / `autofixable` / … as top-level `Signal` fields** —
  rejected; bloats the hot `Signal` shape.
- **Reuse the freeform `metadata` bag** — rejected; untyped, no contract.
- **Bump `schemaVersion` to 3** — rejected; additive optional fields are
  forward-compatible by policy ([ADR-0050](ADR-0050-payload-schema-evolution.md)).

**Rationale:** Agents need a typed repair envelope distinct from freeform
`metadata` and legacy `fixAction` hints. Nesting keeps the top-level signal
small; producers opt in per finding with honest `repairKind` values.

**Consequences:**

- JSON and session replay carry `repair`; SARIF export does not — documented in
  the JSON schema reference.
- Producers must not invent fake autofixes; `suggestedCommand` must be safe and
  must not mutate baselines or suppressions.

**Fitness check:** **No check warranted** — the field shape is enforced by the
TypeScript type system; additivity is guaranteed by the persistence policy; and
the producer-honesty rule is a semantic judgment not structurally detectable (a
check cannot distinguish an honest `autofixable:true` from a dishonest one).