---
status: proposed
last_verified: 2026-05-24
title: "Plan — unify the three plugin-discovery shapes"
audience: [contributors, architects]
related-plans:
  - ./2026-05-23-plan-graph-adapter-package-split.md
  - ./2026-05-22-plan-layer-1-core.md
---

# Plan — unify the three plugin-discovery shapes

## Summary

After the graph-adapter package split landed (commit `f4c8f91`), the
codebase has **three distinct discovery modules** that all answer the
same question: "which packages in `node_modules/@opensip-tools/` should
this kernel auto-load?"

| Domain        | Module                                                       | Match rule                                  |
|---------------|--------------------------------------------------------------|---------------------------------------------|
| Tools         | `packages/core/src/plugins/tool-package-discovery.ts`        | `package.json` `opensipTools.kind === 'tool'` |
| Check packs   | `packages/fitness/engine/src/plugins/check-package-discovery.ts` | npm name matches `@opensip-tools/checks-*`  |
| Graph adapters| `packages/graph/engine/src/plugins/graph-adapter-discovery.ts` | npm name matches `@opensip-tools/graph-*`   |

The three modules duplicate ~80% of the same logic: walk ancestor
`node_modules/@opensip-tools/`, read each package's `package.json`,
honour an explicit `plugins.<domain>: [...]` allow-list in
`opensip-tools.config.yml`, honour an `autoDiscover<Domain>: false`
opt-out, and return the deduplicated list. The three diverge on the
**filter** step (kind metadata vs name prefix) and on the **default
config keys** they read.

This was a deliberate, narrow follow-up flagged by the graph-split
plan: "write the unification plan the moment PR 3 merges, while the
three patterns are fresh and the trade-offs are well understood."
This plan is that write-up. It is **not** an implementation plan
yet — it documents the design space and recommends a concrete shape
so the future implementation cycle starts from agreement, not from
re-discovery.

## Goals

1. **One discovery primitive in core**, parameterized by domain.
   Adding a fourth domain (a hypothetical `audit` tool, future
   `@opensip-tools/lint-*` packs, etc.) becomes a one-line addition,
   not a new ~150-line module.
2. **Preserve every existing call site's contract**: the three
   resolution rules (`plugins.<domain>: [...]` wins,
   `autoDiscover<Domain>: false` opts out, otherwise walk
   `node_modules` and filter), the structured-log shape on load
   failures, and the dedupe-by-name policy.
3. **Tighten typing.** Today each module exports a domain-specific
   `DiscoveredXxxPackage` shape that's structurally identical. One
   `DiscoveredPackage` type with a `domain: PluginDomain` field.
4. **Expose a single test surface.** Today each domain has its own
   discovery tests (~100 lines each, mostly the same fixtures). After
   unification, the parameterized core has one test suite; each
   domain has a thin smoke test verifying the parameterization wires
   up correctly.

## Non-goals

- **Not changing the user-facing surface.** `opensip-tools.config.yml`
  keeps the same key names (`plugins.fit`, `plugins.graphAdapters`,
  etc.); the `autoDiscover<Domain>` flags keep the same names. Users
  see no behaviour change.
- **Not collapsing the three filter mechanisms into one.** The kind-
  based check (tool packages) and prefix-based check (check packs,
  graph adapters) coexist legitimately. Tool packages need kind metadata
  because `@opensip-tools/`-namespaced packages aren't all tools (e.g.
  `core`, `contracts`, `dashboard` would false-match a `@opensip-tools/`
  prefix). Check packs and graph adapters are content-addressed by
  their prefix because their authoring guide locks the prefix as the
  contract.
- **Not introducing a third filter mechanism.** A future audit-tool
  domain reuses one of the existing two; no `Strategy<MatchPredicate>`
  abstraction is needed.

## Decision (locked)

The unified primitive is a **parameterized core function**, not a new
plugin-discovery class hierarchy:

```ts
// packages/core/src/plugins/discover-packages.ts (new)
export type PluginDomain =
  | 'tool'
  | 'fit-checks'
  | 'graph-adapter';
  // | 'audit-checks' (future)

export interface DiscoverPackagesInput {
  readonly domain: PluginDomain;
  readonly projectDir: string;
  /** Wins when present — short-circuits auto-discovery. */
  readonly explicitPackages?: readonly string[];
  /** When false, returns []. Default true. */
  readonly autoDiscover?: boolean;
}

export interface DiscoveredPackage {
  readonly domain: PluginDomain;
  readonly name: string;
  readonly entry: string; // resolved via existing resolvePackageEntryPoint
  readonly metadata: Record<string, unknown>;
}

export function discoverPackages(input: DiscoverPackagesInput): readonly DiscoveredPackage[];
```

The function dispatches on `domain` to pick the filter:

| Domain          | Filter implementation                                          |
|-----------------|----------------------------------------------------------------|
| `tool`          | `package.json` has `opensipTools.kind === 'tool'`              |
| `fit-checks`    | npm name matches `@opensip-tools/checks-*`                     |
| `graph-adapter` | npm name matches `@opensip-tools/graph-*` (anchor on hyphen)   |

Per-domain config keys are NOT read here — they're caller concerns.
The caller is responsible for parsing `opensip-tools.config.yml`,
extracting `plugins.<domain>` and `autoDiscover<Domain>`, and passing
`{ explicitPackages, autoDiscover }`. This keeps `discoverPackages`
yaml-shape-agnostic and lets each domain keep its own config-key
naming without leaking into core.

### Rationale for this shape

