---
status: active
last_verified: 2026-06-05
owner: opensip-tools
---

# ADR-0014: Inline signal suppression is a shared core primitive

```yaml
id: ADR-0014
title: Inline signal suppression is a shared core primitive
date: 2026-06-05
status: active
supersedes: []
superseded_by: null
related: [ADR-0001, ADR-0005, ADR-0011]
tags: [core, signals, suppression, graph, fitness]
enforcement: not-mechanizable
enforcement-reason: >
  This is a placement/ownership decision. The layer inversion it rejects
  (graph importing fitness for suppression) is already blocked mechanically by
  dependency-cruiser's tool-peer rules; the positive obligation ("both tools
  consume the core primitive rather than reimplementing") is a design judgment
  verified in review, not by a checker.
```

**Decision:** Inline, per-occurrence, reason-carrying suppression of findings is
a **shared primitive in `@opensip-tools/core`**, operating on the `Signal`
stream — not a per-tool feature. Fitness's existing implementation (today in
`packages/fitness/engine/src/framework/{directive-parsing,ignore-processing}.ts`)
is migrated onto it; graph adopts it for its rule findings. Config-level *whole-
rule* disable (`disabledChecks` / a future graph `disabledRules`) stays per-tool
and is explicitly **out of scope** — it is a thin set-membership filter over each
tool's own registry, not a shared concern. This extends ADR-0005's "hoist shared
substrate to core" symmetry principle from recipes to suppression.

**Alternatives:**

1. **Graph reimplements its own directive parser + filter.** Rejected: it
   duplicates logic that is already `Signal`-shaped and tool-agnostic, and
   produces two divergent suppression dialects (`@fitness-ignore` vs an
   independent `@graph-ignore`) that drift. Directly contradicts ADR-0005, which
   chose parity-via-shared-substrate over per-tool reinvention.
2. **Keep fitness's implementation where it is; graph imports it from
   `@opensip-tools/fitness`.** Rejected: fitness and graph are *peer* tools, not
   layers. A `graph → fitness` import inverts the dependency graph (blocked by
   dependency-cruiser) and silently anoints fitness as a kernel for suppression —
   exactly the module-singleton-by-accident shape the kernel split was meant to
   end.
3. **Ship only the baseline ratchet (`gate.ts` `--gate-save`/`--gate-compare`);
   no inline waiver.** Rejected: the ratchet is a *gate* ("don't get worse"), not
   a *waiver* ("we judged exactly this finding acceptable, here's why"). Its
   fingerprint is `rule + file + line + message` (`fingerprintSignal`), so it is
   undifferentiated (accepts the whole current set at once), carries no reason,
   and is line-fragile (edits above a finding re-fingerprint it). Inadequate for
   recording a durable, co-located human verdict.
4. **[Chosen] Hoist the inline-suppression substrate to `@opensip-tools/core`;
   both tools consume it.**

**Rationale:**

- **The mechanism is already `Signal`-shaped, and `Signal` already lives in
  core.** `Signal` + `createSignal` are defined in
  `packages/core/src/types/signal.ts`. Fitness's `filterSignalsByDirectives`
  (`ignore-processing.ts`) consumes `readonly Signal[]` and keys suppression on
  `signal.code.file` + `signal.code.line` + the rule slug — it is *not* check-
  shaped. It sits under `fitness/framework/` for historical reasons (fitness was
  built first), not architectural ones.
- **Graph emits the identical currency.** Every graph rule builds
  `createSignal({ source: 'graph', ruleId: 'graph:…', code: { file, line, column
  }, … })` (e.g. `rules/cycle.ts`, `rules/large-function.ts`), and `cli/graph.ts`
  aggregates them into `result.signals: Signal[]` *before* it reaches gate /
  persist / render — a clean insertion point that mirrors where fitness already
  applies its filter.
- **Precedent.** ADR-0005 hoisted the recipe substrate into core to give graph
  parity with fitness rather than forking it. ADR-0011 made `Signal` the
  universal output currency. A `Signal → Signal` suppression transform is the
  natural next member of that core surface.
