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

The blast metric **moves from the engine (gate) to the dashboard (insight)**
— decision (a). The rule is `indexes.blastRadius`'s *only* consumer
(confirmed: a grep finds no other engine/CLI/render reader, and it is not in
the `GraphCatalog` contract), so simply deleting the rule would leave the
engine computing a score nothing reads and orphan the `BlastScore` export.
Instead: **remove** the engine blast computation, and **compute the composite
score in the dashboard's browser-side index mirror** so the *Hot Functions*
view can rank by it. The dashboard already rebuilds its own indexes from the
catalog JSON (`code-paths/indexes.ts`); blast is a pure function of the
`callers` adjacency it already builds, so this is a contract-free mirror — the
same pattern used for `buildIndexes`. Net: "dashboard-only" becomes literally
true, the richer transitive metric (`direct + 0.5 × transitive`) gets a real
home, and no engine code is left orphaned.

**Success:** a `graph` run emits **0** `graph:high-blast-function` signals; the
engine no longer computes/exports blast (no orphan per knip); the *Hot
Functions* dashboard view ranks by the composite `blastRadius.score`; all gates
green; no stale docs per `docs:check`.

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
- **Remove the now-orphaned engine blast computation** (the rule was its only
  reader): `buildBlastRadius`/`bfsBlast` and the `blastRadius` field on
  `Indexes` ([`pipeline/indexes.ts:50,60,180-216`](../../packages/graph/engine/src/pipeline/indexes.ts),
  [`types.ts:323-324`](../../packages/graph/engine/src/types.ts)), and the
  `BlastScore` type + barrel export
  ([`types.ts:293`](../../packages/graph/engine/src/types.ts),
  [`index.ts:49`](../../packages/graph/engine/src/index.ts)). The two
  `blastRadius`-only metric tests move to the dashboard mirror (below), not an
  engine indexes test.
- **Port the blast computation into the dashboard browser-side mirror**
  ([`code-paths/indexes.ts`](../../packages/dashboard/src/code-paths/indexes.ts)):
  add `bfsBlast`/`buildBlastRadius` (verbatim formula — pure function of the
  `callers` adjacency the mirror already builds) and rank the **Hot Functions**
  view ([`code-paths/view-hot.ts:28`](../../packages/dashboard/src/code-paths/view-hot.ts))
  by the composite `blastRadius.score` (`direct + 0.5 × transitive`) — either as
  the new default sort or a Callers ↔ Blast toggle. Compute lazily on panel
  init, like the mirror's other derived data.
- Update public docs + regenerate `docs/web-generated/`.

### Out of scope

- Changing the blast **formula** (BFS depth `BLAST_MAX_DEPTH = 5`, the
  `direct + 0.5 × transitive` weighting). It is ported to the dashboard mirror
  verbatim, not redesigned.
- Carrying `blastRadius` in the `GraphCatalog` contract so the dashboard reads
  it instead of recomputing. Rejected: a contract change for a value the
  browser mirror can derive for free from `callers` (the dashboard already
  recomputes all its indexes this way). The mirror keeps it contract-free.
- A *separate* new dashboard panel for blast — we reuse the existing **Hot
  Functions** view (switch/augment its sort), not add a panel.
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

### The blast computation moves engine → dashboard (decision (a))

The engine blast computation is read **only** by the rule being deleted
(grep-confirmed: no other engine/CLI/render consumer; not in `GraphCatalog`).
So it is **removed from the engine** and **ported to the dashboard mirror**:

- [`pipeline/indexes.ts:50,60`](../../packages/graph/engine/src/pipeline/indexes.ts) —
  the `const blastRadius = buildBlastRadius(...)` line and the `blastRadius`
  field in the returned `Indexes` object → **removed**.
- [`pipeline/indexes.ts:180-216`](../../packages/graph/engine/src/pipeline/indexes.ts) —
  `buildBlastRadius` / `bfsBlast` (bounded reverse BFS, `BLAST_MAX_DEPTH = 5`,
  `direct + 0.5 × transitive`) → **deleted from the engine, ported verbatim to
  the dashboard mirror** `code-paths/indexes.ts`.
- [`types.ts:293,323-324`](../../packages/graph/engine/src/types.ts),
  [`index.ts:49`](../../packages/graph/engine/src/index.ts) — `BlastScore` type
  + `Indexes.blastRadius` field + barrel export → **removed** (no remaining
  consumer once the rule and engine field are gone; leaving them orphans the
  export per knip).

### Barrel — NOT a cleanup site (confirmed)

The task brief said "the engine barrel exports `highBlastFunctionRule`."
**It does not.** [`index.ts:166-169`](../../packages/graph/engine/src/index.ts)
re-exports `alwaysThrowsBranchRule`, `noSideEffectPathRule`,
`duplicatedFunctionBodyRule`, `orphanSubtreeRule` — but **not**
`highBlastFunctionRule` (nor `testOnlyReachableRule`). So no barrel edit is
needed. The only importers of `./high-blast-function.js` are
`registry.ts` and two test files (below).

