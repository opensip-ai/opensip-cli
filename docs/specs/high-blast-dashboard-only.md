# Spec: Demote `graph:high-blast-function` to a dashboard-only insight

> Status: **PROPOSED** (2026-06-01).
> First application of the opinionated gate-signal rubric (see Objective).

## Objective

Remove `graph:high-blast-function` as a graph **rule** so it stops emitting
gate signals, and keep blast radius purely as a dashboard insight. On this
repo the rule emits **429 findings** — ~88% of all graph-rule noise — every
one at `'low'` severity. Its own header
([`rules/high-blast-function.ts:1-23`](../../packages/graph/engine/src/rules/high-blast-function.ts))
states it is "an **informational structural insight**, not a defect" and
"there is no 'clean' state for a percentile-based rule."

This is a **metric/ranking masquerading as a rule**. It applies a new
rubric for what earns a gate signal — a finding qualifies only if it is:

1. **Actionable** — a concrete fix exists. High blast has none; the rule's
   own suggestion is "Informational… Splitting only helps if the function
   genuinely does too much."
2. **Precise** — most findings are real defects. A top-5%-percentile cut is
   a ranking, not a defect predicate; by construction ~5% of functions
   always fire.
3. **Bounded** — it can reach zero. A "top N%" ranking can *never* reach
   zero (lowering one function promotes the next). That is the definition
   of a dashboard insight, not a rule.

The underlying **blast metric survives unchanged**: `indexes.blastRadius`
is computed in Stage 3 by `buildBlastRadius`
([`pipeline/indexes.ts:50,180-216`](../../packages/graph/engine/src/pipeline/indexes.ts)),
independent of the rule — the rule only *reads* it. Only the per-function
gate signals go away.

**Success:** a `graph` run emits **0** `graph:high-blast-function` signals;
the blast metric is still computed and still surfaced in the dashboard; all
gates green; no orphaned code per knip; no stale docs per `docs:check`.

## Scope

### In scope

- Delete the rule file
  [`rules/high-blast-function.ts`](../../packages/graph/engine/src/rules/high-blast-function.ts).
- Unregister it from `BUILT_IN_RULES`
  ([`rules/registry.ts:24,40-47`](../../packages/graph/engine/src/rules/registry.ts)).
- Remove the barrel re-export… wait — there is **none** for this rule (see
  Technical Context); confirm and leave the barrel untouched.
- Remove the `RULE_ID_MAPPING` entry + retire the now-empty `complexity`
  family ([`render/rule-id-mapping.ts:35`](../../packages/graph/engine/src/render/rule-id-mapping.ts)).
- Delete / update all tests that import the rule or assert its presence.
- Delete the per-rule SARIF fixture
  [`__fixtures__/sarif/high-blast-function.json`](../../packages/graph/engine/src/__tests__/render/__fixtures__/sarif/high-blast-function.json)
  and drop its `RULE_FIXTURES` entry.
- **Preserve** the metric-population tests (they validate `blastRadius`,
  not the rule) by relocating them to an indexes-level test.
- Update public docs + regenerate `docs/web-generated/`.

### Out of scope

- Changing how `blastRadius` is computed (BFS depth, the `direct + 0.5 ×
  transitive` formula). Untouched.
- Adding a *new* dashboard view for the composite blast score. The Hot
  Functions view already covers the user-facing need (see DEC-4); a
  composite-score view is a separate, optional follow-up.
- Any change to the other five graph rules or the gate workflow itself.
- The historical spec reference in
  [`graph-cross-package-edge-attribution.md:38`](./graph-cross-package-edge-attribution.md)
  — historical record, not a live reference; leave as-is.

## Technical Context (real references)

### The rule (to delete)

- [`rules/high-blast-function.ts`](../../packages/graph/engine/src/rules/high-blast-function.ts)
  — `highBlastFunctionRule`, `slug: 'graph:high-blast-function'`,
  `defaultSeverity: 'warning'`. `SURFACE_PERCENTILE = 0.05`,
  `ABSOLUTE_FLOOR = 5`. `evaluate` reads `indexes.blastRadius` and
  `indexes.byBodyHash` and emits one `'low'`-severity signal per surfaced
  occurrence.

### Registration (to edit)

- [`rules/registry.ts:24`](../../packages/graph/engine/src/rules/registry.ts) —
  `import { highBlastFunctionRule } from './high-blast-function.js';`
- [`rules/registry.ts:46`](../../packages/graph/engine/src/rules/registry.ts) —
  entry in the `BUILT_IN_RULES` array (currently 6 rules).
- [`rules/registry.ts:8,14`](../../packages/graph/engine/src/rules/registry.ts) —
  docstring says "seeded with the **six** built-in rules" / "v0.2 shipped
  with **six** built-in rules" → update to "five".

