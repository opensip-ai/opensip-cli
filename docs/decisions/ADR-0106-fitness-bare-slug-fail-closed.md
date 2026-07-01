---
status: active
last_verified: 2026-07-01
owner: opensip-cli
---

# ADR-0106: Fitness bare-slug resolution is fail-closed on ambiguity

```yaml
id: ADR-0106
title: Fitness bare-slug resolution is fail-closed on ambiguity
date: 2026-07-01
status: active
supersedes: []
superseded_by: null
related: [ADR-0105, ADR-0039, ADR-0020]
tags: [fitness, recipes, determinism]
enforcement: mechanizable
enforcement-reason: >
  Integration test fixture with two packs registering the same bare slug;
  fitness check can grep built-in-recipes for unnamespaced explicit selectors.
```

**Decision:** When more than one registered check matches a bare slug (no `:`),
fitness resolution **fails closed**: emit a structured diagnostic listing
candidates, do not pick the first match, and skip the ambiguous selector in
recipe execution. Built-in recipes MUST use namespaced slugs (`pack:slug`) in
explicit check lists.

**Alternatives:**

- First-match wins (current `resolveExplicit` behavior) — rejected; load-order
  dependent CI is unacceptable for a guardrail platform.
- Auto-prefer bundled packs over third-party — rejected; hidden precedence rule;
  violates explicit configuration principle.
- Reject entire recipe run on any ambiguity — rejected; too brittle for
  multi-check recipes; skip ambiguous entries and continue with diagnostic.

**Rationale:** `CheckRegistry.get()` already warns on ambiguous bare slugs but
`resolveExplicit` in `check-resolution.ts` picks `listSlugs().find(endsWith)` —
asymmetric policy. Built-in recipes (`quick-smoke`, `agent-fast`) reference bare
slugs extensively. With seven check packs and third-party packs coming (ADR-0061),
collision probability is non-zero. Namespaced selectors are the authoring norm
for custom recipes; built-in recipes should model best practice.

**Consequences:**

- `packages/fitness/engine/src/recipes/check-resolution.ts` and
  `framework/registry.ts` share one ambiguity resolver.
- `built-in-recipes.ts` explicit lists migrate to `universal:no-console-log`
  style slugs.
- Third-party check authors should register unique bare slugs or document
  namespace prefixes in recipe selectors.
- Recipe docs under `docs/public/20-fit/` updated if examples use bare slugs.

**Related specs / ADRs:** Phase 2 in
`docs/plans/architecture-audit-p1-remediation/`.