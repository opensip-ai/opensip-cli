---
status: active
last_verified: 2026-06-01
owner: opensip-cli
---

# ADR-0002: Coupling buckets by nearest package.json, not a path heuristic

```yaml
id: ADR-0002
title: Coupling buckets by nearest package.json, not a path heuristic
date: 2026-06-01
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0003]
tags: [graph, coupling, packaging, contract]
enforcement: not-mechanizable
enforcement-reason: >
  A modeling decision about package identity; carried in the catalog contract and
  exercised by the coupling grid + edge-constraint, not a lintable pattern.
```

**Decision:** A file's package identity is the `name` of its **nearest enclosing
`package.json`** (e.g. `@opensip-cli/fitness`), falling back to the top-level
path segment when no manifest is found. It is computed once at build time by the
`assignPackages` post-walk pass and stamped on every occurrence as
`FunctionOccurrence.package` (a new optional catalog-contract field). The coupling
grid, `resolveCallee`, and the cross-package edge constraint all bucket by this
value (via the `pkgOf(occ)` helper), never by a path regex.

**Alternatives:**
- **(A) Path heuristic — first segment under `packages/`** (`/^packages\/([^/]+)\//`).
  The prior behavior. Rejected: collapsed the 29 workspace packages into 12
  directory groups, and degenerated to a single `<unknown>` bucket on any repo not
  laid out under `packages/` — useless on the arbitrary repos `graph` analyzes.
- **(B) `packageGroupMap` — specifier→group table read from `packages/**`.** An
  interim used by the edge constraint. Subsumed: with per-occurrence `package`, a
  workspace import specifier *is* the package name, so the map is unnecessary.
- **(C) Configurable grouping toggle (per-package vs by-directory).** Deferred:
  per-package via nearest manifest is the correct portable default; a toggle can
  be added if real demand appears.

**Rationale:** "What package is this file in" is universally answered by the
nearest `package.json` — it works for `packages/`, `apps/`+`libs/`, single-package,
and non-JS layouts, and it shows the *real* packages (29 here, not 12 directory
groups). The dashboard has no filesystem access, so the identity must be carried
in the catalog rather than recomputed in the browser; hence the per-occurrence
`package` field (optional, so pre-2.4.2 catalogs fall back to the path heuristic
via `pkgOf`).

**Consequences:**
- `GraphFunctionOccurrence` / `FunctionOccurrence` gain an optional `package`
  field (additive, backward compatible).
- The coupling grid is per-package; `assignPackages` runs before the edge
  constraint (which reads the stamped package).
- Shipped in 2.4.2. Specced in
  [`graph-per-package-coupling`](../specs/graph-per-package-coupling.md).
