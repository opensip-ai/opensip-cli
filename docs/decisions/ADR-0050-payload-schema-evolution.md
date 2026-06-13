---
status: active
last_verified: 2026-06-13
owner: opensip-cli
---

# ADR-0050: payload schema evolution for tool-owned opaque payloads

```yaml
id: ADR-0050
title: payload schema evolution for tool-owned opaque payloads
date: 2026-06-13
status: active
supersedes: []
superseded_by: null
related: [ADR-0025, ADR-0042]
tags: [persistence, contracts, sessions, tool-state, extensibility]
enforcement: mechanizable
enforcement-reason: >
  Fitness architecture check (or engine-local test guard in Phase 8) plus
  explicit requirement in Phase 9/10 verifications that `pnpm fit:ci` /
  `pnpm graph:ci` stay green and new payloads carry __version. The "no tool
  payload types in host" rule is enforced by dependency-cruiser + fitness
  architecture checks + the contracts barrel public-api ratchet test.
```

**Decision:** Tool session payloads (`StoredSession.payload`) and versioned `tool_state` values carry a top-level numeric `"__version": N` (double-underscore, starting at 1). The host (contracts, session-store, datastore, CLI) remains ignorant of concrete tool shapes and only provides a small pure `extractPayloadVersion` helper, the outer `payload_version` storage column (for rare host-contract bumps), structured decode tolerance, warnings on future versions, and best-effort projection for legacy payloads. Tools own their evolution rules (additive = free; breaking = bump + deprecation window).

**Alternatives:**
- Put version only in the table column and force tools to register current version at load time — rejected (couples host to tool internals; doesn't help multiple versioned keys under toolState).
- Use JSON Schema + validation on every write/read — rejected (too heavy for local CLI; schema/code skew is a new failure mode).
- Require full rewrite of all a tool's historical rows on any version bump — rejected (expensive, races, unnecessary for disposable local cache).
- No inner version at all (rely only on structural decoder + "never break the common shape") — the pre-plan status quo; already caused the silent fidelity and future-version detection problems called out in the 2026 audit.

**Rationale:** The design preserves the "host knows nothing about tool shapes" invariant that makes the generic dispatcher + third-party tools possible. The two-level model (outer column + inner JSON __version) + projection + warnings gives detectability without mass data movement. The helper + decode augmentation + per-tool replay projectors give a clean loading story. Guardrails (Phase 8 check/test + Phase 9/10 dogfood ratchet) plus this ADR make the convention durable for first-party and third-party tools. Builds directly on the stopgap outer column + warning added during the audit (migration 0010) and the session-replay / tool-state ADRs.

**Consequences:**
- Every new persisted payload from fitness/graph/simulation (and future tools) will have `"__version": 1` (or higher).
- `decodeSessionPayload` surfaces `payloadVersion` (optional) for observability.
- `hydrate`/`save` and replay paths emit `session.payload.future_version` (or equivalent) diagnostics + logger when outer/inner > supported; degrade to projection.
- `toolState` values for versioned keys should follow the same inner convention (documented, not enforced at host layer).
- Old rows continue to work (one-time warn on first load after upgrade).
- Third-party tool authors get simple guidance: stamp `__version` on your build* payloads and use the helper on replay/get.
- `pnpm fit:ci` and `pnpm graph:ci` (and the architecture slice) must remain green; the guard prevents regression.
- A datastore migration (0011) ensures column safety + records the strategy.

**Enforcement & rollout:**
- See the implementation plan `docs/plans/ready/payload-schema-evolution/plan.md` (phases 0-11) and the spec `docs/plans/specs/payload-schema-evolution.md`.
- Phase 8 owns the guard (test or fitness arch check).
- Phases 9/10 own the roundtrip/legacy/future tests + explicit re-run of dogfood gates with zero net-new architecture/error findings.
- This ADR is the durable record; the plan/spec contain the detailed tasks and cross-cutting contracts (data layer, observability via DiagnosticsBus + RunScope, hardening = defensive legacy=v1 + degrade+warn, no host import of tool payload interfaces, etc.).

**References:**
- Spec + full plan in `docs/plans/specs/payload-schema-evolution.md` and `docs/plans/ready/payload-schema-evolution/`.
- Related: ADR-0025 (session-replay-contract), ADR-0042 (tool-storage-contract-and-state-store).
- Code: `packages/contracts/src/session-types.ts` (StoredSession.payload JSDoc), `packages/core/src/lib/payload-version.ts`, `packages/session-store/src/session-payload-decode.ts`, per-tool `persistence/session-payload.ts` + `session-replay.ts`, `SessionRepo`, `ToolStateRepo`.
- Audit findings around opaque payloads and the 0010 migration.

(Implementation of the plan lands the helper, decode surface, hydrate/save warns + scope usage, engine stamps + replays, migration, guard, tests, and this ADR.)
