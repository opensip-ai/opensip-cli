# Spec: Aggregate cross-package duplication signal for `duplicated-function-body`

> Status: **PROPOSED** (2026-06-01). Author: 2026-06-01. Targets a release
> after 2.4.2 (depends on the `occurrence.package` stamp shipped in 2.4.2).
> Follow-up to [graph-per-package-coupling.md](./graph-per-package-coupling.md)
> (which added `assignPackages` + `pkgOf`) and a sibling to the in-flight
> `stripStrings`/`stripComments` / tree-sitter graph-adapter consolidation
> work that this signal is designed to surface.

## Objective

The graph engine's `graph:duplicated-function-body` rule today reports only
**per-instance large** duplicates: a body must clear two thresholds —
`minDuplicateBodyLines = 5` source lines AND `minDuplicateBodySize = 200`
normalized characters (`packages/graph/engine/src/rules/duplicated-function-body.ts:26-27`,
filtered in `isInterestingForDup`, `:109-122`). That filter is correct for
"two big functions someone should extract," but it **hides the most expensive
class of duplication this repo actually has**: a *small* body copied across
*many packages*.

Concrete misses on this repo, found only via the hot-functions caller-fanout
lens (not the rule):

- `stripStrings` — a ~141-byte normalized body copied across **5** language
  adapters (`lang-typescript`/`-python`/`-go`/`-java`/`-cpp`). Below the
  200-char size floor, so the rule is silent.
- `stripComments` — same shape, same 5 packages.
- Most of the tree-sitter graph-adapter helpers (`graph-python`,
  `graph-rust`, …) — small per copy, widely duplicated.

Per-copy each is trivial; in aggregate each is a real consolidation target
with a maintenance multiplier of 5. The size floor is exactly what masks
them. The 2.4.2 `occurrence.package` stamp
(`packages/graph/engine/src/pipeline/assign-packages.ts:36-39`; the
`package?: string` field on `FunctionOccurrence`,
`packages/graph/engine/src/types.ts:168-175`) is the enabler: we can now
group duplicate bodies **by package** and flag "the same body appears in ≥N
distinct packages" *regardless of per-copy size*.

**Who is the user?** Anyone reading `graph` findings (or the dogfood gate) to
find cross-cutting code that should be hoisted into a shared package.

**Success:** a small body present in ≥N distinct packages produces exactly one
aggregate signal naming the packages; a within-package small duplicate below
the size floor still does NOT fire; all gates stay green.

## Guiding principle: actionable, low-noise rules

This extension is the first concrete embodiment of the rubric we now apply to
**every** graph rule. The rubric is codified in
[ADR-0001](../decisions/ADR-0001-graph-rules-actionable-precise-bounded.md);
stated here because this signal is its first instance:

A graph rule finding earns a **gate signal** only if all three hold:

1. **Actionable** — there is a concrete fix. Here: consolidate the duplicated
   body into a shared package/util.
2. **Precise** — most findings are real; a developer wouldn't dismiss the
   majority as intended.
3. **Bounded** — it can reach zero. A "top N%" ranking or metric never can —
   those belong in the dashboard, not the gate.

**Corollary:** metrics and rankings (blast radius, coupling density) are
dashboard *insights*, not rule *signals*. The contrast case is
`graph:high-blast-function`, a ranking ("the most-called functions") that can
never reach zero and isn't individually actionable — it is being **demoted to
dashboard-only** for exactly that reason. The line is: a rule asserts "this
specific thing is wrong and here is the fix"; an insight surveys "here is the
shape of the codebase."

**How this extension embodies the rubric.** It *cuts noise from both ends*:
the per-instance size floor today hides the most expensive real duplication
(small bodies copied across many packages → nothing fires), while naively
dropping the floor and emitting per-copy would produce N-1 findings per group
(spam). Grouping by body across packages and reporting **one** consolidation
target per duplicate group lands in the middle — *actionable* (every finding
is a real hoist candidate), *precise* (≥3 distinct packages is unambiguously
shared infra, not an intended twin), and *bounded* (each group goes to zero
when consolidated). That is precisely the rule-vs-insight line: this is a rule
because each finding names a fix and can be closed.

## Scope

### In Scope

- A new **aggregate cross-package duplication signal** keyed on
  `(bodyHash → distinct package count)`, with its own threshold
  `minCrossPackageDuplicatePackages` (default **3**) and **no** per-copy size
  floor.
- Reuse of `pkgOf(occ)` (`packages/graph/engine/src/resolve-callee.ts:36-38`)
  for package identity, so the signal buckets by the same real-package
  boundary the coupling grid uses.
