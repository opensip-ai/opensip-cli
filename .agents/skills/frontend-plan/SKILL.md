---
name: frontend-plan
description: >
  Create UI implementation plans for opensip-cli's two presentation surfaces in docs/plans/: the Ink/React
  terminal UI (the @opensip-cli/cli-ui kit + tool "live view" CommandSpecs) and the self-contained HTML report
  generator (@opensip-cli/dashboard, assembled by the `report` command). Use this skill when the user asks to plan
  terminal-UI work — a live run view, a Banner/Spinner/RunHeader change, theme/colour work, TTY/no-colour handling
  — or HTML report changes. Trigger on "create a plan", "plan this out", "frontend plan", "UI plan", "report plan",
  or "live view" when the work involves cli-ui or the dashboard report. Do NOT use this for backend tools, the
  graph engine, fitness checks, or services — use backend-plan instead. This is the opensip-cli UI skill; for the
  opensip platform's React web dashboard use that repo's frontend-plan.
---

# Frontend Plan Skill (opensip-cli)

You are creating a UI implementation plan for **opensip-cli's presentation
surfaces**. opensip-cli has **no React web dashboard, no browser, no TanStack
Query, no routing**. Its "frontend" is two things:

1. **The Ink terminal UI** — `@opensip-cli/cli-ui` (Ink = React for terminals):
   shared primitives (`Banner`, `Spinner`, `RunHeader`, theme). Tools that ship a
   live run view declare a `CommandSpec` with `output: 'live-view'` and depend on
   `cli-ui` (without pulling in the dispatcher).
2. **The HTML report** — `@opensip-cli/dashboard` (`generateDashboardHtml`), a
   **self-contained static HTML file** assembled by the CLI-owned `report` command
   (the composition root) from each tool's `collectReportData` contribution.

Plan to those two surfaces only. Plans live in `docs/plans/` as a directory with a
top-level `plan.md` and separate `phase-N-name.md` files. (`docs/plans/` is
gitignored scratch — see `docs/plans/README.md`.)

## Your workflow

1. **Surface assumptions** — Before reading code, state what you assume about which surface (Ink live view vs. HTML report), scope, and existing-component reuse. Get confirmation.
2. **Research** — Read the existing cli-ui primitives / report generator to learn current patterns. Real file paths, component names, theme tokens. Do not guess.
3. **Draft the plan** — Write `plan.md` and all phase files following the format below.
4. **Refine: Pass 1 (Accuracy & Structure)** — Reread for accuracy, dependency ordering, implementation-readiness, component/utility reuse, testing coverage, and no backwards-compat hacks.
5. **Refine: Pass 2 (Terminal rendering, Theme, Output-seam integration)** — Reread and verify TTY/no-colour/quiet/`--json` handling, theme compliance, and integration through the documented output seams.

Do all five steps in sequence.

## Step 0: Surface assumptions

Before reading a single file, state your assumptions:

```
ASSUMPTIONS I'M MAKING:
1. [surface — Ink live view (cli-ui) OR the HTML report (dashboard), or both]
2. [existing primitives — which cli-ui components / report sections can be reused vs need new ones]
3. [data — does the tool already contribute the needed data (SignalEnvelope / collectReportData), or is backend work needed first?]
4. [scope — which command(s) / which report section(s) are affected]
-> Correct me now or I'll proceed with these.
```

Do not silently fill in ambiguous requirements. The most common failure is
building a primitive that already exists in `cli-ui`, or planning a live view when
the data isn't in the envelope yet (a backend-plan dependency).

## Before you write anything

Read 1-2 existing plans for the structural format (`docs/plans/ready/*/plan.md`),
and `docs/plans/README.md` + `AGENTS.md` (layer DAG, the documented
`ToolCliContext` seams, RunScope). Then research the surface you're touching:

- **Ink live view:** read `@opensip-cli/cli-ui` (`packages/cli-ui/src/`) — the existing primitives (`Banner`, `Spinner`, `RunHeader`) and the theme. Read an existing tool that ships a live view (`output: 'live-view'`) to see how it renders via the `render` seam.
- **HTML report:** read `@opensip-cli/dashboard` (`packages/dashboard/src/`) — `generateDashboardHtml` and its section structure — and the CLI-owned `report` command (the composition root) plus a tool's `collectReportData` contribution.

## Plan format: `plan.md`