### The metric survives (confirmed)

- [`pipeline/indexes.ts:50`](../../packages/graph/engine/src/pipeline/indexes.ts) —
  `const blastRadius = buildBlastRadius(byBodyHash, callers);` inside
  `buildIndexes`, unconditional.
- [`pipeline/indexes.ts:60`](../../packages/graph/engine/src/pipeline/indexes.ts) —
  `blastRadius` returned in the `Indexes` object.
- [`pipeline/indexes.ts:180-216`](../../packages/graph/engine/src/pipeline/indexes.ts) —
  `buildBlastRadius` / `bfsBlast` (bounded reverse BFS, `BLAST_MAX_DEPTH =
  5`). No dependency on the rule. **The metric is unaffected by this work.**
- `BlastScore` type is exported from the engine barrel
  ([`index.ts:49`](../../packages/graph/engine/src/index.ts)) and stays.

### Barrel — NOT a cleanup site (confirmed)

The task brief said "the engine barrel exports `highBlastFunctionRule`."
**It does not.** [`index.ts:166-169`](../../packages/graph/engine/src/index.ts)
re-exports `alwaysThrowsBranchRule`, `noSideEffectPathRule`,
`duplicatedFunctionBodyRule`, `orphanSubtreeRule` — but **not**
`highBlastFunctionRule` (nor `testOnlyReachableRule`). So no barrel edit is
needed. The only importers of `./high-blast-function.js` are
`registry.ts` and two test files (below).

### Dashboard "Hot Functions" — already covers the user need (with a nuance)

- [`code-paths/view-hot.ts`](../../packages/dashboard/src/code-paths/view-hot.ts)
  — the Hot Functions view. **It ranks by raw inbound caller count**
  (`metric: (indexes.callers.get(occ.bodyHash) || []).length`,
  [line 28](../../packages/dashboard/src/code-paths/view-hot.ts)), **not**
  by the composite `blastRadius.score` (`direct + 0.5 × transitive`). Its
  help text already frames the top rows as "your blast-radius candidates"
  ([line 24](../../packages/dashboard/src/code-paths/view-hot.ts)).
- **Nuance / honest gap:** "dashboard-only" needs **no new dashboard work**
  to be correct — direct caller count is a faithful, more legible proxy for
  blast and is what users already see. The dashboard does **not** today
  render the composite `blastRadius.score`. Surfacing that exact composite
  is the optional follow-up noted in Out of Scope; this spec does not
  require it. (Confirmed: a grep for `blastRadius`/`blastScore` across
  `packages/dashboard/src` and the graph CLI/render code returns **zero**
  non-test hits — the composite score has no consumer other than the rule
  being deleted.)

### Cleanup sites — all references

Tests that import the rule value:

- [`rules/__tests__/rule-behaviors.test.ts:4,12,123-140`](../../packages/graph/engine/src/rules/__tests__/rule-behaviors.test.ts)
  — header comment, `import { highBlastFunctionRule }`, and a
  `describe('highBlastFunctionRule', …)` block (2 cases). Delete the block
  + import; trim the header comment.