- **Separation of concerns keeps core a kernel.** Core owns only the
  language-neutral pieces: scanning C-style comment directives into
  `(file, line, ruleId) → suppressed`, the `Signal`-stream filter, and the
  anti-recursion guard (never suppress a finding that points *at* a directive
  line). Fitness keeps its fitness-only layers on top — `DirectiveEntry` /
  weak-reason auditing and `CheckResult` rebuilding. Graph keeps its rule-
  specific concerns (notably anchor reporting, below). Core gains no fitness or
  graph import; both depend *downward* on core, preserving the layer direction.
- **The cycle-anchor wrinkle is a tool-layer ergonomics problem, not a mechanism
  problem.** `graph:cycle` anchors its one-per-SCC signal at the lowest-
  `qualifiedName` member (`anchorOccurrence`), so "which line do I annotate?" is
  non-obvious. But that anchor line *is* a real source line, so the core filter
  works unchanged; graph resolves the ergonomics by (a) surfacing the anchor
  location clearly and (b) honoring a directive placed on **any** member of the
  SCC (graph holds every member occurrence and can test each against the
  suppressed set). The shared primitive does not need to know about SCCs.

**Consequences:**

- New core surface (working name `core/signals/suppress`): a keyword-agnostic
  directive scanner + `Signal`-stream filter. The directive keyword is a
  parameter so the primitive stays tool-neutral. File I/O is injected (a passed-
  in content reader), keeping the core module pure.
- **Keyword policy — explicit per-tool, no generic catch-all.** Each tool owns a
  distinct, self-identifying directive namespace: fitness keeps
  `@fitness-ignore-file` / `@fitness-ignore-next-line`, graph gets
  `@graph-ignore-file` / `@graph-ignore-next-line`. The core primitive is
  **keyword-agnostic** — the keyword is a required parameter — but a unified
  `@osip-ignore-* <ruleId>` is **explicitly rejected**: a reader at the
  suppression site must see *which subsystem* is being silenced without decoding a
  rule id, and a generic verb invites over-broad, low-thought suppression. The
  shared piece is the *machinery*, not the *vocabulary*; the vocabulary stays
  conspicuous and tool-specific. (No migration of existing `@fitness-ignore` uses —
  they are already correct.)
- Fitness is refactored to consume the core primitive with **no behavior change
  and no keyword change** — a pure internal move that pays down the accidental
  `fitness/framework` home.
- Graph gains a durable, co-located, reason-carrying waiver — the missing
  counterpart to its baseline gate. This is a **3.0 GA prerequisite**: without it
  the only ways to silence a known-intentional graph finding are a *global*
  threshold bump (which also hides real findings) or the brittle baseline ratchet.
- **Reason policy matches fitness exactly:** suppression is *unconditional* — a
  `@graph-ignore` with no `-- reason` still suppresses, just as
  `filterSignalsByDirectives` does today. Reason *quality* is enforced
  out-of-band, mirroring fitness's two mechanisms: a `graph-ignore-hygiene` check
  (parallel to `fitness-ignore-hygiene`) and a `_directives/graph.ts` parser in
  the existing `directive-audit` framework — both in `@opensip-tools/checks-
  universal`, which already audits foreign directives (eslint/ts/semgrep), so
  graph is a 1:1 extension with no graph import.
- Out of scope, stays per-tool: whole-rule disable (`disabledChecks` /
  `disabledRules`) and the baseline ratchet. They solve different problems
  (don't-run / don't-regress) than the inline waiver (this-one-is-fine-because).
- Follow-up spec required under `docs/plans/specs/` before implementation.

**Related specs / ADRs:** Implemented by a forthcoming spec in
`docs/plans/specs/` (graph inline-suppression / shared-core extraction).
Related: ADR-0005 (symmetric tool architecture; hoist shared substrate to core),
ADR-0011 (Signal as universal output currency), ADR-0001 (graph rules
actionable/precise/bounded — the waiver is how an intentional finding leaves the
bounded set).
```
