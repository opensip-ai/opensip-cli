---
status: current
last_verified: 2026-05-22
title: "Plan consistency pass — cross-layer reconciliation"
audience: [contributors, architects]
related-plans:
  - ./2026-05-22-plan-layer-1-core.md
  - ./2026-05-22-plan-layer-2-contracts.md
  - ./2026-05-22-plan-layer-3-tools-and-lang.md
  - ./2026-05-22-plan-layer-4-check-packs.md
  - ./2026-05-22-plan-layer-5-cli.md
---
# Plan consistency pass — cross-layer reconciliation

Each of the 5 layer plans was written looking at its own layer in isolation, with deliberate cross-references for coordination. This pass walks the conflicts: every place where two plans claim the same code change, plus every place where a phase's "depends on" doesn't quite match what the upstream plan ships. Resolutions below are binding for execution — the layer plans defer to this document for the conflicting items.

Wave 1 (the seven P0 fixes) has already shipped (commits `efba14c` … `364c0be`). The conflicts cataloged here are between the **remaining** phases.

---

## Ground rules

1. **One owner per change.** When two plans describe the same edit, exactly one owns the work; the other plan references it.
2. **Layer 1 ships its primitives first; Layer 3 adopts.** Several Layer 3 phases ("adopt core's helpers") are no-ops if Layer 1 hasn't shipped them yet. The shared primitives land in Layer 1 phases; per-pack adoption lives in Layer 3.
3. **Closer-to-the-data wins.** When fitness and contracts both touch the same shape (e.g. `getErrorSuggestion`), the package that owns the type owns the change.
4. **Documentation moves with the canonical change.** If finding F-X is fixed in Layer 2 Phase 3, the related Layer 5 phase only documents the import-path update; it doesn't re-describe the fix.

---

## Conflict 1 — `getErrorSuggestion` rewrite

**Plans claiming it:** Layer 2 Phase 1; Layer 5 Phase 4 (CLI audit F4).