### Dashboard "Hot Functions" — the new home for blast (decision (a))

- [`code-paths/view-hot.ts:28`](../../packages/dashboard/src/code-paths/view-hot.ts)
  — the view today ranks by **raw inbound caller count**
  (`metric: (indexes.callers.get(occ.bodyHash) || []).length`); its help text
  already frames the top rows as "your blast-radius candidates"
  ([line 24](../../packages/dashboard/src/code-paths/view-hot.ts)) — but the
  number behind that label is caller count, not blast. This spec **wires it to
  the composite `blastRadius.score`** so the label becomes honest.
- [`code-paths/indexes.ts`](../../packages/dashboard/src/code-paths/indexes.ts)
  — the browser mirror builds `byBodyHash`/`occurrencesByHash`/`bySimpleName`/
  `callees`/`callers` from the catalog JSON but **no blast today**. Add
  `bfsBlast`/`buildBlastRadius` here (verbatim from the engine; pure over the
  `callers` map it already builds) and expose `blastRadius` on the mirror's
  index object, so `view-hot` can rank by `blastRadius.get(hash)?.score`.
- The composite score has **no other consumer** (grep-confirmed), so moving it
  here — rather than leaving it computed-but-unread in the engine — is what
  makes the demotion clean (no orphan) and the "dashboard insight" framing
  literally true.

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
| Blast metric (decision (a)) | **Move** the computation engine → dashboard: remove `indexes.blastRadius`/`buildBlastRadius`/`BlastScore` from the engine; recompute it in the dashboard browser mirror. | (b) Keep the engine copy and carry `blastRadius` into the `GraphCatalog` contract for the dashboard to read. (c) Keep the engine copy unread. (d) Delete blast entirely. | The rule is the engine copy's only reader, and the dashboard rebuilds its own indexes from the catalog — so the metric's natural home is the mirror. (b) adds a contract change for a value the mirror derives for free; (c) leaves computed-but-unread code + an orphaned `BlastScore` export (knip); (d) discards the insight the user chose to keep. Move = clean + contract-free + "dashboard-only" literally true. |
| Dashboard work | **Wire Hot Functions to the composite `blastRadius.score`** via the browser mirror (new default sort or a Callers ↔ Blast toggle). | (a) Leave it ranked by raw caller count. | The view's help already calls the top rows "blast-radius candidates"; today the number is caller count, so the label is slightly dishonest. Ranking by the real composite (`direct + 0.5 × transitive`) makes it accurate and gives the moved metric its consumer. Caller-count-only would re-open the orphan problem. |
| Metric tests | **Move** the two `blastRadius`-only cases to the **dashboard mirror** tests (they now validate the browser blast computation); delete the rule-`evaluate` cases. | (a) Relocate to an engine indexes test; (b) delete them all. | The computation still ships — now in the mirror — so its direct/transitive/cycle coverage moves with it. An engine indexes test would cover code that no longer exists; deleting all coverage is a test-discipline regression. |
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
- [ ] The engine no longer computes or exports blast: `Indexes` has no
      `blastRadius` field, and `buildBlastRadius`/`bfsBlast`/`BlastScore` are
      gone from `pipeline/indexes.ts`, `types.ts`, and the barrel — with no
      orphan (knip clean).
- [ ] Blast is now a dashboard insight: the browser mirror
      (`code-paths/indexes.ts`) computes `blastRadius` (ported `bfsBlast`), and
      the **Hot Functions** view ranks by the composite `blastRadius.score`
      (`direct + 0.5 × transitive`). The two moved blast cases pass as
      dashboard-mirror tests; the view's test reflects the new ranking.
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

1. ~~Composite-score dashboard view~~ — **RESOLVED (decision (a)):** the
   composite `blastRadius.score` is the dashboard's ranking metric; the engine
   copy is removed and the score is computed in the browser mirror. In scope.
2. ~~Relocation target for engine metric tests~~ — **RESOLVED:** moot. The
   engine metric is removed; the blast cases move to the **dashboard mirror**
   tests (validating the ported `bfsBlast`), not an engine indexes test.
3. **Sort default vs. toggle** in Hot Functions — make `blastRadius.score` the
   default sort, or add a Callers ↔ Blast toggle and keep callers default?
   *Proposed:* default to blast score (the view's help already promises
   "blast-radius candidates"), keep callers available as a secondary sort.
4. **Browser-side blast cost** — `bfsBlast` is bounded (`BLAST_MAX_DEPTH = 5`)
   but runs over ~12k nodes in the page. *Proposed:* compute lazily on Hot
   Functions panel init (the mirror already defers derived data), and confirm
   it's imperceptible on this repo's catalog before shipping.
5. **Reword vs. leave the illustrative example** in `fingerprint-signal.ts`
   and `gate.test.ts`? *Proposed:* reword to `duplicated-function-body` (also
   has a run-varying count) so the rationale stays accurate.

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