- One signal per duplicate-body group (not N-1), listing the distinct
  packages and the occurrence count.
- The kind/test-file exclusions already applied by the per-instance path
  (skip `arrow` / `function-expression` / `module-init`; skip `inTestFile`).
- De-duplication against the existing per-instance signal so a single
  duplicate group cannot produce two near-identical findings.
- A config knob (`minCrossPackageDuplicatePackages`) on `GraphConfig`, the
  rule-ID mapping entry (if a new rule slug), and unit tests with a
  multi-package fixture.

### Out of Scope (and why)

- **Actually consolidating `stripStrings`/`stripComments`/graph-adapter
  helpers.** That is the sibling consolidation work; this spec only makes the
  duplication *visible*. The signal is expected to fire on this repo until
  that work lands — see Dogfood-gate interaction.
- **Cross-package edge attribution / coupling grid.** Already shipped
  (`graph-per-package-coupling.md`, `graph-edge-import-constraint.md`); this
  reuses `pkgOf` but touches no edge resolution.
- **A "same body, same package, N copies" aggregate.** Within-package
  duplication is what the existing size-gated per-instance path is for;
  widening it is a separate decision (see Open Questions).
- **Changing `GraphCatalog` / `CliOutput` contracts.** Additive config field
  + additive signals only.
- **Fast vs. exact mode behavior differences.** Package identity comes from
  `occurrence.package`, which is stamped in both modes by `assignPackages`
  (it reads `package.json`, not the type checker), so the signal is
  mode-agnostic with no special-casing.

## Technical Context

### Existing architecture

- **The rule:** `duplicatedFunctionBodyRule`
  (`packages/graph/engine/src/rules/duplicated-function-body.ts:29-67`).
  `evaluate(catalog, _indexes, config)` reads `minDuplicateBodyLines` /
  `minDuplicateBodySize` from config (`:33-34`), groups via `groupByHash`
  (`:69-92`), then emits **N-1 signals per group** (one per non-primary
  occurrence, `:42-63`) at `severity: 'low'`, `category: 'quality'`,
  `ruleId: 'graph:duplicated-function-body'`.
- **The size/kind filter:** `isInterestingForDup`
  (`:109-122`) drops `arrow`/`function-expression`/`module-init`
  (`:114-116`), drops `inTestFile` (`:117`), drops spans below `minLines`
  (`:118-119`), and drops bodies below `minBodySize` when `bodySize` is
  present (`:120`; absent `bodySize` is treated as "passes" — legacy
  catalogs). **This is the floor that hides the small-but-wide dups.**
- **Indexes available to the rule:** the rule currently ignores its second
  param (`_indexes`). `Indexes.occurrencesByHash: Map<bodyHash, readonly
  FunctionOccurrence[]>` (`packages/graph/engine/src/types.ts:301-308`;
  built in `pipeline/indexes.ts:36-44`, `buildHashMaps`) already holds
  **every** occurrence per body hash (collision-preserving, unlike
  `byBodyHash` which is last-writer-wins). This is exactly the grouping the
  aggregate path needs — no new index required; the rule can either consume
  `indexes.occurrencesByHash` directly or keep its own `groupByHash` walk
  (which iterates `catalog.functions` and already preserves all occurrences,
  `:76-91`).
- **Package identity:** `pkgOf(occ)`
  (`packages/graph/engine/src/resolve-callee.ts:36-38`) returns
  `occ.package ?? packageOf(occ.filePath)` — prefers the 2.4.2
  build-time stamp, falls back to the `packages/<segment>` path heuristic for
  pre-2.4.2 catalogs. Use `pkgOf` (never raw `occ.package`) so the signal is
  correct on every layout and on legacy catalogs.
- **Signal shape:** `createSignal(...)` from `@opensip-tools/core`
  (`packages/core/src/types/signal.ts:58-77`). `SignalSeverity` is
  `'critical' | 'high' | 'medium' | 'low'`; `metadata` is an open
  `Record<string, unknown>`.
- **Registration:** `BUILT_IN_RULES`
  (`packages/graph/engine/src/rules/registry.ts:40-47`) seeds the
  per-RunScope `GraphRulesRegistry`. **If** a new slug is introduced it must
  be added here AND to `RULE_ID_MAPPING`
  (`packages/graph/engine/src/render/rule-id-mapping.ts:33-40`) — a missing
  mapping throws at SARIF emission (`:58-66`), and
  `__tests__/render/rule-id-mapping.test.ts` enforces coverage by iterating
  `currentRules()`.
- **Config surface:** `GraphConfig`
  (`packages/graph/engine/src/types.ts:328-341`) — additive optional fields,
  consumed via `config.minDuplicate*` defaulting in the rule.

