---
status: active
enforcement: mechanizable
enforced-by: ['script:fit-acceptance-e2e']
enforcement-reason: >
  The bundled-vs-installed acceptance test (packages/cli fit-acceptance-e2e)
  fails if an engine-triggered capability load admits a pack the host trust gate
  would deny — the exact asymmetry this decision removes. A direct structural
  dogfood check (flag a first-party engine `loadCapabilityDomain` call that omits
  `shouldLoadPackage`) is a possible future strengthening.
---

# ADR-0138: Scope-Published Capability-Pack Admission

## Status

Accepted

## Context

Capability packs (fit-packs, graph adapters) are admitted by the CLI
composition root's trust policy: `admitCapabilityPackage` in
`load-tool-capabilities.ts` admits a pack only when it is bundled, explicitly
listed in `plugins.<packages>`, or on the env allowlist (ADR-0126). The host
bootstrap drives this for the *owning tool* of the running command via
`loadOwningToolCapabilities` → `loadCapabilityDomain(..., shouldLoadPackage)`.

But a tool engine can *also* trigger a capability load. The fitness
check-loader's `loadFitCheckPackages` calls `loadCapabilityDomain` directly —
this path runs for contexts the bootstrap does not drive with the fitness
policy (the `installed`-provenance owning-tool path; the CLI-owned `report`
command; programmatic use). That engine-side call passed **no**
`shouldLoadPackage`, so it fell back to the core discovery default
(`defaultPackageAdmission`), which admits **any** builtin-scoped
(`@opensip-cli/*`) pack.

For every shipped check pack this was invisible: they are all bundled, so the
host trust gate and the permissive default agree. The private
`@opensip-cli/checks-dogfood` pack (ADR: relocation of opensip-internal
architecture checks) is the first builtin-scoped fit-pack that is **not**
bundled — it is admitted only by an explicit `plugins.checkPackages` opt-in. The
two admission paths then diverged: the engine default-admitted it into *any*
project (a leak into foreign codebases when running the monorepo's own CLI), and
the `installed` vs `bundled` provenance paths saw different check sets — breaking
the ADR-level "provenance changes only HOW a tool is admitted, never WHAT it
does" invariant (the `fit-acceptance-e2e` regression).

The fitness engine (layer 4) cannot import the CLI's trust policy (layer 6), so
it could not simply reuse `admitCapabilityPackage`.

## Decision

The host publishes its capability-pack admission on the RunScope as
`RunScope.capabilityAdmission` — a `CapabilityPackAdmission` typed
`(descriptor, pkg, explicitlyConfigured) => CapabilityPackageAdmission`, the
exact signature of `admitCapabilityPackage`. The CLI bootstrap assigns that
function directly when it constructs the per-run scope (beside the existing
opaque `trustPolicy` / `policyAudit` host slots, ADR-0126).

Any engine that triggers its own capability load reads
`currentScope()?.capabilityAdmission` and passes it as `shouldLoadPackage`
(binding the descriptor + the pre-augment explicit-package set). When the slot
is absent — programmatic use with no host — the core discovery default applies
unchanged. The engine never imports host trust code; it consumes a scope value,
preserving the layer DAG.

Result: a non-bundled, non-configured builtin pack is denied identically on the
bootstrap and engine paths, so it never leaks into a project that did not opt
into it, and the bundled ≡ installed invariant holds.

## Alternatives

- **List the dogfood pack in `bundledCapabilityPacks`.** Makes both paths admit
  it consistently, but marks a dev-only pack as "bundled/verified" (a semantic
  lie) and would seed a "package not installed" diagnostic for adopters.
- **Neutralize it only in the acceptance test.** Hides the symptom; the engine
  would still default-admit the pack into arbitrary foreign projects.
- **Remove the engine-side capability load entirely (host is sole loader).**
  Breaks the CLI-owned `report` path and programmatic fitness use, which have no
  host bootstrap driving fitness capabilities.
- **Give `loadCapabilityDomain` a required admission argument.** A core API
  break rippling to every caller for one path's gap.

## Consequences

- New optional `RunScopeOptions.capabilityAdmission` slot + `CapabilityPackAdmission`
  type in `@opensip-cli/core`; additive and optional, so no scope-ABI bump.
- `admitCapabilityPackage` is exported from `load-tool-capabilities.ts` and wired
  in `build-per-run-scope.ts`.
- Any future engine that calls `loadCapabilityDomain` MUST route admission
  through `scope.capabilityAdmission`, not the permissive default.

## Related specs / ADRs

Related: ADR-0126 (CLI-local trust policy plane — the admission this slot carries).
