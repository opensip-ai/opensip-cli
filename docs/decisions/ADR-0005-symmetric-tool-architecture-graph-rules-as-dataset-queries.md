---
status: active
last_verified: 2026-06-02
owner: opensip-cli
---

# ADR-0005: Symmetric tool architecture — graph rules as dataset-queries

```yaml
id: ADR-0005
title: Symmetric tool architecture — graph rules as dataset-queries
date: 2026-06-02
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0001, ADR-0003, ADR-0006]
tags: [graph, fitness, rules, recipes, architecture, dashboard]
enforcement: not-mechanizable
enforcement-reason: >
  An architectural shape (peer-tool symmetry, where shared machinery lives) that
  guides design and review. The layering half is partially mechanizable via
  dependency-cruiser (core must not import tools; tools must not import each
  other), but "author rules the way you author checks" is a judgment call.
```

**Decision:** Bring the **`graph`** tool to architectural symmetry with
**`fitness`**. Both are peer Tools, authored via a parallel factory
(`defineRule` ↔ `defineCheck`), selected via **one shared generic recipe
substrate**, persisted as **sessions**, and surfaced uniformly in the
**dashboard** — with "rule" as graph's noun and the engine **dataset** as a
rule's input (vs. fitness's `(content, filePath)` file content). Concretely:

1. **Hoist the generic recipe substrate into `core`.** A recipe = a named
   selection of units (by id/tag) + per-unit config overrides + metadata,
   generic over the unit type `T` — mirroring the existing `Registry<T>`
   precedent. The registry base already lives in core
   (`packages/core/src/recipes/registry.ts`, `RecipeRegistry<T>`/`RecipeBase`);
   the remaining duplicated pieces (**selector resolution** and **per-unit
   config override**) join it. **Execution strategy stays tool-owned** (fitness:
   parallel/sequential/retry over file content; sim: scenario run; graph:
   evaluate rules once over the dataset).
2. **Add `defineRule`**, a thin ergonomic factory over the existing `Rule`
   interface (`packages/graph/engine/src/types.ts` ~381–391), whose input is the
   engine **dataset** (catalog + indexes + the new feature layer), parallel to
   `defineCheck` (`packages/fitness/engine/src/framework/define-check.ts:221`).
3. **Add a graph feature/dataset layer** (see ADR-0006 for its persistence
   policy): promote blast / SCC / package-coupling from dashboard client-side JS
   (`packages/dashboard/src/code-paths/{indexes,scc,view-coupling}.ts`) into the
   engine as derived columns, so rules consume them and the dashboard becomes a
   pure view over the same dataset.
4. **A default recipe of "run all rules"**, and wire graph rule signals into the
   already-generic `StoredSession` (`packages/contracts/src/session-types.ts`,
   graph persists via `SessionRepo`) and dashboard
   (`packages/dashboard/src/generator.ts`, which already registers fit/sim/graph
   tabs) so the graph tab shows "rules we ran + findings" exactly like fitness.

**Guiding principle (user's framing):** *"the data is the data, the engine is
the engine."* The engine produces a dataset (raw catalog facts + derived feature
columns); rules are declarative queries over it; the dashboard is a pure view
over the same dataset.

**Alternatives:**
- **(A) A third recipe copy inside graph.** Rejected: the recipe concept is
  already implemented twice (`packages/fitness/engine/src/recipes/`,
  `packages/simulation/engine/src/recipes/`). A third copy is the rule-of-three
  signal to hoist, and the repo already set the precedent with `Registry<T>`
  (generic base in core, thin per-tool subclass).
- **(B) Declarative-data-only rule authoring** (rules as serializable
  `{metric, op, threshold}` data). Rejected as the *authoring* model: a predicate
  function (like `defineCheck`) is more expressive. The declarative-data idea is
  preserved where it belongs — as **config-overridable thresholds** (recipe
  config), not as the authoring surface.
- **(C) Keep blast/SCC/coupling as dashboard-only client JS.** Rejected: rules
  can't consume them, the algorithms get duplicated (engine + browser), and the
  dashboard owns analysis that belongs in the engine.