### Key dependencies / packages touched

- `@opensip-tools/graph` (engine): `rules/duplicated-function-body.ts`,
  `types.ts` (`GraphConfig` field), `rules/registry.ts` +
  `render/rule-id-mapping.ts` (only if a new slug), tests under
  `__tests__/rules/`.
- `@opensip-tools/core`: read-only (`createSignal`, `pkgOf` lives in graph).
- `opensip-tools.config.yml` / docs: document the new knob and the expected
  new dogfood findings.

### Constraints

- Pure data→data over the frozen `catalog`/`indexes`; no FS, no AST, no TS in
  the rule (consistent with the existing rule and `pipeline/indexes.ts`).
- Deterministic output (stable signal ordering and stable package listing —
  sort packages lexicographically).
- ESM Node16 (`.js` extensions), Node 22+, TS 5.7; type-only imports where
  possible.
- All gates green: `pnpm typecheck && pnpm test:coverage && pnpm lint`
  (ESLint + dependency-cruiser, both 0-error).
- Must not regress the existing per-instance signal or its config tests
  (`__tests__/rules/duplicated-function-body-config.test.ts`).

## Design Decisions

| Decision | Choice | Rationale | Alternatives considered |
|---|---|---|---|
| New rule vs. extend existing | **Extend the existing `graph:duplicated-function-body` rule with a second, aggregate code path** (same slug, same file). | The two paths share the body-hash grouping, the kind/test-file exclusions, and the conceptual category ("duplication"). One slug keeps the SARIF/rule-id surface unchanged (no `RULE_ID_MAPPING` add, no registry add, no new mapping test) and keeps both findings under one suppression/baseline key for the gate. The aggregate path is a *relaxation* of the same rule (drop the size floor when ≥N packages), not a different concern. | (a) **New rule `graph:cross-package-duplication`** → cleaner separation, independent severity, but adds a slug everywhere (registry, rule-id mapping + its enforcement test, docs, gate baseline) and fragments duplication findings across two rule IDs. Rejected as more surface for the same concern; recorded because reviewers may prefer the explicit slug — if so, the only deltas are the registry/mapping/test additions, the rest of this design is identical. (b) Replace the per-instance path entirely → would lose large *within-package* dups (the original, still-valid case). |
| Aggregate trigger | **Same `bodyHash` present in ≥ `minCrossPackageDuplicatePackages` (default 3) *distinct* packages** (via `pkgOf`), with the kind/test-file exclusions applied but **no** size or line floor. | **Rubric: precise + bounded.** 3 distinct packages is unambiguously "shared infra that should be hoisted" and matches the real misses (`stripStrings` = 5 packages) — that breadth threshold is what makes findings *precise* (a developer won't dismiss them as intended). It also stays comfortably clear of incidental 2-package twins (e.g. one shim copied during a migration) that may be intentional/transient. The size floor is deliberately dropped — it is the exact mechanism that hides these, i.e. the thing keeping the signal from being *actionable*; dropping it doesn't unbound the signal because each qualifying group still goes to zero on consolidation. | **N=2** → fires on every transient/intentional 2-package twin, noisier on arbitrary repos; rejected as default but exposed as the configurable floor for teams that want it. **N=2 with a residual smaller size floor (e.g. 50)** → reintroduces a floor that would still hide `stripStrings`; rejected. |
| Package identity source | **`pkgOf(occ)` (`resolve-callee.ts:36-38`)**, counting *distinct* package labels per body hash. | The canonical "what package is this in," portable across `packages/`, `apps/`+`libs/`, single-package, non-JS; falls back gracefully on pre-2.4.2 catalogs. Reusing it keeps this signal consistent with the coupling grid + edge-constraint pass. | Raw `occ.package` → undefined on legacy catalogs, no fallback. Path heuristic only (`packageOf`) → wrong on non-`packages/` layouts (the bug `graph-per-package-coupling.md` already fixed). |
| Avoid double-reporting | **Aggregate path takes priority for a group:** if a body hash qualifies for the aggregate signal (≥N distinct packages, exclusions applied), emit **only** the single aggregate signal for that group and **suppress** the per-instance N-1 signals for the same hash. Bodies that don't reach N packages flow through the unchanged per-instance path. | **Rubric: actionable + bounded.** One duplicate group → at most one *kind* of finding pointing at one *kind* of fix, so the gate/baseline isn't double-counted and a contributor doesn't see two findings (or N-1 per-copy findings) for one root cause. Per-instance, per-copy emission would be noise (many findings, one fix) and would inflate the gate count without making it more *bounded*; collapsing to one-per-group keeps each finding *actionable* and the count honest. Cross-package duplication is the more important framing, so it wins. | Emit both (per-instance + aggregate) → double-counts in the gate, confusing. Emit aggregate *in addition* only when the per-instance path was silent (size floor) → harder to reason about; the priority rule is simpler and strictly subsumes it. |
| Signal presentation | **One signal per qualifying body hash**, anchored at the lexicographically-lowest occurrence (deterministic `code` location), `severity: 'low'`, `category: 'quality'`, message naming the distinct package count + sorted package list + occurrence count; `metadata: { packages: string[], packageCount, occurrenceCount, bodyHash }`. | One actionable finding per consolidation target. Severity stays `low` (advisory, like the existing path) so it doesn't gate-fail by severity alone. Rich metadata lets the dashboard/SARIF group and the gate baseline match stably. | N-1 signals (current per-instance style) → N-1 findings for one hoist target, defeats the "aggregate" purpose. `medium` severity → risks gating before consolidation lands. |
| Config knob | **Add `minCrossPackageDuplicatePackages?: number` to `GraphConfig`** (default 3), defaulted in the rule like the existing thresholds. | Consistent with `minDuplicateBodyLines`/`minDuplicateBodySize`; lets a noisy repo raise the floor or a strict repo lower it to 2. | Hard-code N=3 → no escape hatch for arbitrary repos. Reuse an existing knob → conflates per-copy size with cross-package breadth. |

## Success Criteria (testable)

These criteria operationalize the rubric: the cross-package-fires and
no-double-report cases prove the signal is *actionable* and *bounded* (one
finding per fixable group, reaching zero on consolidation); the threshold and
within-package-suppression cases prove it is *precise* (it doesn't fire on
intended/transient twins).

New unit tests under
`packages/graph/engine/src/__tests__/rules/` (beside the existing
`duplicated-function-body-config.test.ts`, reusing `_helpers.ts`'s `occ` /
`makeCatalog`):

- [ ] **Small body in 3 packages fires (the core miss).** Three occurrences,
      same `bodyHash`, `bodySize` *below* `minDuplicateBodySize` (e.g. 50),
      in packages `pkg-a`/`pkg-b`/`pkg-c` (set via `package`). With default
      config, exactly **one** aggregate signal is emitted; its metadata lists
      the 3 sorted packages, `packageCount === 3`; **no** per-instance signal
      for that hash.
- [ ] **Within-package small dup below size floor does NOT fire.** Three
      occurrences, same `bodyHash`, small `bodySize`, all in `pkg-a` (1
      distinct package) → **zero** signals (fails both the size floor on the
      per-instance path and the package-count floor on the aggregate path).
- [ ] **Threshold honored.** Same small body in exactly **2** packages with
      default `minCrossPackageDuplicatePackages = 3` → zero aggregate
      signals; rerun with `minCrossPackageDuplicatePackages: 2` → exactly one.
- [ ] **No double-report.** A *large* body (clears the size floor) in 3
      packages → exactly one aggregate signal, NOT the aggregate + 2
      per-instance signals.
- [ ] **Exclusions still apply.** `arrow`/`function-expression`/`module-init`
      occurrences and `inTestFile` occurrences are excluded from the
      aggregate path (same body in 3 packages but all `inTestFile` → zero).
- [ ] **Legacy catalogs.** Occurrences with `package` undefined fall back to
      `pkgOf`'s path heuristic and still bucket by package (use `filePath`
      under distinct `packages/<seg>/` roots).
