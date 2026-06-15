---
status: active
last_verified: 2026-06-08
owner: opensip-cli
---

# ADR-0024: One CommandOutcome currency, a diagnostics bus, and a governed env surface

```yaml
id: ADR-0024
title: One CommandOutcome currency, a diagnostics bus, and a governed env surface
date: 2026-06-08
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0012, ADR-0021, ADR-0023]   # signal output currency; versioning; flag currency; config package
tags: [output, observability, plugin-parity, contracts, cli]
enforcement: mechanizable
enforcement-reason: >
  Three fitness checks (release 2.12.0) fail CI on bypass: `one-outcome-shape`
  (no bare {error}/raw-JSON machine output outside the renderer),
  `no-local-exit-or-stdout` (no process.exit; exit codes flow through the one
  boundary), and `env-via-registry` (no raw process.env reads). Each ships with a
  teeth fixture.
```

**Decision:** Adopt `CommandOutcome<T>` as the single OUTER currency for every
command result and error — including the pre-handler bootstrap failures. The host
ASSEMBLES it (stamping `kind`/`status`/`exitCode`/`diagnostics`) from each
handler's unchanged pure-domain return, and serializes it through one renderer.
`--json` now nests the byte-identical `SignalEnvelope` under `.envelope` (run
commands) / a `CommandResult` under `.data` / structured `errors` (failures) — the
one user-visible breaking change before GA. A scope-owned `RunDiagnostics` bus
rides on every outcome, and every environment read flows through one `EnvRegistry`.

**Alternatives:**

- **Keep the drifting outer shapes (bare envelope / bare `CommandResult` / bare
  `{ error }`), defer a wrapper to 3.0.0.** Rejected: `--json` stays broken for the
  highest-friction failures (no-project, bad-schema) across all of 2.x — the very
  failures where a machine consumer most needs structure (north-star §4.7).
- **Have the handler return a `CommandOutcome`.** Rejected: it pushes host currency
  assembly into every tool — the opposite of shielding — and is impossible anyway,
  because `diagnostics` is scope-collected (a handler cannot assemble it). The
  2.11.0 command-plane spec's "no handler contract change" stands.
- **Per-package env helpers / leave inline `process.env` reads.** Rejected: the env
  surface stays ungoverned — no docs, coercion, alias, or deprecation policy, and
  invisible to any generated reference.
- **A module-level diagnostics singleton.** Rejected: violates the no-module-
  singleton rule (ADR-0023 lineage); concurrent/embedded/SaaS runs must isolate.

**Rationale:** `SignalEnvelope` (ADR-0011) is a strong INNER currency, but the
outer shape drifted and the bootstrap bypassed the renderer entirely
(`process.exit` + raw stream writes). One outer schema for every outcome is what
lets renderers, dashboards, automation, and tests consume a single shape. Host
assembly keeps provenance from mattering: a bundled tool and an external tool emit
the identical outcome because the host — not the tool — stamps it. The dispatch
seam the 2.11.0 command plane deliberately built
(`packages/cli/src/commands/mount-command-spec.ts` → the host emit seams) made the
swap land in the seams, not the handlers. Diagnostics defined in
`@opensip-cli/core` (the bus that produces it) and re-exported by `contracts`
(where `CommandOutcome` names it) follows the established manifest/command-spec
cross-layer pattern.

**Consequences:**

- **Breaking (`--json`).** Consumers migrate from reading the top-level envelope to
  `.envelope` (run commands) / `.data` (list/dashboard) / `.errors` (failures).
  Shipped as a 2.x minor with a migration note, exactly like the 2.7.0 `--json`
  break. The inner envelope and all human output are byte-identical.
- New seam `cli.emitError({ message, exitCode, suggestion? })` replaces the bare
  `emitJson({ error })` shape in the raw-stream handlers.
- Bootstrap guards throw a typed `BootstrapError`; the single `parseAsync().catch`
  boundary renders it and sets `process.exitCode` once (no scattered exits).
- Each runtime package declares its `EnvVarSpec`s; `cli/env/host-env-specs.ts`
  composes them + the documented pre-scope exceptions into `describeHostEnv()` for
  the generated env-surface reference.

**Related specs / ADRs:** Implements `docs/plans/specs/release-2.12.0-output-observability.md`
(north-star §5.5 Command outcome, §5.10 Diagnostics, §4.7 bootstrap convergence,
§5.12 Environment registry). Builds on ADR-0011 (inner currency), ADR-0021 (flag
currency), ADR-0023 (config package). Part of the tool-plugin-parity ladder toward
3.0.0 (ADR-0012).
