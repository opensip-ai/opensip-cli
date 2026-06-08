---
status: active
last_verified: 2026-06-08
owner: opensip-tools
---

# ADR-0027: GA — the tool-plugin parity cutover (remove the privileged paths)

```yaml
id: ADR-0027
title: GA — the tool-plugin parity cutover (remove the privileged paths)
date: 2026-06-08
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0012, ADR-0021, ADR-0023, ADR-0024, ADR-0026]   # output currency; versioning + 3.0.0 reservation; flag currency; config package; command outcome; graph selection-only
tags: [plugin-parity, cli, core, ga, breaking]
enforcement: mechanizable
enforcement-reason: >
  The cutover is held by enforcement, not convention: `no-bootstrap-tool-import`
  (checks-typescript) forbids a static tool-runtime import in the host;
  `register()` removal is enforced by the type system (the member is gone from the
  Tool contract); `checkCompatibility(undefined) ⇒ incompatible` is unit-pinned;
  and `parity-invariants.test.ts` asserts every one of the nine §8 completion
  invariants maps to a live check (the index at
  docs/internal/parity-invariant-index.md). The §1 acceptance test
  (fit-external-load.test.ts) is the executable GA bar.
```

**Decision:** At 3.0.0, remove the three privileged first-party paths the 2.x
ladder built *alongside* the parity planes, so the only thing distinguishing a
bundled tool from an installed or project-local one is **source of installation,
never lifecycle** (north-star §1). Specifically: (1) **unify the loader** — bundled
tools load by name through the same `loadToolManifest → admitTool → dynamic import
→ register` path an external tool travels (no static `import { fitnessTool }` in
the host); (2) **remove `Tool.register()` and the raw-Commander `program` handle**
from the contract — `commandSpecs` is the one command surface; (3) **end the
`apiVersion` grace window** — a tool declaring no epoch is fail-closed (explicit) /
skipped (discovered). The acceptance test (`fit` loaded through the plugin path ≡
the bundled mount) is the GA bar, and all nine §8 completion invariants are live
guardrails. This realizes the 3.0.0 reservation ADR-0012 set aside.

**Alternatives:**

- **Keep bundled static imports; add only an externalization test.** Rejected:
  the host still compiles `fit` in, so "delete the hardcoded import of `fit`"
  stays impossible — the acceptance test could never reach *yes*.
- **Keep `register()` deprecated past GA (a longer grace tail).** Rejected: all
  three tools moved to `commandSpecs` in 2.11.0, so the fallback is dead weight
  that keeps raw Commander reachable; "one command surface" is binary.
- **Treat a missing `apiVersion` as v1 indefinitely.** Rejected: a platform whose
  identity is extensibility must version what it loads with the rigour it versions
  what it emits (Principle 5). An unversioned input path at GA is the antithesis.
- **A dedicated `run-emits-signal-envelope` check for invariant 4.** Rejected as
  redundant: `one-outcome-shape` + `no-direct-stdout-in-tool-engine` + the
  acceptance tests already lock it (recorded in the invariant index).

**Rationale:** The 2.9.0–2.13.0 releases delivered the seven host-owned planes but
left each privileged path in place behind a grace window. Parity is binary per
concern: a 99%-removed privilege still leaves a path only a hardcoded first-party
tool can take. Unifying the loader makes install-source independence *structural*
(bundled `fit` already travels the external path), so the packed-install proof
confirms a fact rather than testing a special case. Removing `register()`/`program`
from the handler-facing `ToolCliContext` makes "no raw Commander for tools" a type
fact, not a guarded convention. Grounded in: `packages/cli/src/bootstrap/register-tools.ts`
(the unified `importToolRuntime` path + `BUNDLED_TOOL_PACKAGES`),
`packages/core/src/tools/types.ts` (the contract with `register`/`program` gone),
`packages/core/src/tools/compatibility.ts` (the closed grace window), and
`packages/cli/src/__tests__/fit-external-load.test.ts` (the acceptance test).

**Consequences:**

- **Breaking for plugin authors** (not CLI users — user-facing commands, flags,
  `--json`/`CommandOutcome`, config, and exit codes are byte-identical to 2.13.0):
  a third-party tool that mounted via `register()` must declare `commandSpecs`;
  one that omitted `apiVersion` must declare it. The 3.0.0 migration guide
  (`docs/public/60-guides/migrating-to-3.0.md`) documents both.
- The project leaves the long-lived pre-GA 2.x major (ADR-0012) for the **3.x GA
  line**. Future tools (`audit`/`lint`/`bench`) slot in by shipping a manifest +
  `commandSpecs`, inheriting every plane, with **zero CLI change** — the platform's
  stated identity, now structurally true.
- The grace-window provisions that lived in the 2.9.0/2.11.0 specs are retired;
  this ADR is the durable record of their removal.

**Related specs / ADRs:** Implements
`docs/plans/specs/release-3.0.0-ga-parity-cutover.md` (local-only). Realizes
ADR-0012's 3.0.0 reservation; completes the parity ladder begun by ADR-0011
(output currency) and continued through ADR-0021/0023/0024/0026. The completion-
invariant enforcement record is `docs/internal/parity-invariant-index.md`.