- [ ] **Existing per-instance tests pass unchanged**
      (`duplicated-function-body-config.test.ts`) and, if the existing-rule
      slug is reused, `rule-id-mapping.test.ts` still passes with no new
      mapping entry.
- [ ] **Re-run on this repo:** `graph` produces aggregate signals for
      `stripStrings` and `stripComments` (5 packages each) and the
      graph-adapter helpers — and these are the *expected, documented* new
      findings (see Dogfood gate).
- [ ] `pnpm typecheck && pnpm test:coverage && pnpm lint` green.

## Dogfood-gate interaction

This signal **WILL fire on this repo** the first time it runs — by design.
The expected net-new findings are:

- `stripStrings`, `stripComments` — 5 packages each (`lang-typescript`,
  `-python`, `-go`, `-java`, `-cpp`).
- The tree-sitter graph-adapter helpers (`graph-python`, `graph-rust`, …).

These are precisely the targets of the sibling consolidation work and are
already tracked by `graph-per-package-coupling.md` (the body-twin edge keying
was the first half; consolidating the *source* is the other half). The
`graph` rules feed the dogfood gate via the same SARIF/Code-Scanning ratchet
as fitness (`CLAUDE.md` → Dogfood Gate). Plan for the rollout so the new
signals don't block unrelated PRs:

