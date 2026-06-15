---
status: active
last_verified: 2026-06-09
owner: opensip-cli
---

# ADR-0029: Generic capability discovery — one substrate, descriptor-driven

```yaml
id: ADR-0029
title: Generic capability discovery — one substrate, descriptor-driven
date: 2026-06-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0027]
tags: [capability, plugins, discovery, tool-plugin-parity, scope-isolation]
enforcement: mechanizable
enforcement-reason: >
  The `capability-by-manifest` fit check forbids the host from compiling in
  domain-specific dispatch; `no-module-singleton` (tightened) forbids the
  module-level loaded-state/cache singletons this work removed; the
  `plugin-kind-contract` test derives valid markers from manifests rather than a
  host union; per-package isolation + routing are covered by core unit tests.
```

**Decision:** Every capability domain (fit's `fit-pack`, sim's `sim-pack`, graph's
`graph-adapter`, plus the co-located `fit-recipe`/`sim-recipe`) is discovered and
loaded by ONE generic substrate in `@opensip-cli/core`
(`discoverCapabilityContributions` + the scope-owned `loadCapabilityDomain`),
driven entirely by a `discovery` descriptor each tool declares in its manifest. The
host routes every contribution through `CapabilityRegistry.routeContribution` to the
owning tool's registrar. The three bespoke per-tool loaders are deleted; the host
compiles in no domain-specific discovery, and `MARKER_KINDS` is narrowed to the host
`'tool'` marker.

**Alternatives:**
- *Keep the three bespoke loaders (status quo).* Rejected: triplicated walk/load/route
  logic, three event vocabularies, and — for graph — a host-coupled eager loader
  (`register-graph-adapters.ts`) that static-imported graph's internals (the §4.5 leak)
  and stashed adapters in a module global.
- *Module-shaped contribution (the registrar gets the whole package module).* Rejected:
  the host's per-item schema check degrades to per-module; the registrar regains the
  tool-specific module-walking the substrate exists to remove.
- *Registrar-does-everything for secondary exports (recipes/display).* Rejected: it
  re-couples each tool to its co-located data and loses per-item validation. Chosen
  instead: separate domains for recipes (co-contributions) and display folded onto the
  check.

**Rationale:** The capability model (`CapabilityDomainSpec` + `routeContribution`,
release 2.10.0) existed but `routeContribution` had **zero non-test callers** — wired
but dead. Making it the single live conduit realizes north-star §4.5/§5.3: a domain's
manifest is the source of truth for HOW its packs are discovered (`marker` |
`name-pattern`, built-in vs project split, explicit-list `replace`/`augment`,
co-contributions), and the kernel reads that datum instead of branching on
domain identity. Folding the work onto the substrate also let us delete three
audit scope-isolation findings at their root: F1 (sim's `scenariosLoadedFor`/
`pluginLoadErrors` module globals → `scope.simulation.load`), F2 (parse cache module
global → `scope.parseCache`), and F3 (fitness's `mergedCheckDisplay` singleton →
display folded onto each `check.config`). The single-core guard (drop a pack resolving
a foreign `@opensip-cli/core`) is hoisted into core and applied to EVERY domain.

**Consequences:**
- A new tool ships discovery by declaring a `discovery` descriptor + a registrar — no
  core change. The host owns the walk, the built-in split, the single-core guard, the
  preference resolution, and the routing; the tool owns only its registrar's semantics.
- Behavior preserved, with two deliberate narrowings: sim's secondary `sim-pack` MARKER
  discovery is dropped (the descriptor is single-mode `name-pattern`; packs use the
  `<scope>/scenarios-*` name or an explicit list), and a domain's `contributionSchema`
  `requiredKeys` checks TOP-LEVEL keys (fit-pack is `['config','run']` because a Check's
  slug is nested under `.config`).
- `loadCapabilityDomain` is memoized per `(domainId, projectKey)` on the scope-owned
  registry, so the CLI pre-action hook (`loadOwningToolCapabilities`) and a tool's own
  `ensure*Loaded` do not double-load.
- F3's non-exported `const x = new Map()` shape remains beyond static detection (a regex
  cannot tell a mutated Map from the ~71 read-only constant Sets in-tree); it was fixed
  structurally rather than guarded.

**Related specs / ADRs:** Realizes the tool-plugin-parity north-star
(`docs/internal/parity-invariant-index.md`); follows the GA cutover (ADR-0027).
Spec: `docs/plans/specs/release-3.1.0-generic-capability-discovery.md` (local-only;
shipped as part of the unreleased v3.0.0, no separate version).