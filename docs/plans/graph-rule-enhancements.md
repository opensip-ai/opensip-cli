---
status: proposed
title: "graph — `duplicated-function-body` lexical-scope awareness"
audience: [contributors]
---

# `graph` — `duplicated-function-body` lexical-scope awareness

A targeted improvement to the `duplicated-function-body` rule in `@opensip-tools/graph`. The rule currently compares function bodies as text and produces a high false-positive rate against any codebase that uses wrapper-style conventions. The fix is to factor lexical scope into the comparison: two functions whose textual bodies match but whose called identifiers resolve to *different* declarations are not duplicates.

---

## 1. The problem

`duplicated-function-body` flags pairs of functions whose body text hashes to the same value. The textual body is the only signal; identifier *resolution* is not considered.

Running `node packages/cli/dist/index.js graph` against this repository produces **22 findings** from this rule. Investigation shows **~12 of 22 are false positives** — roughly a 55% false-positive rate.

Every fitness check in `@opensip-tools/checks-typescript` follows this wrapper convention:

```ts
analyze(content, filePath) {
  if (isTestFile(filePath)) return [];
  return analyzeFile(content, filePath);   // ← lexically-scoped local helper
}
```

The wrapper body is textually identical in every check file. But the `analyzeFile` identifier resolves to a *different* function declaration in each file, implementing a completely different check. The rule sees the byte-identical body and reports them as duplicates.

Concrete evidence — both pairs are real findings, both are false positives:

| Reported "duplicate" pair | Reality |
|---|---|
| `packages/fitness/checks-typescript/src/checks/quality/api/api-response-validation.ts:233` ↔ `packages/fitness/checks-typescript/src/checks/quality/api/api-contract-validation.ts:343` (both `analyze`) | Each `analyze` calls its file-local `analyzeFile`; those helpers implement unrelated checks (response validation vs. contract validation). |
| `packages/fitness/checks-typescript/src/checks/quality/data-integrity/null-safety.ts:693` ↔ `packages/fitness/checks-typescript/src/checks/quality/data-integrity/array-validation.ts:570` (both `analyze`) | Same pattern — identical wrapper, different `analyzeFile` body in each file. |

## 2. Why it matters

Any codebase that has check-authoring conventions, plugin-style wrappers, or any other idiomatic delegation pattern will trip this rule the same way. The convention is *exactly* the kind of consistency a static-analysis tool should reward; instead it's the largest source of noise.

At ~55% false-positive rate on this repo, the rule is not usable as-is for triage: every signal must be hand-verified, and the genuine cross-package duplications (which the rule *does* correctly find) get drowned in noise. A rule that requires reviewing every result to discard most of them is not a fitness check — it's a manual audit.

## 3. Proposed fix

When hashing or comparing function bodies, the comparison key should not be the body text alone. It should include, for each identifier *called* within the body, the **declaration site** that identifier resolves to in lexical scope.

Conceptually, the new comparison shape:

```
bodyKey(fn) = hash({
  textShape:    normalized body text with call-identifiers replaced by placeholders,
  resolvedCalls: ordered list of (placeholder → declarationSiteId) bindings
})
```

Where `declarationSiteId` is something the inventory stage already knows about — a stable identifier for the catalog entry the call resolves to (function declaration, imported binding, method on a class). Two function bodies are duplicates only if both `textShape` and `resolvedCalls` agree.

The principle: **textual identity is necessary but not sufficient. The set of things the body actually invokes must also match.**

Stage 1 (inventory) and stage 2 (edge resolution) in the v2 design already do the identifier resolution work — every call site in stage 2 is resolved to a catalog entry by `bodyHash`. The rule can read the already-resolved `calls` array on each `FunctionOccurrence` rather than re-parsing.

Sketch:

```ts
function bodyKey(fn: FunctionOccurrence, catalog: Catalog): string {
  const textShape = normalizeBodyText(fn.bodyText);        // strip whitespace, replace call identifiers with `__CALL__`
  const resolvedCalls = fn.calls.map(c => c.to ?? 'UNRESOLVED');
  return hash({ textShape, resolvedCalls });
}
```

The rule then buckets `FunctionOccurrence` entries by `bodyKey` and reports buckets with size > 1, exactly as today.

Unresolved calls (external / dynamic / unresolvable) should hash as `UNRESOLVED` — two wrappers that both delegate to an external helper they can't resolve will still cluster together, which is acceptable (and rare in practice).

## 4. Acceptance criteria

Running `node packages/cli/dist/index.js graph` against this repository (opensip-tools, on `main` at the time of writing):

- The `duplicated-function-body` rule reports **the ~10 genuine cross-package duplications** — pairs between `checks-typescript` and `checks-universal`, and between `lang-typescript` and `fitness/engine`. These are textually *and* lexically identical; they survive the new comparison.
- The rule does **NOT** report any of the wrapper-pattern `analyze` pairs within `checks-typescript`. The known false-positive examples in §1 must drop.
- Total findings drop from 22 to approximately 10. Manual spot-check of the remaining 10 confirms each is a real duplication.
- Unit tests in `packages/graph/engine/src/rules/duplicated-function-body.test.ts` cover:
  1. Two identical bodies calling the same resolved helper → reported.
  2. Two identical bodies calling differently-resolved helpers with the same name → not reported.
  3. Two identical bodies with no calls → reported.
  4. Two identical bodies, one with an unresolved call and one with a resolved call → not reported.

## 5. Out of scope

- **Fixing the ~10 real cross-package duplications.** Tracked separately; that work removes the duplications themselves, not the rule's behavior.
- **Semantic equivalence across alpha-rename.** Two functions whose bodies are identical and which each delegate to a *different* helper whose bodies are themselves identical are arguably still duplicates (the "duplication" has just moved one level down). Detecting this requires recursive equivalence with alpha-renaming over the call graph. Defer to v0.3 of the rule — the wrapper-FP fix above is the high-value, low-cost step.
- **Cross-language duplicate detection.** This rule is TypeScript-only by virtue of stages 1 and 2 being TS-only; not changing that here.
