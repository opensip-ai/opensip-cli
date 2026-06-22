---
name: backend-plan
description: >
  Create backend implementation plans for opensip-cli features in docs/plans/. Use this skill when the user asks
  to plan work on the opensip-cli codebase — a new tool or command, graph engine changes, fitness checks, language
  adapters, config schema additions, datastore/persistence work, the MCP server, or any packages/ change. Trigger
  on "create a plan", "plan this out", "make a backend plan", or "turn this into a plan" when the work involves
  opensip-cli packages/. This is the opensip-cli-specific planning skill — it produces a draft and then chains into
  the curtailed 9-phase opensip-cli plan-improvements pipeline (autonomous mode) to enrich it. For the main opensip
  platform use that repo's backend-plan; for unrelated projects use generic-backend-plan.
---

# Implementation Plan Skill (opensip-cli)

Your job is to produce a **draft** implementation plan for the **opensip-cli**
codebase, then immediately chain into the **9-phase** opensip-cli
plan-improvements pipeline that enriches the draft into an implementation-ready
document.

opensip-cli is a **local-first, single-process, SQLite-backed CLI** — a generic
tool-plugin dispatcher hosting `fit`, `graph`, and `sim`. It has **no Postgres,
no tenants, no DBOS, no HTTP server, no distributed tracing, no audit chain, no
auth/RBAC.** Never plan those concerns here — the pipeline's phases are curtailed
to the invariants that actually govern this repo (the layer DAG, `RunScope`, the
documented `ToolCliContext` seams, the host-owned baseline/ratchet plane, the
dogfood fitness gate, and the ADR log).

Plans live in `docs/plans/` as a directory with a top-level `plan.md` and separate
`phase-N-name.md` files for each phase. (`docs/plans/` is gitignored scratch space
in this repo — see `docs/plans/README.md`.)

## Required output structure (HARD REQUIREMENT)

A plan is a directory with:

- exactly one `plan.md` (overview only — Problem, Target State, Design Principles, Phases table, Dependency Graph, File Change Summary, Critical Files Reference)
- **N separate `phase-N-name.md` files** (one per phase, including Tests and Validation)

`plan.md` must NOT contain phase task content (Files / Context / Steps / Wiring /
Verification / Commit). Per-task detail lives in the phase files **only**.

> Note: the two existing ready plans (`mcp-server/plan.md`,
> `near-clone-detection/plan.md`) are single-file — they were authored before this
> pipeline existed. New plans use the split structure.

### Cross-cutting contracts in `plan.md` — allowed AFTER the pipeline runs

`plan.md` has two lifecycle stages:

- **Draft stage (Step 2 output):** strictly an index. Problem, Target State, Design Principles, Phases table, Dependency Graph, File Change Summary, Critical Files Reference. **Soft cap ~250 lines.** No cross-cutting policy yet.
- **Post-pipeline stage (Step 3 output):** the pipeline's persistence (Phase 3), observability (Phase 6), hardening/trust (Phase 7), and architectural-compliance (Phase 2) passes produce *cross-cutting policy contracts* that span every phase file. These go in `plan.md`, in a single section after the index sections. **Soft cap ~500 lines.**

Placement:

```
## Problem
## Target State
## Design Principles
## Phases (table)
## Dependency Graph
## File Change Summary
## Critical Files Reference
## Cross-cutting contracts (added by plan-improvements pipeline)   ← post-pipeline only
   ### Architectural compliance invariants   (Phase 2: layer DAG, RunScope, seams)
   ### Persistence & datastore               (Phase 3: SQLite planes, schema evolution)
   ### Observability                         (Phase 6: opt-in OTel, logger evts, session record)
   ### Hardening & trust                     (Phase 7: input safety, bounds, plugin admission)
```