- [`__tests__/rules/high-blast-function.test.ts`](../../packages/graph/engine/src/__tests__/rules/high-blast-function.test.ts)
  — dedicated file. Cases split two ways:
  - **Metric cases** (lines 14-38: "populates blastRadius…", "handles
    caller cycles…") assert on `indexes.blastRadius` only and **must be
    preserved** — relocate to an indexes test (e.g.
    `__tests__/pipeline/indexes.test.ts` or a new `indexes-blast.test.ts`).
  - **Rule cases** (lines 40-75) call `highBlastFunctionRule.evaluate` —
    delete with the rule.

Registry / mapping tests:

- [`__tests__/rules/registry.test.ts:59`](../../packages/graph/engine/src/__tests__/rules/registry.test.ts)
  — `expect(slugs).toContain('graph:high-blast-function');` → delete line.
  (Count assertions are `toContain` / `toBeGreaterThan(0)`, not a hard
  count — no off-by-one to fix.)
- [`__tests__/render/rule-id-mapping.test.ts:38-40`](../../packages/graph/engine/src/__tests__/render/rule-id-mapping.test.ts)
  — hardcoded `expect(map('graph:high-blast-function')).toBe('graph.complexity.high-blast-function')`
  → delete that assertion.
  - **Load-bearing constraint:** the same file's test "mapping table has no
    extras beyond the registered rules" (lines 69-78) iterates
    `currentRules()` and asserts every `RULE_ID_MAPPING` key has a matching
    rule. If we remove the rule but leave the mapping entry, **this test
    fails**. The registry edit and the mapping edit must land together.

SARIF render test + fixture:

- [`__tests__/render/sarif-opensip.test.ts:47-53`](../../packages/graph/engine/src/__tests__/render/sarif-opensip.test.ts)
  — `RULE_FIXTURES` entry for `graph:high-blast-function`. Assertions key
  off `RULE_FIXTURES.length` (lines 121, 148) and load
  `./__fixtures__/sarif/${slug}.json` per fixture (line 109) → drop the
  entry; assertions stay correct automatically.
- [`__tests__/render/__fixtures__/sarif/high-blast-function.json`](../../packages/graph/engine/src/__tests__/render/__fixtures__/sarif/high-blast-function.json)
  — per-rule golden fixture → **delete the file**.

Non-edits (docstring example only — leave unchanged):

- [`fingerprint-signal.ts:19`](../../packages/graph/engine/src/fingerprint-signal.ts)
  — names `graph:high-blast-function` as an *example* of a rule with a
  run-varying message. The fingerprint behavior is rule-agnostic; the
  comment is illustrative. **Optionally** reword to a surviving example
  (e.g. `graph:duplicated-function-body`) for accuracy, but no functional
  change. Recommend rewording (zero-tech-debt) — see Open Questions.
- [`__tests__/gate.test.ts:38-46,63`](../../packages/graph/engine/src/__tests__/gate.test.ts)
  — uses the literal string `'graph:high-blast-function'` as *test input*
  to a rule-agnostic fingerprint regression. The string is not a live
  reference; tests pass regardless. **Recommend** swapping the literal to a
  surviving slug so the comment ("rules like graph:high-blast-function…")
  stays truthful, but it is not required for green.

Docs (hand-edited `docs/public/`; regenerate `docs/web-generated/` after):

- [`docs/public/40-graph/02-rules-and-gating.md`](../../docs/public/40-graph/02-rules-and-gating.md)
  — remove the `### graph:high-blast-function` section (lines 92-96);
  change "**six** rules" → "**five** rules" (lines 27, 30, 54, 58, the
  `## The six rules` heading, and cross-refs in
  `01-stages-and-catalog.md:317`, `03-adding-a-language.md:241`).
- [`docs/public/00-start/01-what-is-opensip-tools.md:87`](../../docs/public/00-start/01-what-is-opensip-tools.md)
  — drop `high-blast-function` from the rule list; "six built-in rules" →
  "five built-in rules."
- [`docs/public/00-start/02-show-me-the-loops.md:133,138,145`](../../docs/public/00-start/02-show-me-the-loops.md)
  — remove the `◦ high-blast-function 7 noted` sample line, the
  `**high-blast-function**` bullet, and "The six rules:" → "The five
  rules:".
- The generated `checks-index`
  ([`docs/public/70-reference/05-checks-index.md`](../../docs/public/70-reference/05-checks-index.md))
  indexes **fitness checks only** — grep confirms **no** graph-rule
  entries. **No regeneration needed** for this change.
- After editing `docs/public/`, run `pnpm docs:build` and commit the
  regenerated `docs/web-generated/` (mirrors exist for all three files).

### Dogfood-gate impact

- **429 fewer signals.** Confirmed nothing in CI or config gates *on*
  high-blast specifically: a grep of `.github/` and
  `opensip-tools.config.yml` finds no `high-blast` reference (the only
  `.github` "blast" hit is an unrelated comment in `release.yml:41`).
- The graph gate fingerprints by `ruleId|file|line|column`
  ([`fingerprint-signal.ts:32-34`](../../packages/graph/engine/src/fingerprint-signal.ts));
  removing the rule simply means those fingerprints stop being produced.
  On the next `--gate-save` they drop out of the baseline as resolved — no
  net-new alerts, strictly fewer.

## Design Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Rule fate | **Delete** the rule file + unregister. | (a) Keep file, just remove from `BUILT_IN_RULES` (unregister-only). | Nothing imports the rule except `registry.ts` and two test files (no barrel export — confirmed). An unregistered-but-present file is dead code → knip flags it / violates zero-tech-debt. Delete is the clean state. |
| Blast metric | **Keep** `indexes.blastRadius` exactly as-is. | (a) Remove the metric too (dead now that its only reader is gone). | The metric is the durable, portable artifact; the dashboard's user need (and the optional composite-score view) reads from it. Removing it would discard the only correct part of the feature. The brief mandates "the METRIC survives demotion." |
| Dashboard work | **None required.** Hot Functions already ranks by caller count and frames it as blast-radius. | (a) Add a new view ranked by composite `blastRadius.score`. | "Dashboard-only" is already satisfied — users see the ranking today. A composite-score view is a discretionary enhancement, deferred to Out of Scope to keep this change a pure demotion. |
| Metric tests | **Relocate** the two `blastRadius`-only cases to an indexes test; delete the rule cases. | (a) Delete the whole `high-blast-function.test.ts` file. | The metric still ships and must stay covered. Deleting all of it would drop coverage of `buildBlastRadius` (direct/transitive/cycle handling) — a regression in test discipline. |
| `complexity` family | **Retire** it — `high-blast` is its only member; remove the mapping entry, leaving five families (`dead-code`, `duplication`, `safety`). | (a) Keep `complexity` as a documented-but-unused family. | The `OPENSIP_RULE_ID_REGEX` is generic (`graph.<seg>.<seg>`), so no code enforces the family list; an empty family is just documentation drift. Remove it. |
| `fingerprint-signal` / `gate.test` example slug | **Reword** to a surviving slug. | (a) Leave the stale example. | Comments referencing a deleted rule are misleading. Cheap reword; zero-tech-debt. Functionally inert either way. |

## Success Criteria (testable)

- [ ] A `graph` run over this repo emits **0** signals with `ruleId ===
      'graph:high-blast-function'` (was 429). Verify via `graph` output /
      SARIF export.
- [ ] `currentRules()` returns **5** rules; `slugs` no longer contains
      `'graph:high-blast-function'` (registry test updated).
- [ ] `RULE_ID_MAPPING` has **5** entries; the "no extras beyond registered
      rules" test (rule-id-mapping.test.ts) passes.
- [ ] `indexes.blastRadius` is still populated for every occurrence after
      `buildIndexes` (relocated metric test passes); `BlastScore` still
      exported from the engine barrel.
- [ ] Blast radius is still visible in the dashboard: the Hot Functions
      view renders unchanged (its test
      `dashboard-view-hot.test.ts` passes).
- [ ] `packages/graph/engine/src/rules/high-blast-function.ts` and
      `__fixtures__/sarif/high-blast-function.json` no longer exist; a repo
      grep for `highBlastFunction` / `high-blast-function` returns only the
      historical spec reference (and any intentionally-reworded example
      comments).
- [ ] `knip` reports **no** new orphaned files/exports (the deleted rule
      was knip's would-be next orphan if merely unregistered).
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green (lint = ESLint +
      dependency-cruiser, both 0-error).
- [ ] `pnpm docs:check` green (i.e. `docs/web-generated/` regenerated and
      committed after the `docs/public/` edits).
- [ ] No CI/config change required for gating (verified: nothing gates on
      high-blast).

## Boundaries

- Does **not** touch the BFS/scoring internals, `BLAST_MAX_DEPTH`, or the
  `Indexes`/`BlastScore` contract.
- Does **not** alter the gate save/compare mechanics — only the population
  of one rule's signals.
- Does **not** add a dashboard view; the demotion stands on the existing
  Hot Functions view.
- Stays within `packages/graph/engine` + `packages/dashboard` (tests only)
  + `docs/`. No cross-layer or contract changes.

## Open Questions

1. **Composite-score dashboard view** — should a follow-up add a Hot
   Functions variant ranked by `blastRadius.score` (which weights
   transitive reach at 0.5×) rather than raw caller count? *Proposed:* file
   as a discretionary enhancement; raw caller count is the more legible
   default and already labeled "blast-radius candidates."
2. **Relocation target for metric tests** — fold the two preserved cases
   into an existing `pipeline/indexes` test file vs. a new
   `indexes-blast.test.ts`? *Proposed:* co-locate with other `buildIndexes`
   coverage to keep the metric's tests next to its producer.
3. **Reword vs. leave the illustrative example** in `fingerprint-signal.ts`
   and `gate.test.ts`? *Proposed:* reword to `duplicated-function-body`
   (also has a run-varying count in its message) so the rationale stays
   accurate.

## Applicable Conventions (from CLAUDE.md)

- **Zero tech debt / fix-as-found:** delete the rule rather than leave a
  dormant file; reword stale example comments in the same pass.
- **Explicit registration:** rules live in `BUILT_IN_RULES`
  ([registry.ts:40](../../packages/graph/engine/src/rules/registry.ts)); the
  registry is the single source of truth — `RULE_ID_MAPPING` and the SARIF
  driver are derived from it via tests, so the registry edit drives the
  rest.
- **Docs are source + generated:** hand-edit `docs/public/`, then
  `pnpm docs:build` and commit `docs/web-generated/`; `docs:check` is the CI
  staleness gate.
- **Tests next to source, Vitest:** `*.test.ts`; metric coverage moves to
  the metric's package, not the rule's.
- **Before committing:** `pnpm typecheck && pnpm test && pnpm lint`.
