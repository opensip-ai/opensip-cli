---
status: active
last_verified: 2026-06-03
owner: opensip-tools
---

# ADR-0007: Make the `opensipTools.kind` marker the canonical plugin-discovery contract

```yaml
id: ADR-0007
title: Make the opensipTools.kind marker the canonical plugin-discovery contract
date: 2026-06-03
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0005]       # symmetric tool architecture (same marker substrate)
tags: [plugins, discovery, packaging]
enforcement: mechanizable
enforcement-reason: >
  packages/cli/src/__tests__/plugin-kind-contract.test.ts walks every
  workspace package.json and asserts the marker contract in both directions
  (prefix-matching package ⇒ declared marker or explicit allowlist; declared
  kind ⇒ in the closed MARKER_KINDS vocabulary). It fails in CI on violation.
```

**Decision:** Plugin discovery treats the `opensipTools.kind` marker as the
single canonical contract for all four plugin kinds (`tool`, `fit-pack`,
`sim-pack`, `graph-adapter`). The historical `checks-*` prefix scan has been
removed; graph adapter discovery remains name-pattern + marker gated
(`graph-*` and `kind: "graph-adapter"`). A workspace-invariant test enforces
that every first-party plugin declares its marker and that any prefix-matching
package which is deliberately *not* a plugin is explicitly allowlisted.

**Alternatives:**

- *Keep name-prefix discovery as a co-equal arm.* Rejected: a naming
  convention silently wired to runtime behavior means merely adding a package
  under a magic prefix changes discovery. That is precisely how
  `@opensip-tools/graph-adapter-common` (shared scaffolding) was loaded as an
  adapter and warned on every run.
- *Delete the prefix arms in the original migration.* Rejected for that release:
  the `checks-*` scan was a public extension contract (third parties could
  publish `@acme/checks-*` and rely on prefix-only discovery via
  `plugins.packageScopes`). It was later removed as an explicit breaking cleanup
  once marker discovery became the only check-pack auto-discovery path.
- *Add only a detector (the invariant test), leave triggers untouched.*
  Rejected as insufficient: a detector catches drift but the dangerous implicit
  trigger survives. Demoting the trigger and detecting marker correctness are
  complementary, not redundant.

**Rationale:** A marker is explicit declared intent; a name prefix is implicit
coupling between publication scope and plugin shape (see
`packages/core/src/plugins/marker-discovery.ts`, which already chose markers for
tools and sim packs). Converging the two stragglers — check packs and graph
adapters — finishes a direction the codebase already took. The marker reader
now lives once in core (`readMarkerKind`, over the closed `MARKER_KINDS`
vocabulary) and is consumed by every discovery path, so there is no second
implementation to drift. The invariant test closes the loop: it would have
failed on the `graph-adapter-common` PR (verified by negative control) and also
catches the more dangerous inverse — a new adapter that forgets its marker and
would otherwise silently fail to load.

**Consequences:**

- First-party `@opensip-tools/checks-*` packs and `@opensip-tools/graph-*`
  adapters now declare their marker; the prefix scan is redundant for them.
- The `checks-*` prefix scan (`check-package-discovery.ts`) and its
  `plugins.packageScopes` extension have been removed. Check packs now
  auto-discover only through `opensipTools.kind: "fit-pack"`; exact
  `plugins.checkPackages` entries remain for non-marker packages.
- Graph-adapter auto-discovery is marker-gated (`graph-*` **and**
  `kind: "graph-adapter"`); graph adapter discovery is first-party-scope-only,
  so this is non-breaking.
- Adding a `graph-*` / `checks-*` package that is *not* a plugin now requires a
  conscious one-line entry in the invariant test's allowlist, with a reason.

**Related specs / ADRs:** [ADR-0005](./ADR-0005-symmetric-tool-architecture-graph-rules-as-dataset-queries.md)
(the symmetric tool architecture that shares this marker substrate).