- **Parameterized function over class.** A `PluginDiscoverer` class
  with `kind`/`prefix` strategy slots would mirror Strategy correctly
  but adds two abstraction layers (the class + the strategy interface)
  for a function that fits in 100 lines. The function dispatch on
  `domain` is the simpler shape; the codebase's existing kernel idiom
  (registries are classes, walkers are functions) supports this.
- **`PluginDomain` union literal over string.** Compile-time
  exhaustiveness in the dispatch ensures adding a future domain is a
  type-system-enforced one-line edit.
- **Caller owns the YAML parse.** Today each domain reads
  `opensip-tools.config.yml` itself; after unification, each
  domain's `register*Packs` orchestrator reads it once, extracts its
  domain-specific keys, and calls `discoverPackages`. The yaml
  schema stays distributed across domains (which matches the rest of
  the project's "tools own their domain schemas" pattern), but the
  `node_modules` walk is centralized.

## Implementation phases

Three small PRs. Each individually shippable, each green-build.

### PR 1 — Add core's `discoverPackages`

**Contents:**
1. New `packages/core/src/plugins/discover-packages.ts` implementing
   the contract above. Internal helpers (`walkAncestorNodeModules`,
   `readPackageJson`, `resolvePackageEntryPoint`) reuse what's in
   `core/plugins/` today (the latter two already exist; the walker
   is currently inlined three times across the existing modules).
2. Hoist `walkAncestorNodeModules` into `core/plugins/` (it's
   currently duplicated across the three discovery modules).
3. Re-export `discoverPackages` and `DiscoveredPackage` from
   `core/src/index.ts` per the kernel's public-barrel convention.
4. Unit tests parallel to the existing per-domain tests, parameterized
   over `PluginDomain`.

**Acceptance:**
- `pnpm typecheck && pnpm test && pnpm lint` clean.
- New tests cover all three domains' filter rules + the explicit
  override + the `autoDiscover: false` opt-out.
- The three existing discovery modules are NOT changed yet.

### PR 2 — Migrate the three call sites

**Contents:**
1. `packages/core/src/plugins/tool-package-discovery.ts` — replace
   the body with a call to `discoverPackages({ domain: 'tool', ... })`.
   Keep the file as a thin facade for backwards compatibility within
   the workspace; it re-exports `discoverPackages`'s output under the
   existing `DiscoveredToolPackage` type alias (structural identity
   makes this transparent).
2. `packages/fitness/engine/src/plugins/check-package-discovery.ts` —
   same pattern. Domain is `fit-checks`.
3. `packages/graph/engine/src/plugins/graph-adapter-discovery.ts` —
   same. Domain is `graph-adapter`.
4. Drop the duplicated `walkAncestorNodeModules` implementations from
   each module (they import from core now).

**Acceptance:**
- All three modules shrink to ~30 lines each (a config-extraction
  step + the `discoverPackages` call + the type-alias re-export).
- `pnpm typecheck && pnpm test && pnpm lint` clean.
- The full per-domain test suites still pass without modification —
  the unified primitive's behaviour matches each domain's contract
  byte-for-byte.

### PR 3 — Drop the per-domain facades (optional, deferrable)

After PR 2 settles for a release cycle, the three facade modules can
be deleted entirely; callers import `discoverPackages` from core
directly. This is **deferred by default** — keeping the per-domain
facades preserves the search-by-domain ergonomics ("where does the
fit-check discovery live?" still has a satisfying answer) and the
cost of keeping ~30-line wrappers is negligible. Promote PR 3 only
if a future contributor finds the indirection actively confusing.

## Risk register

| Risk                                              | Mitigation                                                          |
|---------------------------------------------------|---------------------------------------------------------------------|
| Subtle behavioural drift between old and new path | Keep all three per-domain test suites green at every step           |
| `walkAncestorNodeModules` hoist exposes a corner  | The walker is already battle-tested across three sites; consolidate the tests in PR 1 |
| `PluginDomain` union becomes a kernel-wide enum   | Bounded — `PluginDomain` is only consumed by `discoverPackages` and its tests; not part of `Tool` / `Check` / `LanguageAdapter` contracts |
| Adding a fourth domain races this plan            | Out of scope for current cycle; add the domain literal in the same PR that introduces the consumer |

## Sequencing

This plan is independent of the deferred items in the post-merge
follow-up list (CLI Phase 3, etc.). Estimated cost: ~1.5 days for
PRs 1+2; PR 3 is opt-in.

The right time to land this work is when one of the following is true:

- A fourth domain is being introduced (audit tool, lint packs, etc.).
  Discover-package centralization becomes a prerequisite, not a
  cleanup.
- The graph-adapter discovery test suite needs nontrivial extension
  (e.g. pnpm-hoisting layout fixtures). Doing that in the
  parameterized core covers all three domains at once.
- Onboarding feedback ("which discovery file should I edit?")
  surfaces. The facade collapse becomes a documented contributor win.

Until one of those triggers fires, the duplication cost is acceptable
— ~150 lines × 3 sites × 1 file each, all on a well-tested code path
with no shared mutable state.

## Out-of-scope follow-ups

- A `Plugin` umbrella type that subsumes `Tool`, fit-domain
  `FitPluginExports`, and graph-domain `{ adapter, metadata }`. The
  three shapes are deliberately different (each tool defines its own
  exports contract); collapsing them would require a discriminated
  union that adds ceremony without clarity.
- Lazy-loading discovered packages. Today every discovered pack is
  imported eagerly at boot; a future perf cycle may move to lazy
  imports for `--help` and other read-only command paths. Out of
  scope for this plan.
- Plugin-author authoring guide. Out of scope; tracked separately
  as a docs follow-up.