**Resolution:**
- **Layer 2 Phase 1 owns the rewrite** — replaces the substring-match ladder with a flat `{ match, suggest }` table inside `packages/contracts/src/exit-codes.ts`.
- **Layer 5 Phase 4 consumes** the rewritten helper. The CLI's responsibility is:
  1. Route the `parseAsync().catch(...)` block through `setExitCode` (not `process.exitCode` directly).
  2. Decide whether to add a typed `OpenSipError` hierarchy in contracts (an extension of Layer 2's strategy table) — this is a *Layer 2* contract change. Layer 5 files an issue against Layer 2 if it wants typed errors; Layer 2 owns the type definitions either way.
- **Sequencing:** Layer 2 Phase 1 must land before Layer 5 Phase 4.

**Implementation note:** Layer 2 Phase 1 already drops the over-broad `'config'` substring rule. Layer 5 Phase 4 should NOT re-describe that change in its commit message.

---

## Conflict 2 — `Tool.renderLive` contract change

**Plans claiming it:** Layer 5 Phase 2 (CLI audit F2); Layer 3 plan does NOT explicitly own this but Layer 5 says "the Layer 3 plan must decide the new shape."

**Resolution:**
- The contract lives in `@opensip-tools/core` (where `ToolCliContext` is defined), so this is technically a **Layer 1 concern, not Layer 3**. The Layer 3 plan was the wrong destination — the change touches `packages/core/src/tools/types.ts`.
- **Add a new Layer 1 phase** (Phase 8 — "Tool.renderLive contract refresh") that owns the type change. Recommended option from Layer 5's analysis: **option (2) — `ToolCliContext.registerLiveView(key, renderer)`** (smallest change that closes the architectural hole).
- **Layer 3 phases A1/A3/B1/etc. are unaffected** — none of them touch `Tool.renderLive`.
- **Layer 5 Phase 2 consumes** the new contract: removes the `viewKey === 'fit'` switch, replaces with registry lookup.
- **Layer 5 Phase 3** then moves the per-tool view controllers into the tool packages (each tool's `register(cli)` calls `cli.registerLiveView('fit', renderFitLive)`).

**Sequencing:** Layer 1 Phase 8 (new) → Layer 5 Phase 2 → Layer 5 Phase 3.

**Update Layer 1 plan:** add Phase 8. Update Layer 5 Phase 2's "Depends on" to point at Layer 1 Phase 8.

---

## Conflict 3 — `program: unknown` typing leak

**Plans claiming it:** Layer 5 Phase 2 (option 1 — typed re-export from contracts: `export type CliProgram = Command`).

**Resolution:**
- The re-export Layer 5 wants lives in `@opensip-tools/contracts`, but `Command` comes from `commander` — not a workspace package. Layer 2 currently has no phase that adds this re-export.
- **Add to Layer 2 Phase 5** ("Documentation, deprecation, and policy"): expand it to also export a typed `CliProgram` alias from `@opensip-tools/contracts`. Trivial, cohesive with the policy phase (it documents how tools should depend on Commander).
- Each tool drops its `as Command` cast and imports `CliProgram` from contracts.

**Update Layer 2 Phase 5:** add the `CliProgram` re-export to its file list.

---

## Conflict 4 — `defineRegexListCheck` Template

**Plans claiming it:** Layer 4 Phase C6 ("depends on Layer 3 plan introducing the helper"); Layer 3 plan does NOT explicitly carve out a phase for this.

**Resolution:**
- Layer 3 plan's Group D ("Fitness engine") doesn't have a phase that introduces `defineRegexListCheck`. It must — without it, Layer 4 Phase C6 can't ship.
- **Add to Layer 3 Group D as Phase D6** ("Introduce `defineRegexListCheck` Template helper"). Lives in `packages/fitness/engine/src/framework/define-regex-list-check.ts`. Wraps `defineCheck` with the `for line; for pattern; if match push` skeleton plus per-pattern UUID + sub-slug support, matching the existing `no-console-log.ts` shape.
- Layer 4 Phase C6 consumes the helper.

**Sequencing:** Layer 3 D6 → Layer 4 C6.

**Update Layer 3 plan:** insert new Phase D6. Existing D5 ("Minor consolidations") becomes D7 (or D6 stays "minor" and the new helper takes a different number — pick the lowest free slot).

---

## Conflict 5 — `metadata.version` drift fix

**Status:** Already shipped in Wave 1 (commit `364c0be`).

- Layer 4 Phase B1 still describes this. **Mark Layer 4 Phase B1 as `closed by Wave 1`** in the plan; remove the work from the next-actions list.

---

## Conflict 6 — clang-tidy file-path bug

**Status:** Already shipped in Wave 1 (commit `efba14c`).

- Layer 4 Phase A1 still describes this. **Mark Layer 4 Phase A1 as `closed by Wave 1`**. Layer 4 Phase A1's stretch goals (audit F2 / F3 — YAML `-export-fixes`, `note:` line handling) remain in Layer 4's "Deferred" section, untouched.

---

## Conflict 7 — Lang-pack lexer correctness fixes

**Status:** Mostly shipped in Wave 1.

| Audit finding | Wave 1? | Owner of remaining work |
|---|---|---|
| lang-java F1 (text-block escape) | ✅ commit `4254e72` | — |
| lang-java F2 (char-literal bound) | ✅ commit `4254e72` | — |
| lang-java F6 (branch-order comment) | ✅ commit `4254e72` | — |
| lang-python F1 (raw-string escape) | ✅ commit `b900843` | — |
| lang-python F2 (empty-triple disambiguation pin) | ✅ commit `b900843` | — |
| lang-cpp F3 (line continuation) | ✅ commit `d92bbb7` | — |
| lang-cpp F5a (`u8` prefix) | ✅ commit `d92bbb7` | — |
| lang-cpp F5b (char-literal bound) | ✅ commit `d92bbb7` | — |
| lang-go F4 (rune-literal pin) | ✅ commit `e6eb358` | — |
| lang-go F5 (regression-test gaps) | ✅ commit `e6eb358` | — |

- **Mark Layer 3 Phase A1 as `partially closed by Wave 1`**. Open items remaining for Phase A1: lang-python F4 (single-string newline-as-terminator pin — minor), lang-go F1/F3 (parse.ts `null` type honesty — minor, also tracked under Layer 1 Phase 3 / Layer 3 Phase B1).

---

## Conflict 8 — Graph `RuleHints` wiring

**Status:** Already shipped in Wave 1 (commit `8010c2e`).

- Layer 3 Phase A3 still describes this. **Mark Layer 3 Phase A3 as `closed by Wave 1`**.

---

## Conflict 9 — `filterContent` move + `ts` re-export drop

**Plans claiming it:** Layer 3 Phase D3 owns the `filterContent` move and the `ts` re-export drop from fitness; Layer 4 Phase D5 also describes the call-site sweep for the `ts` re-export drop.

**Resolution:**
- **Layer 3 Phase D3 owns the source-of-truth changes**:
  1. Move `filterContent`/`clearFilterCache`/`FilteredContent` from `packages/fitness/engine/src/framework/content-filter.ts` to `packages/languages/lang-typescript/src/filter.ts`.
  2. Add `export * as ts from 'typescript'` (or equivalent) from `lang-typescript/src/index.ts`.
  3. Drop the `ts` re-export from `fitness/engine/src/index.ts`.
  4. Delete the `lang-no-fitness-except-typescript` dep-cruiser rule.
- **Layer 4 Phase D5 owns the call-site sweep** in checks-typescript: update the 6 outlier files that import `ts` from fitness.
- **Sequencing:** Layer 3 D3 must land before Layer 4 D5 (so the `ts` re-export still exists when D5 sweeps the call sites; once D5 lands, fitness's `ts` re-export can be removed in a follow-up commit). Or — cleaner — D3 lands first with a temporary fitness re-export marked `@deprecated`; D5 sweeps the call sites; a final commit removes the fitness re-export.

**Update Layer 4 Phase D5:** restate scope as "sweep call sites only; the symbol relocation is owned by Layer 3 Phase D3."

---

## Conflict 10 — AST helper consolidation

**Plans claiming it:** Layer 4 Phase D2 ("Move AST helpers to lang-typescript"); Layer 3 lang-typescript audit Finding 1 calls the same shim out as accumulating cruft.

**Resolution:**
- **Layer 4 Phase D2 owns the consolidation** — promotes `findEnclosingFunction`, `isInAsyncContext`, etc. from inline copies in checks-typescript to `@opensip-tools/lang-typescript/ast-utilities.ts`.
- The Layer 3 plan's lang-typescript audit findings (1–8) are deferred per the Layer 3 "Deferred" section as a "lang-typescript v2 release" bundle — they should NOT also describe the AST-helper move.

**No update needed.** Layer 3 already defers; Layer 4 owns the per-helper migration.

---

## Conflict 11 — Layer 3 fitness phase numbering

The Layer 3 plan's Group D phases are D1, D2, D3, D4, D5. Conflict 4 above adds a new phase ("Introduce `defineRegexListCheck` Template helper"). Pick a slot:

**Resolution:** Insert as **Phase D4.5** (or renumber D5 → D6 and place the new helper at D5). Recommend **D6 = new helper**; keep existing D5 ("Minor fitness consolidations") at D5; the helper introduction is conceptually after D1–D4 because it depends on no other Group D phase but blocks Layer 4 C6.

**Update Layer 3 plan:** insert "Phase D6 — Introduce `defineRegexListCheck` Template helper" in the spot described in Conflict 4.

---

## Conflict 12 — RecipeRegistry promotion to core

**Plans claiming it:** Layer 3 Phase E3 ("Promote `RecipeRegistry<T>` to core").

**Resolution:** No conflict. Layer 1 plan does NOT describe this; Layer 3 Phase E3 owns the move into `@opensip-tools/core/recipes/registry.ts`. Layer 1's Phase 1 (registry duplicate-id policy reconciliation) ships first and the new core registry follows the reconciled policy.

**Sequencing:** Layer 1 Phase 1 → Layer 3 Phase E3.

---

## Conflict 13 — `LangPluginExports` discovery

**Plans claiming it:** Layer 1 plan's "Deferred" notes that `LangPluginExports` is forward-compatible metadata with no walker; Layer 3 / Layer 4 don't claim it.

**Resolution:** No conflict. Stays in Layer 1's deferred section.

---

## Conflict 14 — Dashboard package extraction (Layer 2 Phase 3)

**Plans claiming it:** Layer 2 Phase 3 (the central architectural change); Layer 5 Phase 8 references it as a coordination item ("update `cli/open-dashboard.ts` import path").

**Resolution:**
- **Layer 2 Phase 3 owns the extraction** — creates `@opensip-tools/dashboard`, moves the dashboard subtree, updates dep-cruiser rules, bumps RELEASING.md 18 → 19, updates docs.
- **Layer 5 Phase 8** does the trailing one-line CLI import update.
- **Layer 4 plan** is unaffected — check packs don't import the dashboard.

**No update needed.** Layer 2 plan already accounts for this. Note: Layer 5 Phase 8 is the import-update only, not a re-description of the extraction.

---

## Conflict 15 — Comment-opener table (Layer 3 Phase D5)

**Plans claiming it:** Layer 3 Phase D5 (extract a shared `COMMENT_OPENERS` table for fitness's directive parsers); Layer 1 Phase 3 (extracts C-family scanner scaffolding into `core/src/languages/strip-utils.ts`).

**Resolution:**
- These are different abstractions. Layer 1 Phase 3's scanners (`scanLineComment`, `scanBlockCommentNonNesting`) are about *stripping* comments from source for the content-filter pipeline. Layer 3 Phase D5's `COMMENT_OPENERS` table is about *parsing directive comments* in the fitness directive system (`@fitness-ignore-next-line`, `@fitness-ignore-file`).
- Different consumers, different shapes. Both are correct.

**No update needed.**

---

## Conflict 16 — Layer 1 Phase 3 vs Layer 3 Phase B1 dependency

**Plans claiming it:** Layer 1 Phase 3 extracts the C-family helpers; Layer 3 Phase B1 adopts them.

**Resolution:**
- Already correctly modeled. Layer 1 Phase 3's "Steps" enumerate exactly what Layer 3 Phase B1 needs (`scanLineComment`, `scanBlockCommentNonNesting`, `scanBlockCommentNesting`, `scanRegularString({ allowMultiline })`, `MinimalTextTree`).
- Confirmed sequencing: Layer 1 Phase 3 → Layer 3 Phase B1.

**No update needed.**

---

## Sequencing summary (post-reconciliation)

The dependency DAG between the remaining plan phases, after this consistency pass:

```
Wave 1 (shipped):
  ✅ Layer 4 Phase A1 (clang-tidy)
  ✅ Layer 4 Phase B1 (metadata.version)
  ✅ Layer 3 Phase A1 (most lang-pack fixes)
  ✅ Layer 3 Phase A3 (graph RuleHints)

Wave 2 — Foundations (sequential, single agent each):
  Layer 1 Phase 1 (registry duplicate-id policy)
       ↓
  Layer 1 Phase 2 (alias canonicalization)
       ↓
  Layer 3 Phase A2 (alias trap fix — consumes Phase 2)
  Layer 3 Phase E3 (RecipeRegistry promotion — consumes Phase 1)

  Layer 2 Phase 1 (getErrorSuggestion table)  [parallel-OK]
  Layer 2 Phase 2 (Finding/CheckOutput consolidation)  [parallel-OK]

Wave 3 — Big architectural moves (each single agent):
  Layer 1 Phase 3 (C-family scanner extraction)
       ↓
  Layer 3 Phase B1 (lang-pack adoption)

  Layer 1 Phase 8 NEW (Tool.renderLive contract)
       ↓
  Layer 5 Phase 2 (Tool contract leak fix)
       ↓
  Layer 5 Phase 3 (UI/tool decoupling)

  Layer 2 Phase 3 (dashboard package extraction — 18 → 19)
       ↓
  Layer 5 Phase 8 partial (CLI dashboard import update)

  Layer 3 Phase D6 NEW (defineRegexListCheck helper)
       ↓
  Layer 4 Phase C6 (regex-list adoption)

  Layer 3 Phase D3 (filterContent move + ts re-export drop)
       ↓
  Layer 4 Phase D5 (checks-typescript ts call-site sweep)

Wave 4 — Mostly-parallel cleanups (multiple agents OK):
  Layer 1 Phases 4, 5, 6, 7
  Layer 2 Phases 4, 5
  Layer 3 Phases C1, C2, C3, D1, D2, D4, D5, D7, E1, E2
  Layer 4 Phases B2, B3, B4, C1, C2, C3, C4, C5, D1, D2, D3, D4, D6, D7
  Layer 5 Phases 1, 4, 5, 6, 7, 8 remainder
```

The Wave 4 phases are largely independent of each other; they can run in parallel with sensible PR-scope batching. Wave 3 phases must respect the per-chain sequencing shown above but the chains run in parallel with each other.

---

## Updates to land in the plan files (mechanical)

After this consistency pass, each layer plan needs small surgical edits to absorb the resolutions above. The edits should land in a single follow-up PR titled `docs(plans): apply consistency-pass updates to layer plans`. Concretely:

1. **Layer 1 plan** — add Phase 8 (Tool.renderLive contract refresh). Two paragraphs of scope.
2. **Layer 2 plan** — Phase 5 file list adds `CliProgram` re-export (one bullet).
3. **Layer 3 plan** — insert Phase D6 (`defineRegexListCheck` helper). Mark Phase A1 / A3 as "closed by Wave 1" with commit references.
4. **Layer 4 plan** — mark Phase A1 and Phase B1 as "closed by Wave 1" with commit references. Phase D5 scope clarifies "call-site sweep only; symbol relocation is Layer 3 D3."
5. **Layer 5 plan** — Phase 2's "Depends on" updates to point at Layer 1 Phase 8 (not "Layer 3 plan must decide"). Phase 4's "Depends on" stays as Layer 2 Phase 1.

These edits are the deliverable of this consistency pass — actual code work resumes once they land.

---

## What this pass did NOT change

- **Per-finding decisions inside each layer plan.** Audit findings stay scoped to their layer's plan; no relitigation.
- **The five plans' Deferred sections.** Each plan's Deferred remains the source of truth for what's intentionally not done.
- **Phase priorities (P0/P1/P2).** Untouched.

The pass was structural — who owns what — not editorial.
