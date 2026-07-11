---
status: active
last_verified: 2026-07-11
owner: opensip-cli
---

# ADR-0151: Derive package classification and lock both export namespaces

```yaml
id: ADR-0151
title: Derive package classification and lock both export namespaces
date: 2026-07-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0009, ADR-0013, ADR-0040, ADR-0133, ADR-0147]
tags: [architecture, depcruise, packaging, mcp, testing]
enforcement: mechanizable
enforced-by: ['depcruise:cli-no-static-tool-package-import', 'depcruise:mcp-graph-root-registrar-only', 'depcruise:no-cross-package-internal', 'script:verify-gate-live', 'script:verify-core-exports', 'local:no-bootstrap-tool-import']
enforcement-reason: >
  Manifest-derived depcruise rules deny any Tool a static CLI import and any
  unlisted fit pack a peer edge (fail-closed at config load); verify-gate-live
  fires and cleans up firing + legal probes for each rule; verify-core-exports
  locks the exact value AND type namespace of every governed package via a TS-AST
  walker; the local no-bootstrap-tool-import dogfood check emits an actionable
  source diagnostic for every Tool-runtime import form.
```

**Decision:** Package boundaries are derived from manifests and locked by AST, not
maintained by hand. Tool and fit-pack classification comes from
`opensipTools.kind` (`tool` / `fit-pack`), so a package with ANY name is governed;
dependency-cruiser allowlist maps are **fail-closed** — an unlisted fit pack
throws at config load rather than receiving a permissive default. The CLI host may
not statically import a Tool runtime from any package (`cli-no-static-tool-package-import`);
bundled Tools load only through the dynamic plugin path, so install-source
independence stays structural. Cross-package `/internal` subpaths are test-only and
matched completely (file AND directory forms); MCP consumes graph evidence only
through `@opensip-cli/graph/read`, with a single sanctioned adapter-registrar root
exception (`mcp-graph-root-registrar-only`). Each governed package's public surface
is locked as an exact **value and type** namespace by a TypeScript-AST export
walker (`verify-core-exports` over `.config/package-export-allowlists.cjs`), so a
type-only re-export is tracked even though a runtime `Object.keys` would miss it.

**Alternatives:**
- Handwritten pairwise depcruise rules + runtime-only export locks — rejected:
  rot when a package is added or renamed, and a runtime `Object.keys` lock cannot
  see type-only exports, so a leaked type escapes review.
- Package restructuring (physically splitting internal seams into separate
  packages) — rejected: heavier churn than a manifest-derived gate, and it would
  not by itself give the CLI dynamic-load or the exact type-namespace guarantees.
- A single manifest-complete depcruise rule with no source diagnostic — rejected:
  the gate is authoritative but points at a resolved edge, not an actionable
  file/line; the dogfood diagnostic gives contributors the import site.

**Rationale:** Manifest derivation makes the gate correct-by-construction for
future packages; fail-closed defaults turn "forgot to add a rule" into a hard
failure instead of a silent bypass. Locking both namespaces (value + type) closes
the gap a runtime-only assertion leaves. The dynamic CLI load is the mechanical
realization of install-source independence: a bundled Tool and an installed Tool
travel the same path.

**Consequences:**
- `.config/package-export-allowlists.cjs` is the reviewed export surface for
  fitness/graph/graph-read/simulation/yagni/mcp; core keeps its legacy allowlist.
- Every new structural rule ships with a firing probe AND a legal-edge control in
  `verify-gate-live.mjs`, each cleaned up after success and forced failure.
- Adding a Tool or fit pack requires only a correct manifest `kind` (+ an explicit
  reviewed allowlist entry for a fit pack); no CLI code change loads a bundled Tool.

**Fitness check:** Check warranted — the local `no-bootstrap-tool-import` diagnostic
covers every current Tool-runtime import form (named `tool`/`*Tool`, default,
namespace, side-effect; `import type` exempt) scoped to Tool-family packages;
dependency-cruiser's manifest-derived `cli-no-static-tool-package-import` remains
the manifest-complete authority for a Tool with any package name.

**Related specs / ADRs:** ADR-0147 (public graph/read + fail-closed boundaries,
extended here to CLI dynamic load + exact type locks); ADR-0009 (published/internal
subpaths); ADR-0013 (layer policy); ADR-0040 (private test-support); ADR-0133
(manifest-derived Tool inventory).