What stays forbidden in `plan.md` even post-pipeline: the **task structure**
(Files / Context / Steps / Wiring / Verification / Commit) — those always live in
`phase-*.md`. Keep contracts at the *rule* level ("every tool handler uses only
the documented `ToolCliContext` seams", "every persisted payload is
forward-compatible with an absent-field default").

If your *draft* `plan.md` contains cross-cutting contracts, strip them and let
Step 3 produce them. If your *post-pipeline* `plan.md` exceeds ~500 lines, tighten
the contracts rather than splitting into files.

**Pre-flight commitment (before writing any file):** after research (Step 1) and
before drafting, render the file list as a fenced code block — the literal
expected output reviewers grep for:

````
PRE-FLIGHT FILE LIST for <plan-path>/:
  - plan.md
  - phase-0-<name>.md
  - phase-1-<name>.md
  - ...
  - phase-N-1-tests.md
  - phase-N-validation.md
````

Then write the files in that order. If you find yourself writing phase task
content inside `plan.md`, stop — move it into the appropriate `phase-*.md`.

**Escape hatch — when NOT to use this skill:** if the request is an exploratory
sketch or open-ended brainstorm not yet ready for implementation, do NOT use this
skill. Suggest `/brainstorming`, or direct the user to a free-form doc under
`docs/plans/backlog/<name>.md` (a single file is fine *outside* a plan directory).
A plan directory containing only `plan.md` is always wrong for a new plan.

## Scope: this skill produces a draft, not a finished plan

The skill produces a structurally-correct, factually-grounded **scaffold** with
real file paths, real line numbers, dependency-correct phase ordering, and
placeholder Tests + Validation phases. Architectural compliance, persistence,
observability, hardening, and ADR concerns are **deliberately NOT addressed in the
draft** — they are owned by the downstream pipeline at
`docs/ai-helpers/prompts/plan-improvements/plan-improvements.md` and your
speculation will be overwritten. See "Anti-overreach" below.

## Your workflow

1. **Surface assumptions and confirm** — block on user response.
2. **Research** — read existing code; verify file paths, line numbers, signatures.
3. **Draft** — write `plan.md` and all `phase-N-name.md` files.
4. **Chain into plan-improvements (autonomous mode)** — immediately run the 9-phase pipeline against the draft. Do not stop after the draft.

Do all four steps in sequence.

## Step 0: Surface assumptions and confirm

**Spec branch.** If a spec for this work exists under `docs/plans/specs/`, read it
first (this repo keeps specs there, not `docs/specs/`). The spec grounds scope and
target state — your assumptions become a *confirmation* of the spec's framing.

**No-spec branch.** If no spec exists, the assumptions block is the only alignment
artifact before refinement runs. Be more explicit.

Either way, output:

```
ASSUMPTIONS I'M MAKING:
1. [scope — which packages are involved]
2. [constraints — backwards compat, persistence/migration, performance]
3. [dependencies — what existing substrate to build on]
4. [out of scope — what this plan does NOT cover]
-> Confirm or correct. I will not proceed until you respond.
```

**Block on user response.** Once the draft chains into autonomous plan-improvements,
9 phases compound any wrong assumption before you see the result — Step 0 is the
only human checkpoint.

## Step 1: Research

Read 1-2 existing plans to internalize the format: the split-file plans this
pipeline produces, plus the existing single-file `docs/plans/ready/*/plan.md` for
voice. Read `docs/plans/README.md` for the layout contract and `CLAUDE.md` for the
architecture (layer DAG, RunScope, seams, dogfood gate).

Then read the actual code. Every file path, line number, function signature, and
type name in your draft must be verified by reading the file. Plans with invented
line numbers are useless — Phase 1 expects them correct.

## Step 2: Draft `plan.md` AND every `phase-N-name.md`

The plan directory is named descriptively (no date prefix). Example:
`docs/plans/ready/graph-impact-command/`.

**Before writing**, output the pre-flight commitment. Then write `plan.md` first,
then each `phase-*.md` in order. At draft stage, if `plan.md` grows past ~250 lines
or contains task-level detail, split phases into `phase-*.md` now.

```markdown
# [Feature Name] Plan

[1-2 sentence summary of what this plan accomplishes and why it matters.]

## Problem

[What's wrong or missing today. Reference actual code, actual behavior.]

## Target State

[What the system looks like after. Config examples, command shapes, or API sketches if helpful.]

## Design Principles

**No backwards compatibility.** Changes replace the old approach entirely. No optional parameters preserving old behavior, no feature flags, no compatibility shims. (Forward-compatible *optional catalog/payload fields* with an absent-field default are NOT a shim — they are the documented persistence-evolution pattern, e.g. `FunctionOccurrence.bodySize?`.)

**Plan-improvements pipeline.** Architectural compliance, persistence, observability, hardening, and ADR decisions are deferred to the 9-phase pipeline (`docs/ai-helpers/prompts/plan-improvements/plan-improvements.md`) which runs immediately after this draft. Do not pre-bake decisions in those areas.

[Add 1–3 plan-specific principles only if load-bearing for the draft itself.]

## Phases

| Phase | Name | Description | Depends On |
|-------|------|-------------|------------|
| 0 | ... | ... | — |
| ... | ... | ... | ... |
| N-1 | Tests | Scaffold — enriched by plan-improvements Phase 8 | ... |
| N | Validation | Scaffold — end-to-end against the real built CLI + a temp SQLite datastore + the dogfood gate. Enriched by plan-improvements Phase 8 | All |

The second-to-last phase is always **Tests**. The last is always **Validation**.
(An "Architecture Docs & ADRs" phase is appended by plan-improvements Phase 9 — do
NOT pre-create it.)

## Dependency Graph

```
Phase 0 (Name)
├── Phase 1 (Name)
└── Phase 2 (Name)
      └── Phase 3 (Tests)
            └── Phase 4 (Validation)
```

Indicate which phases can run in parallel.

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | ... | ... |

## Critical Files Reference

| File | Role | Key Structures |
|------|------|----------------|
| `packages/.../file.ts` | What it does | Important exports, line numbers |

Only files directly relevant. **Verify every line number by reading the file
immediately before writing the entry.** For greenfield files use
`path/to/new-file.ts (new — Phase N)`.

## Per-Task Verification Standard

At the end of every task, run:

```bash
pnpm build && pnpm typecheck && pnpm test
```

Before the plan is complete, `pnpm lint` (ESLint + dependency-cruiser) must be
0-error. Phase-specific commands are in each phase file.
```

## Step 2 (continued): Draft `phase-N-name.md`

```markdown
# Phase N: [Name]

**Goal:** [One sentence.]
**Depends on:** [Phase numbers, or "—"]

---

## Task N.1: [Descriptive title]

**Files:** [size: XS/S/M/L]
- Create: `path/to/new-file.ts`
- Modify: `path/to/existing-file.ts`

**Context:** [What exists today. Reference specific line numbers, signatures, current behavior. Explain WHY this change is needed.]

**Steps:**
1. [Specific, unambiguous instruction with code snippets where helpful]
2. [...]

**Wiring:** [Exact data flow from entry point to this code — e.g. "registered in the tool's `commandSpecs`, mounted by `register-tools-mount.ts`; reads `cli.scope.targets`". The implementing agent should be able to trace the call path.]

**Verification:**
```bash
pnpm build && pnpm typecheck && pnpm test
```

**Commit:** `type(scope): description`

---

[More tasks...]

---

## Phase N End-to-End Verification

[What to run and check after all tasks in this phase.]
```

### Required task sections

Every task must have **Files**, **Context**, **Steps**, **Wiring**,
**Verification**, **Commit**. Other concerns (observability, persistence, error
cases, hardening) are intentionally omitted from the draft — the pipeline owns
them.

### Tests phase scaffold

```markdown
# Phase N-1: Tests

**Goal:** Cover the work in Phases 0..N-2 with unit and fixture tests.
**Depends on:** All implementation phases.

This phase is a scaffold. Specific cases, fixtures, and coverage are added by
plan-improvements Phase 8.

## Task N-1.1: Unit tests for new code

**Files:** [list of `*.test.ts` paths beside the new source]

**Context:** Vitest, `*.test.ts` next to source. Result-returning methods tested in both ok and err paths. Code reading `currentScope()` is wrapped in `runWithScope(new RunScope({...}))`.

**Steps:** Enriched by plan-improvements Phase 8.

**Verification:** `pnpm test`

## Task N-1.2: Fitness/rule or fixture-catalog tests (if applicable)

**Files:** [paths]

**Context:** New fitness checks / graph rules tested with synthetic pass+fail input via the `@opensip-cli/test-support` fixture-coverage harness (test files only — ADR-0040).

**Steps:** Enriched by plan-improvements Phase 8.

**Verification:** `pnpm test`
```

### Validation phase scaffold

```markdown
# Phase N: Validation

**Goal:** Exercise the full integrated flow against the real built CLI.
**Depends on:** All prior phases including Tests.

This phase is a scaffold. End-to-end flows are enriched by plan-improvements
Phase 8.

## Task N.1: End-to-end run against the built CLI

**Context:** Build the workspace (`pnpm build`) and run the real `opensip` binary against a fixture project with a temp/in-memory SQLite datastore. Where the feature affects analysis output, exercise the dogfood gate (`pnpm fit` / `pnpm graph --gate-save`). There is NO lab-host Postgres/OTel/Redis — do not import platform infrastructure. Validation fails loudly if a prerequisite (built `dist/`, fixture) is missing.

**Steps:** Enriched by plan-improvements Phase 8.

**Verification:** `pnpm build && pnpm test`
```

## Anti-overreach: what to leave OUT of the draft

Owned by downstream pipeline phases. Do not pre-bake — your speculation gets
overwritten.

| Concern | Owned by |
|---|---|
| opensip-cli architectural compliance (layer DAG, RunScope, documented ToolCliContext seams, Result/typed errors, host-owned baseline plane, host-owned run timing, fitness-check additions) | Phase 2 |
| Datastore plane placement (baseline/tool_state/sessions/tool-catalog), schema migrations, payload forward-compatibility, opacity boundary | Phase 3 |
| SOLID/Gang-of-Four pattern decisions, narrow-port introductions | Phase 4 |
| Package reuse audit, code-level dedup, tier placement of extracted helpers | Phase 5 |
| Opt-in OTel metrics, logger `evt` names, the session record contribution | Phase 6 |
| Input sanitization, resource bounds, secret hygiene, plugin trust/admission/provenance | Phase 7 |
| Test patterns, fixtures, RunScope wrapping, dogfood validation specifics | Phase 8 |
| docs/public + docs/web-generated updates, ADR entries, ADR↔fitness-check pairing, supersession | Phase 9 |

If a phase's draft would naturally include one of these, write a placeholder
("Hardening: deferred to plan-improvements Phase 7") and move on.

### Speculation vs. file-grounded fact — worked example

- **Keep** a name when it is *load-bearing for a file path or type you're already writing* — a concrete error class in the package, a `Rule` slug the phase ships, a `CommandSpec` name the phase registers, a new `FunctionOccurrence` field. These are the phase's structural delivery.
- **Drop** a name when it is *prescriptive guidance about how code should observe/log/persist itself* — the specific `evt` strings, the metric label set, which datastore plane, the ToolCliContext seam usage. Those are owned by Phases 2/3/6/7.

Heuristic: if removing the name leaves the phase with no concrete deliverable, keep
it. If removing it only weakens the observability/policy story, drop it.

## Task sizing

| Size | Files | Scope | Action |
|------|-------|-------|--------|
| **XS** | 1 | Single function or type | Good as-is |
| **S** | 1-2 | One module or interface | Good as-is |
| **M** | 3-5 | One feature slice across layers | Good as-is |
| **L** | 5-8 | Multi-component feature | Consider splitting |
| **XL** | 8+ | Too large | **Must split** |

Each task includes its size in the Files section. "and" in a title usually means
two tasks.

## Red flags

Catch these before chaining into plan-improvements:

- **Plan directory contains only `plan.md`** (contract violation — every phase needs its own file)
- **`plan.md` contains task-level detail** (Files / Context / Steps / Wiring / Commit — those belong in `phase-*.md`). Rule-level cross-cutting contracts are allowed post-pipeline.
- **Pre-flight commitment was skipped**
- Phase with >8 tasks (split it)
- Task that modifies >5 files (split it)
- Tasks with "and" in the title
- Line numbers referenced without reading the file
- Missing Tests phase or missing Validation phase
- Verification phase named "Verification" instead of "Validation"
- **Planning a platform-only concern** (Postgres, tenants, DBOS, tracing, audit chain, auth) — it does not exist in opensip-cli

## Step 3: Chain into plan-improvements (autonomous mode)

After writing all plan files, **immediately** execute the 9-phase pipeline against
the draft. Do not pause or stop — chain straight in.

1. Read `docs/ai-helpers/prompts/plan-improvements/plan-improvements.md` to load the 9 phase prompts.
2. Set `PLAN_PATH` to the plan directory you just created.
3. Create a TodoWrite list with one entry per phase **as listed in that file (Phase 1 through Phase 9).**
4. For the next pending phase:
   a. Re-read `<PLAN_PATH>` (it may have changed).
   b. Apply that single phase's prompt verbatim. Do not blend concerns from other phases.
   c. Write the revised plan back to `<PLAN_PATH>`.
   d. Summarize the changes in ≤200 words.
5. Repeat until all 9 phases are completed.
6. After Phase 9, run a final coherence check: each phase's "Output:" satisfied, cross-references resolve, no phase invalidated an earlier one. Report findings.

**Where pipeline outputs land:**

- **Phases 1, 4, 5, 8** edit `plan.md`'s index sections and task content in `phase-*.md`. No cross-cutting contracts.
- **Phases 3, 6, 7** write *cross-cutting policy contracts* into `plan.md`'s "Cross-cutting contracts" section (persistence & datastore, observability, hardening & trust). Per-phase compliance changes still go in the relevant `phase-*.md`.
- **Phase 2** writes an "Architectural compliance invariants" table into `plan.md`'s contracts section AND adds enforcement (e.g. fitness checks) into the relevant `phase-*.md`.
- **Phase 9** appends a NEW phase file (e.g. `phase-N-architecture-docs-and-adrs.md`).

The hard prohibition surviving both stages: no `Files / Context / Steps / Wiring /
Verification / Commit` blocks ever land in `plan.md`.

**Rules for the autonomous chain:**

- Apply exactly one phase per iteration. Do not batch or jump ahead.
- Do not modify `<PLAN_PATH>` outside the active phase's scope.
- Never introduce platform-only concepts (Postgres/tenants/DBOS/tracing/audit/auth). If a phase seems to call for one, the concern does not apply here — note it and move on.
- If a phase prompt is unclear for this plan, surface the ambiguity in the summary rather than guessing.
- Treat phase prompts as load-bearing — every "must", "never", and "Output:" line is a constraint.

The pipeline costs roughly 10× the tokens of the draft alone — expected and
intentional.
