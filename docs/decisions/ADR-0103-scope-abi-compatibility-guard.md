---
status: active
last_verified: 2026-06-30
owner: opensip-cli
---

# ADR-0103: Single-core guard keys on a scope ABI, not the npm version

```yaml
id: ADR-0103
title: Single-core guard keys on a scope ABI, not the npm version
date: 2026-06-30
status: active
supersedes: []
superseded_by: null
related: [ADR-0060]
tags: [core, plugins, discovery, capability, run-scope]
enforcement: mechanizable
enforcement-reason: >
  The identity policy lives in packages/core/src/plugins/single-core-guard.ts
  and is covered by single-core-guard.test.ts + scope-abi.test.ts (the
  package.json field is asserted equal to the SCOPE_ABI_VERSION source
  constant). The user-facing diagnostic path is covered by the fitness
  load-outcome tests.
```

**Decision:** The single-`@opensip-cli/core` guard decides whether a discovered
capability pack's resolved core is "the same core" by comparing a **scope ABI
version** (`SCOPE_ABI_VERSION`, declared in core's `package.json` as
`opensipScopeAbiVersion`), not the core's npm package version. Two cores with
the same scope ABI interoperate regardless of their npm versions. A core that
predates the field but is at or above `SCOPE_ABI_MIN_CORE_VERSION` (0.1.11 — the
release that introduced the `globalThis`-pinned scope `AsyncLocalStorage`) is
treated as scope ABI 1; anything older, or with an explicitly different ABI,
remains foreign and is refused. When a pack is refused for this reason the CLI
emits a targeted diagnostic (`OPENSIP_CAPABILITY_SCOPE_ABI_MISMATCH`) that names
the two core versions and the real remedy, instead of the generic "verify the
package is installed, built, and listed correctly."

**Alternatives:**

- *Keep exact-version identity (status quo).* Rejected: it forces every consumer
  repo to keep its `@opensip-cli/*` dependency range in lockstep with whatever
  globally-installed CLI runs there. That contradicts the capability model's own
  `targetDomainApiVersion` epoch gate (ADR-0060 / `capability-compatibility.ts`),
  which was designed precisely so packs and CLIs can version independently. Two
  compatibility gates that disagree is the bug.
- *Compare on `major.minor` of the npm version.* Rejected: meaningless on a
  `0.1.x` line (every minor is a semver breaking change), and it re-couples
  interop to release cadence rather than to the actual contract that can break.
- *Drop the guard entirely.* Rejected: a genuine future change to the RunScope
  read-surface (or a pre-0.1.11 core with no shared ALS) is a real split-scope
  hazard; we still need a boundary — just one that tracks the contract, not the
  version.

**Rationale:** The guard exists to stop a pack from registering against a core
whose `currentScope()` is always `undefined` (a dead `AsyncLocalStorage` → the
run silently degrades). Since v0.1.11 (`41d4531b`) the scope ALS is pinned on
`globalThis` under the version-independent key
`Symbol.for('@opensip-cli/core/scopeStorage')`, so every core ≥ 0.1.11 shares
one scope store — the dead-ALS failure mode cannot occur between two such cores.
Exact-version identity was therefore stricter than the hazard requires and broke
the intended "one global CLI, many consumer repos" workflow: a repo whose fit
pack resolved `@opensip-cli/core` 0.1.15 (via its `^0.1.14` peer) could not be
scanned by a globally-installed CLI at 0.1.18, even though the pack passed the
`targetDomainApiVersion` epoch gate. Keying on a scope ABI — an integer bumped
only when the RunScope read-surface actually breaks — restores independent
versioning while preserving the real safety boundary. The 0.1.11 floor is
verifiable from git (`git tag --contains 41d4531b`): it is the earliest release
carrying the shared-ALS pin, so treating ≥ 0.1.11 absent-field cores as ABI 1 is
sound, and pre-0.1.11 cores correctly fall back to exact-version identity.

**Consequences:**

- `packages/core/package.json` gains `opensipScopeAbiVersion: 1`. The value is
  the single source of truth for the current scope ABI, mirrored by the
  `SCOPE_ABI_VERSION` code constant (`packages/core/src/lib/scope-abi.ts`); a
  test asserts the two agree so they cannot drift.
- Any future breaking change to the RunScope read-surface (a field that check
  execution reads being removed/renamed, or the ALS pin key changing) MUST bump
  `SCOPE_ABI_VERSION` + the package.json field together. Additive-only changes
  (new optional fields) do not bump it.
- The fix ships in the CLI: a consumer must run a CLI built with this change for
  an older-but-compatible pack to load. Until then the stopgap is to float the
  consumer repo's `@opensip-cli/*` range up to match the installed CLL
  (`pnpm update '@opensip-cli/*'` + rebuild the pack) — no version pin required.
- The guard remains generic: the policy applies to every capability domain's
  packs (fit, sim, graph adapters), not just fit.

**Related specs / ADRs:** ADR-0060 (capability discovery + `targetDomainApiVersion`
epoch gate). Implemented in `packages/core/src/plugins/single-core-guard.ts`,
`scope-abi.ts`, `capability-discovery.ts`, `lib/capability-diagnostic.ts`, and
`packages/fitness/engine/src/cli/fit/load-outcome.ts`.
