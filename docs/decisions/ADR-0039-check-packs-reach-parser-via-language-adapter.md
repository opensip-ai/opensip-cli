---
status: active
last_verified: 2026-06-11
owner: opensip-tools
---

# ADR-0039: Check packs reach the parser substrate through the language adapter

```yaml
id: ADR-0039
title: Check packs reach the parser substrate through the language adapter
date: 2026-06-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0010]
tags: [fitness, checks, languages, tree-sitter, layering]
enforcement: mechanizable
enforcement-reason: >
  dependency-cruiser rule `check-pack-no-tree-sitter` (.config/dependency-cruiser.cjs)
  forbids any `packages/fitness/checks-*` module from importing
  `@opensip-tools/tree-sitter`; the type-aware companion gate reuses the same
  ruleset, so type-only edges are caught too. Rule liveness verified by probe
  on introduction.
```

**Decision:** Fitness check packs may not depend on `@opensip-tools/tree-sitter`
directly. AST-level checks consume the parser substrate **through their
language adapter** (`@opensip-tools/lang-<lang>`), which re-exports the generic
traversal/position vocabulary (`walkNodes`, `nameOf`, `getLineNumber`,
`nodeText`, `childrenOf`, `namedChildrenOf`, `findEnclosing`, `getColumn`,
`type Node`) alongside its grammar-specific predicates. A check pack's
dependency surface is exactly `fitness` (authoring contract) + `lang-<lang>`
(language vocabulary).

**Alternatives:**

- *Allow check packs to import `@opensip-tools/tree-sitter` directly* — rejected:
  it couples ~165 checks' implementation space to the concrete AST substrate,
  so swapping or versioning the parser (the exact flexibility ADR-0010's
  substrate extraction bought) would fan out into every check pack. It also
  erodes the adapter boundary silently — `checks-python` had already grown the
  direct dependency with nothing enforcing either answer.
- *Duplicate the traversal helpers per lang-\* package* — rejected: the helpers
  are genuinely grammar-agnostic; per-language copies would drift. Re-export
  keeps one implementation in the substrate while the adapter owns the
  *surface*.

**Rationale:** The layering already states "check packs depend on fitness" and
"language adapters own language awareness" — this closes the gap for the parser
dimension. `lang-typescript` set the precedent: checks consume `walkNodes` /
`findEnclosingFunction` etc. from the adapter, never from the TS compiler API
directly. ADR-0010's tree-sitter substrate is one layer lower than lang-\*; a
check pack importing it skips the adapter exactly the way a check importing
`typescript` directly would. The first AST-level Python check
(`python-function-too-long`) is the proof case: it now imports
`getLineNumber`/`nameOf`/`walkNodes` from `@opensip-tools/lang-python`.

**Consequences:**

- A lang-\* package that gains AST-level checks must re-export the substrate
  vocabulary its checks need (one curated block in its barrel, as
  `lang-python` now does).
- Check packs declare no `@opensip-tools/tree-sitter` dependency in
  `package.json`; `checks-python`'s was removed.
- The graph tree-sitter adapters (`graph-*`) are NOT covered by this rule —
  they implement the `GraphLanguageAdapter` contract and are themselves the
  adapter layer for the graph domain.
