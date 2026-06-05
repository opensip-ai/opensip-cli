---
status: current
last_verified: 2026-06-05
release: v3.0.0
title: "Suppressing findings (graph)"
audience: [contributors, ci-integrators]
purpose: "Inline source-level waivers — how `@graph-ignore-next-line` and `@graph-ignore-file` work, the any-member rule for cycles, and how a waiver relates to the gate baseline."
source-files:
  - packages/graph/engine/src/cli/apply-suppressions.ts
  - packages/graph/engine/src/rules/cycle.ts
  - packages/graph/engine/src/gate.ts
  - packages/fitness/checks-universal/src/checks/quality/graph-ignore-hygiene.ts
related-docs:
  - ./02-rules-and-gating.md
  - ../20-fit/03-ignore-directives.md
  - ../10-concepts/05-architecture-gate.md
---
# Suppressing findings

Sometimes a graph rule is right that *a thing exists* — there really is a cycle, the function really is long — but you've looked, and it's intentional. A recursive-descent visitor genuinely is a call cycle. A function whose body is one big embedded template is "long" only because a line counter can't tell code from a data blob.

`@graph-ignore` directives are how you record that judgment **next to the code**, with a reason, so it survives refactors and shows up in review. They are the per-finding *waiver* that complements the graph **gate** (the don't-get-worse baseline in [Rules and gating](./02-rules-and-gating.md)).

> **What you'll understand after this:**
> - The two directive forms and the rule-id they take.
> - Why a `graph:cycle` directive works above *any* member of the cycle.
> - That suppression is unconditional — a missing reason is a hygiene warning, not a refusal.
> - How a waiver relates to the gate baseline (it never reaches it).

---

## The two forms

```ts
// @graph-ignore-next-line <graph:rule>   — waive the finding on the next non-directive line
// @graph-ignore-file <graph:rule>        — waive every finding for that rule in this file
```

The second token is a graph **rule id** — the namespaced form like `graph:cycle`, `graph:large-function`, `graph:wide-function` (the same ids listed in [Rules and gating](./02-rules-and-gating.md)). A directive naming one rule never waives another. There is no "ignore everything" form, by design.

These keywords are deliberately distinct from fitness's [`@fitness-ignore-*`](../20-fit/03-ignore-directives.md): a reader at the suppression site should see *which tool* is being silenced without decoding the id. The shared machinery is the same (both run through the kernel's suppression primitive, [ADR-0014](../../decisions/ADR-0014-shared-inline-signal-suppression.md)); only the vocabulary differs.

```ts
// @graph-ignore-next-line graph:large-function -- emits one cohesive browser-JS bundle as a template; the line count is embedded data, not splittable logic
export function dashboardViewGraphJs(): string {
  return String.raw`/* …342 lines of emitted JS… */`;
}
```

---

## Cycles: a directive above any member waives it

`graph:cycle` reports **one finding per cycle** (per strongly-connected component), anchored at one member — the lowest-sorted qualified name. That anchor isn't always the member you're looking at. So a `@graph-ignore-next-line graph:cycle` works above **any** function in the cycle, not only the anchor:

```ts
// @graph-ignore-next-line graph:cycle -- intentional recursive-descent AST visitor
function visit(node: Node, ctx: WalkCtx): void {
  // visit → visitFunction → visit … the cycle IS the traversal
}
```

The rule attaches every member's location to the finding (`memberLocations` in [`cycle.ts`](../../../packages/graph/engine/src/rules/cycle.ts)); graph's suppression pass treats all of them as candidate sites. You annotate the member that reads best.

---

## Suppression is unconditional; reasons are a separate check

A `@graph-ignore` **always** suppresses, even with no `-- reason`. Quality is enforced *out of band* — exactly as fitness does it — by the `graph-ignore-hygiene` check (it runs under `opensip-tools fit`), which warns on:

- a missing `-- reason`,
- an id that isn't a valid `graph:<kebab>`,
- more than seven directives in one file (a smell: fix the underlying issues).

So a reason-less waiver still works, but it shows up as a hygiene warning until you document it. Every `@graph-ignore` is also surfaced in the `directive-audit` inventory for periodic review, alongside the eslint / TypeScript / fitness / semgrep families. **Always write a reason** — the waiver is a claim that you looked, and the reason is the evidence.

---

## Where a waiver sits relative to the gate

Suppression runs **before** anything consumes the run's signals — the gate baseline, the dashboard, the rendered report, and SARIF export all see the post-waiver set. Concretely:

- A waived finding **never enters the gate baseline** (`--gate-save`) and never surfaces as a net-new alert on a PR (`--gate-compare`).
- The run's completion log reports how many findings were suppressed, so a waiver is never silent.

This is the division of labor: the **gate** keeps you from getting *worse*; a **waiver** records that a specific current finding is *fine, and here's why*. Reach for a waiver when the rule is correct but the code is intentional. Reach for a fix when it isn't. Reach for the baseline when you're adopting graph on an existing repo and want to ratchet from today's state — see [Rules and gating](./02-rules-and-gating.md).