- **(D) Rename graph "rules" → "checks" to unify vocabulary with fitness.**
  Rejected: they are different contracts (dataset-query vs file-content
  assertion), and rule slugs are baked into baseline-fingerprint identity
  (`packages/graph/engine/src/fingerprint-signal.ts:34` = `ruleId|file|line|col`)
  — a rename would invalidate baselines and flood Code Scanning with net-new
  alerts.

**Rationale:** Peer-tool symmetry reuses fitness's proven machinery (recipes,
sessions, dashboard) instead of inventing graph-specific equivalents, and most of
the substrate already exists and graph already plugs into it (sessions via
`SessionRepo`; the dashboard generator is already generic over fit/sim/graph).
The recipe concept is the one piece duplicated rather than shared, so hoisting it
both unblocks graph *and* pays down the existing fitness/sim duplication. The
feature layer makes rules declarative predicates over a shared dataset and
removes the dashboard's client-side analysis duplication — one source of truth
for blast/SCC/coupling.

**Consequences:**
- **New graph rules must still satisfy [ADR-0001](./ADR-0001-graph-rules-actionable-precise-bounded.md)
  (actionable, precise, bounded).** The feature layer supplies *metrics*, but a
  metric is a **dashboard insight, not a gate rule**, unless wrapped in a
  predicate whose count can reach zero. In particular: a blast-based rule must
  gate on an **absolute** threshold combined with an actionable, bounded
  predicate (e.g. `blast ≥ N && !testReachable` — fixable by adding a test),
  never a top-percentile cutoff; statistical "coupling outlier" rankings stay
  dashboard-only, while package **cycles** (bounded, breakable) may gate. The
  Phase D spec must be reconciled against ADR-0001 before implementation.
- **Rule slugs / `ruleId`s must stay byte-stable** through the `defineRule`
  refactor (baseline fingerprint identity).
- **Decision (resolved 2026-06-02): wire the severity-override plumbing as an
  opt-in clamp.** `Rule.defaultSeverity` and `GraphConfig.severityOverrides` are
  declared/loaded today but **never applied** — each rule hardcodes its
  `createSignal` severity (verified: four rules at `low`, `orphan-subtree` at
  `medium`), while all declare `defaultSeverity: 'warning'`. Per the
  zero-tech-debt principle this is fixed, not preserved — with a model chosen to
  be **baseline-neutral by default**: the per-signal severity (the 4-level value
  a rule emits, including Phase D's multi-band ladders) stays the **base**, and
  `severityOverrides[slug]` is applied **only when explicitly set** (`error→high`,
  `warning→medium`) to clamp a rule's emitted severity; `defaultSeverity` remains
  metadata and the override's default. With no override configured, output is
  byte-for-byte unchanged → no baseline / Code-Scanning churn (a naive
  `defaultSeverity→severity` mapping would instead push the four `low` rules to
  `medium` and churn the baseline — rejected). The wiring lands in **Phase D**
  (which owns the severity model); Phase B stays identity-preserving.
- Implemented in four phases (in-progress local plans under
  `docs/plans/specs/`): `01-recipe-substrate-hoist` → `02-graph-rules-symmetry`
  → `03-graph-feature-layer` → `04-graph-structural-rules`. Phase A is a
  no-behavior-change refactor (proven by existing recipe tests staying green).
- Ships as **v2.6.0** (current line v2.5.2), gated on a full pre-publish review.

**Related specs / ADRs:** Implemented by the four in-progress plans under
`docs/plans/specs/` (`00-overview` indexes them; local-only). Governed by
[ADR-0001](./ADR-0001-graph-rules-actionable-precise-bounded.md) (rule quality
bar); the feature layer follows
[ADR-0006](./ADR-0006-derived-data-persistence-policy.md) (materialization
policy); reachability/feature columns key per occurrence per
[ADR-0003](./ADR-0003-per-occurrence-edge-keying.md).