1. **Preferred:** land the consolidation of `stripStrings`/`stripComments`
   and the graph-adapter helpers *before or with* this signal, so the rule
   ships green. (Quality-first, zero-tech-debt — the signal exists to be
   acted on, not baselined around.)
2. **If consolidation can't land first:** the existing-baseline ratchet
   already absorbs pre-existing findings — only *net-new* alerts surface on
   contributor PRs (`CLAUDE.md` → Dogfood Gate), so shipping the rule records
   these as the baseline and they do not gate. Document them in the PR
   description per the gate-update justification rule. A blanket
   `disabledChecks`/severity downgrade is the last resort and requires the
   same PR-description justification + reviewer sign-off.

Record the chosen rollout order in the implementation plan; do not silently
disable the rule.

## Boundaries

- **Always:** bucket by `pkgOf` (stamp + fallback); count *distinct*
  packages; apply the kind/test-file exclusions; emit one aggregate signal
  per qualifying hash with deterministic anchor + sorted package list;
  preserve the existing per-instance path for sub-threshold groups; `.js`
  ESM extensions; pure data→data.
- **Ask first:** introducing a *separate* rule slug
  (`graph:cross-package-duplication`) instead of extending the existing rule;
  raising aggregate severity above `low`; changing the default N from 3;
  any `GraphCatalog`/`CliOutput` contract change.
- **Never:** emit both an aggregate and per-instance signal for the same body
  hash; use raw `occ.package` without the `pkgOf` fallback; reintroduce a
  size floor on the aggregate path (it is the thing that hides these dups);
  add FS/AST/TS access to the rule; produce non-deterministic ordering.

## Open Questions

- [x] **N default — 3 vs 2?** **RESOLVED:** ship the default at **3** (safe for
      arbitrary repos — unambiguous shared infra, low false-positive rate), and
      **set `minCrossPackageDuplicatePackages: 2` in this repo's
      `opensip-tools.config.yml`** — we verified every 2-package duplicate here
      is a real consolidation target (plugin-loader fitness↔simulation,
      `createPathMatcher` checks-ts↔universal, `safeReaddir`), with zero intended
      twins, so the local opinion is earned. Clean split: conservative default,
      opinionated local override. The implementation plan must add the config
      line + a note in the config reference.
- [ ] **Should the aggregate path also cover large within-package N-copy
      dups** (same body, ≥N occurrences, 1 package), reporting them as one
      aggregate instead of N-1 per-instance signals? Out of scope here, but
      the same grouping machinery would support it; decide separately.
- [ ] **Message copy.** Exact wording of the aggregate message (it must read
      well in SARIF/Code-Scanning inline) — finalize in implementation; the
      load-bearing parts are the package count, the sorted package list, and
      a "hoist to a shared package" suggestion.
- [ ] **Anchor occurrence choice.** Lexicographically-lowest `qualifiedName`
      (mirrors `resolveCallee`'s deterministic fallback) vs.
      lowest-`filePath` — pick one and keep it consistent for stable
      fingerprints; proposed: lowest `qualifiedName`.

## Applicable Conventions (from CLAUDE.md)

- **Errors:** none expected (pure analysis); no new typed errors.
- **Logging:** optional `evt` debug counter for aggregate groups emitted /
  per-instance signals suppressed, mirroring `pipeline/indexes.ts` logging
  style — cheap and useful for verifying the no-double-report rule.
- **Config:** additive optional `GraphConfig.minCrossPackageDuplicatePackages`
  with an in-rule default; documented in the config reference.
- **DI / RunScope:** none new; rule is a pure function over
  `catalog`/`indexes`/`config`. If a new slug is chosen, register it in the
  per-RunScope `GraphRulesRegistry` (`rules/registry.ts`) — never a
  module-singleton.
- **Testing:** Vitest; tests beside source under
  `packages/graph/engine/src/__tests__/rules/`, reusing `_helpers.ts`;
  coverage thresholds enforced (`pnpm test:coverage`).
- **Layering:** engine-internal only; `createSignal` from
  `@opensip-tools/core`; no cross-layer deps added; dependency-cruiser stays
  green. If a new slug is added, update `RULE_ID_MAPPING` so
  `rule-id-mapping.test.ts` (which iterates `currentRules()`) stays green.
- **Docs:** after any reader-facing doc edit, run `pnpm docs:build` and
  commit the regenerated `docs/web-generated/` (the new knob belongs in the
  graph config reference + the checks/rules index).
