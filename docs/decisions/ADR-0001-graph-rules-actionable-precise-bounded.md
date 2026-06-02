---
status: active
last_verified: 2026-06-01
owner: opensip-tools
---

# ADR-0001: Graph rules must be actionable, precise, and bounded

```yaml
id: ADR-0001
title: Graph rules must be actionable, precise, and bounded
date: 2026-06-01
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: []
tags: [graph, rules, signal-quality, gate]
enforcement: not-mechanizable
enforcement-reason: >
  A judgment about whether a finding is actionable; guides graph-rule design and
  review, not a lintable pattern. Partially observable via per-rule finding
  counts on the dogfood run.
```

**Decision:** A **graph rule** (the `graph` tool's Stage-4 rule pass — a `Rule`
with a `graph:<slug>` id whose `evaluate(catalog, indexes, config)` emits
`Signal`s that become gate warnings / SARIF alerts) earns a **gate signal** for a
finding only if all three hold:

1. **Actionable** — a concrete fix exists (delete it, consolidate it, mark an
   entry point, inline it). If the only honest "fix" is "verify it's fine," it is
   not a defect.
2. **Precise** — the majority of findings are real; a developer reading the list
   would not dismiss most of them as "intended."
3. **Bounded** — the count can reach zero. A "top N%" / percentile / ranking can
   never reach zero by construction (lowering the worst offender just promotes the
   next into the cutoff). That is a **metric, not a defect**.

**Corollary:** metrics and rankings (blast radius, coupling density, package-
coupling counts, any "top N" / percentile) are **dashboard insights**, not gate
rules. The dashboard is for exploration and ranking; the gate is for actionable
defects whose count can hit zero. A percentile rule structurally fails criterion
3 and must not gate — build a dashboard view for it instead.

(Graph rules are distinct from the ~145 `defineCheck` **fitness checks**, which
are file-scoped `analyze(content, filePath)` checks. This ADR governs graph
rules only.)

**Alternatives:**
- **(A) Status quo — emit everything, severity-tier it.** Keep noisy rules but
  mark them `'low'`. Rejected: `graph:high-blast-function` already does this and
  still produces 429 findings (88% of all rule output) that nobody acts on;
  severity tiers don't make a ranking actionable.
- **(B) Per-rule ad-hoc tuning, no shared principle.** Tune thresholds case by
  case. Rejected: without a rubric the suite drifts back to noise; new rules have
  no bar to clear.
- **(C) Gate on metrics with percentile thresholds.** Rejected: a percentile
  gate can never reach green on a healthy repo — it punishes whichever function
  is currently largest/most-connected, which is not a defect.

**Rationale:** A rule that reaches across the whole call graph has far more
leverage to produce noise than a single-file check, and a gate that cries wolf
gets ignored wholesale. Measured on this repo, the six built-in rules produced:

| Rule (`graph:<slug>`) | Findings | Actionable | Precise | Bounded | Verdict |
| --- | ---: | --- | --- | --- | --- |
| `high-blast-function` | 429 | no (self-described informational) | no | **no** (percentile) | **Demote to dashboard-only** — 88% of all rule noise. |
| `orphan-subtree` | 45 | yes | partial (public exports + dynamic dispatch leak in) | yes | **Sharpen** — right idea, too noisy as written. |
| `duplicated-function-body` | 9 | yes | yes | yes | **Extend** — add an aggregate cross-package signal. |
| `no-side-effect-path` | 3 | yes | yes | yes | **Keep** — lean and actionable. |
| `always-throws-branch` | 2 | yes | yes | yes | **Keep**. |
| `test-only-reachable` | 0 | yes | yes | yes | **Keep** — proves the rubric: a clean repo reaches zero. |

`high-blast-function` is the textbook anti-pattern: its own file header
(`packages/graph/engine/src/rules/high-blast-function.ts`) declares it
"informational, not a defect" and emits off a top-percentile cutoff — a metric
wearing a rule's clothes (it also duplicates the dashboard's Hot Functions view).
`test-only-reachable` at 0 is the counter-proof that a real, bounded rule reaches
zero on a healthy codebase.

**Consequences:**
- When adding a `Rule` to `BUILT_IN_RULES`
  (`packages/graph/engine/src/rules/registry.ts`), answer all three: name the fix
  in one verb (actionable); would a dev dismiss most findings (precise — if yes,
  sharpen the predicate: exclude public exports, dynamic dispatch, generated/test
  files via `RuleHints`); can it reach zero on a clean repo (bounded — if it
  ranks/percentiles, it cannot; build a dashboard view instead).
- Immediate application (separately specced): demote `high-blast-function` to a
  dashboard insight; sharpen `orphan-subtree`; extend `duplicated-function-body`
  with an aggregate cross-package signal.
- A rule that fails any criterion is reshaped until it passes or relocated to the
  dashboard.

**Related specs:**
[`duplicated-body-cross-package-signal`](../specs/duplicated-body-cross-package-signal.md),
[`high-blast-dashboard-only`](../specs/high-blast-dashboard-only.md),
[`orphan-subtree-sharpening`](../specs/orphan-subtree-sharpening.md).