```markdown
# [Feature Name] Plan

[1-2 sentence summary.]

## Problem

[What's wrong or missing in the terminal UI / report today. Reference real components/sections.]

## Target State

[What the UI looks like after. For a live view: an ASCII sketch of the terminal layout. For the report: the section/layout change.]

## Design Principles

**No backwards compatibility.** Replace the old UI entirely. No compat shims.

**Terminal rendering discipline (Ink surfaces).** The UI degrades correctly: honour non-TTY (no interactive live view — fall back to plain/`--json`), `NO_COLOR` / no-colour, `--quiet`, and `--json` (machine output must never be polluted by UI chrome). Run output flows through the documented `ToolCliContext` seams (`render` for the live view); never `console.log` / direct `process.stdout` for run data.

**Theme compliance.** Colours/styles come from the `@opensip-cli/cli-ui` theme, not hardcoded ANSI codes. State which theme tokens are used and whether new ones are needed.

**Output-seam & data integration.** State the data source: a `SignalEnvelope` / `CommandResult` for live views, or a `collectReportData` contribution for the report. If the needed data isn't produced yet, flag it as a backend-plan dependency rather than inventing it in the UI.

**Conventions.** [State which apply:
- Layering: `cli-ui` is a shared kit below `cli`; tools depend on `cli-ui` but never on `cli`. `dashboard` is consumed only by the `report` composition root. No upward edges (dependency-cruiser enforces).
- Live view is a `CommandSpec` with `output: 'live-view'`; it reads per-run state from `cli.scope` / `runSession.timing` (read-only), never owns session timing.
- The HTML report is self-contained (no external asset fetches at view time).]

## Phases

| Phase | Name | Description | Depends On |
|-------|------|-------------|------------|
| 0 | ... | ... | — |
| ... | ... | ... | ... |
| N-1 | Tests | ... | ... |
| N | Validation | End-to-end against the real built CLI (render the live view / generate the report) | All |

The second-to-last phase is always **Tests**; the last is always **Validation**.

## Dependency Graph

[ASCII tree of phase dependencies; mark parallelizable phases.]

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|

## Component / Section Hierarchy

[For an Ink live view, show the component tree; for the report, the section tree. Mark new vs reused.]
```
RunView
├── RunHeader (reuse — cli-ui)
├── Spinner (reuse — cli-ui)
└── FindingsList (new — in the tool's live-view module)
```

## Critical Files Reference

| File | Role |
|------|------|
| `packages/cli-ui/src/...` | Ink primitive — reuse/extend here |
| `packages/dashboard/src/...` | `generateDashboardHtml` — report sections here |

## Per-Task Verification Standard

```bash
pnpm build && pnpm typecheck && pnpm test
```

`pnpm lint` (ESLint + dependency-cruiser) must be 0-error before completion.
```

## Plan format: `phase-N-name.md`

```markdown
# Phase N: [Name]

**Goal:** [One sentence.]
**Depends on:** [Phase numbers, or "—"]

---

## Task N.1: [Descriptive title]

**Files:** [size: XS/S/M/L]
- Create: `packages/.../component.tsx`
- Modify: `packages/cli-ui/src/...`

**Context:** [What exists today. Reference existing cli-ui primitives, report sections, theme tokens.]

**Steps:**
1. [Specific instructions]
2. [...]

**Terminal rendering / report output:** [For Ink: TTY/no-colour/quiet/`--json` behaviour and which `ToolCliContext` seam carries it. For the report: which `generateDashboardHtml` section and how the tool's `collectReportData` feeds it. If not applicable, explain why.]

**Theme integration:** [Which cli-ui theme tokens does this use? New tokens needed? Any hardcoded ANSI/styles to avoid? If not applicable, explain why.]

**Data integration:** [Which envelope/`collectReportData` field does this render? Is it already produced (cite where) or is it a backend-plan dependency? What does the empty/no-data state look like?]

**Verification:**
```bash
pnpm build && pnpm typecheck && pnpm test
```

**Commit:** `type(scope): description`

---

## Phase N End-to-End Verification

[For a live view: run the real command and describe what to see in the terminal (and the non-TTY/`--json` fallback). For the report: generate it via `opensip report` and check the section renders.]
```

## Task-level requirements

Every task must have **Terminal rendering / report output**, **Theme
integration**, and **Data integration** sections. If one doesn't apply, include it
with an explanation.

### Terminal rendering requirements (Ink surfaces)

- Non-TTY → no interactive live view; fall back to plain output or `--json`.
- `NO_COLOR` / no-colour env honoured; never emit raw ANSI when colour is off.
- `--quiet` suppresses chrome; `--json` emits machine output only — UI chrome must never contaminate the JSON stream.
- Run output goes through the `render` seam; never `console.log` / `process.stdout` for run data (enforced by ESLint + the `only-documented-toolcli-seams` fitness check).

### Theme integration requirements

- Colours/styles come from the `@opensip-cli/cli-ui` theme, never hardcoded ANSI.
- A new status/category needs a theme token in cli-ui, not an inline colour.

### Data integration requirements

- Live views render a `SignalEnvelope` / `CommandResult`; report sections render a `collectReportData` contribution.
- The UI never invents data the tool doesn't produce — if a field is missing, that's a backend-plan dependency to flag, not to fill in the UI layer.

### Test patterns reference

The Tests phase must use Vitest with colocated `*.test.ts(x)` files; reference an
existing cli-ui / dashboard test as a template; test that components render without
crashing and that no-colour/non-TTY/empty-data branches behave; for the report,
assert the generated HTML contains the expected section.

## Task sizing

| Size | Files | Scope | Action |
|------|-------|-------|--------|
| **XS** | 1 | One theme token or type | Good as-is |
| **S** | 1-2 | One Ink component / report section | Good as-is |
| **M** | 3-5 | A live view with sub-components + theme | Good as-is |
| **L** | 5-8 | Multi-surface feature | Consider splitting |
| **XL** | 8+ | Too large | **Must split** |

Each task includes its size in the Files section. "and" in a title usually means
two tasks.

## Red Flags

- Creating an Ink primitive that already exists in `@opensip-cli/cli-ui`
- Hardcoded ANSI colours instead of cli-ui theme tokens
- A live view that doesn't handle non-TTY / `NO_COLOR` / `--quiet` / `--json`
- UI chrome leaking into the `--json` machine stream
- `console.log` / direct `process.stdout` for run output (use the `render` seam)
- A tool live view importing from `cli`, or `dashboard` imported anywhere but the `report` composition root (layer-DAG violation)
- Rendering data the tool doesn't actually produce (missing backend-plan dependency)
- Task that modifies >5 files
- Verification phase named "Verification" instead of "Validation"

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "We'll handle no-TTY/--json later" | Terminal degradation is architecture, not polish. A live view that corrupts `--json` is broken for agents and CI from day one. |
| "This component is too small to test" | If it renders envelope data, it needs a render test plus a no-data/no-colour branch test. |
| "I'll just hardcode the colour" | A hardcoded ANSI code bypasses the theme and breaks `NO_COLOR`. Use a cli-ui token. |
| "The report can fetch that at view time" | The HTML report is self-contained. No external fetches — feed it via `collectReportData`. |
| "I'll add the field in the UI" | If the tool doesn't produce it, that's a backend-plan dependency. The UI renders data; it does not invent it. |

## Refinement Pass 1: Accuracy & Structure

After drafting, verify:

1. **Primitive reuse** — Are you creating Ink components that already exist in `@opensip-cli/cli-ui` (`Banner`, `Spinner`, `RunHeader`)? Check before creating new ones.
2. **Section/utility reuse** — For the report, does the section/helper already exist in `@opensip-cli/dashboard`?
3. **Dependency ordering** — Can phases execute in sequence? Is any data a backend-plan prerequisite?
4. **Testing** — Dedicated tests phase with colocated test files?
5. **No backwards compat** — Old UI replaced entirely?
6. **Layering** — `cli-ui` never imports `cli`; `dashboard` consumed only by the `report` composition root.

## Refinement Pass 2: Terminal rendering, Theme, Output-seam integration

Reread and verify:

1. **Terminal rendering** — Every Ink surface handles non-TTY, `NO_COLOR`, `--quiet`, and `--json`? Run output flows through `render`, never `console.log`?
2. **Theme compliance** — All colours from cli-ui theme tokens? No hardcoded ANSI? New tokens added where needed?
3. **Output-seam & data integration** — Live views read a `SignalEnvelope`/`CommandResult`; report sections read a `collectReportData` contribution? Missing data flagged as a backend-plan dependency, not invented?
4. **Empty/error states** — What renders when there's no data or the run failed?
