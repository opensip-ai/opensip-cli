# Correctness Remediation Process

**Goal**: Drive the OpenSIP CLI codebase to a state where systematic, repeatable searches find no bugs or correctness issues.

This is the canonical, internal definition of the repeatable process. It can be invoked by referencing this document (e.g., "Run the Correctness Remediation Process").

## Hard Rules (Non-Negotiable)
These rules are absolute. There are no exceptions.

- **Worktree Only**: All work (discovery, analysis, creating mechanisms, writing specs, fixing issues, committing changes, etc.) **must** be performed inside a dedicated git worktree. Never modify the primary working tree directly. This ensures the main checkout remains clean and untouched throughout the process.
- **Final Summary Document**: Upon reaching the termination condition, the agent **must** create a final summary document in `docs/remediation/` (e.g. `final-summary.md` or `remediation-complete-YYYY-MM-DD.md`). This document summarizes the entire effort.
- **No Direct Merge to Main**: The agent must never merge, push, or integrate changes from the worktree into the main branch (or any shared branch). All results remain isolated in the worktree. A human must review the worktree state, all remediation records, the final summary, and any outstanding specs before any integration occurs.

## Core Principles
- Follow the four steps strictly.
- Prevention (mechanisms) is prioritized over pure remediation.
- Architecture-first: no band-aids. Medium/large architectural changes are routed through specs for human review rather than rushed fixes.
- Every round must re-validate previously created mechanisms.
- Record-keeping is mandatory for repeatability and delta decisions.
- The process is iterative. We stop only when both conditions in the termination rule are met.

## The 4-Step Cycle

**All activity in every step must occur inside the dedicated remediation worktree** (see Hard Rules above). The primary checkout must remain unmodified.

### Step 1: Discovery (Find Issues)
1. Run the full set of CI gates:
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm lint`
   - `pnpm fit:ci`
   - `pnpm graph:ci`
   - Any other configured gates in the project.

2. Execute the correctness/bug audit discovery process (initially the detailed audit prompt from the 2026-06 session; over time guided by accumulated remediation records and the living set of bug classes).

3. **Mandatory in every round (lightweight or heavy)**:
   - Re-execute and validate all mechanisms created in prior rounds. This includes:
     - Running any new tests added for prevention.
     - Running any new **project-local** fit checks (see Step 2).

4. Produce two outputs:
   - A clear list of all findings (bugs or correctness issues).
   - A **Coverage Report** that explicitly states:
     - What areas, modules, subsystems, bug classes, and code paths were actively reviewed this round.
     - What mechanisms were re-run.
     - What was **not** covered this round (with rationale). This is critical for determining future delta scope.

5. Record the complete results (findings + Coverage Report + any notes on gates/mechanisms) in a new file under `docs/remediation/`.

**Lightweight / Delta Rounds vs. Final Deep Pass**:
- Early and middle rounds use a lightweight, delta-informed approach. The scope is determined by previous round remediation records (focus on areas previously marked as not covered + recent changes that could impact correctness).
- The very first round (001) establishes the baseline with reasonably broad discovery.
- When the team believes the loop is nearing completion, execute a heavy deep review pass. This pass uses all prior remediation logs and Coverage Reports to ensure previously under-covered areas receive thorough attention.

### Step 2: Create Prevention Mechanisms
For each finding (or logical cluster of related findings):
- Determine whether a test or a **project-local fit check** could have caught the issue (or made the class of defect much harder to introduce).
  - New fit checks **must** be placed in the project-local location (`opensip-cli/fit/checks/`). They are never added to the published `@opensip-cli/checks-*` packages.
- If a suitable mechanism exists or can be created, implement it.
- Re-evaluate whether the mechanism actually fires on the bad case (and ideally on similar cases).

**Architectural cases**:
- If the *correct long-term fix* requires a medium or large architectural change (changes to core invariants, contracts, layering, RunScope model, host planes, etc.), do **not** implement a rushed band-aid.
- Instead, create a spec (typically under `docs/plans/specs/`) describing the proper architectural solution.
- The existence of such a pending spec counts as an "open item" for the termination condition (see below). Creating the spec does **not** stop the overall loop.

All mechanisms created in this step must be exercised as part of Step 1 in the *next* round.

### Step 3: Resolve / Fix Issues
- For findings whose proper correction is small or medium: implement the fix following all project rules.
  - Architecture first (no band-aids).
  - Full gates before any commit: `pnpm typecheck && pnpm test && pnpm lint`.
- For findings whose correct fix is blocked behind a medium/large architectural change (see Step 2):
  - Create the spec.
  - Do not apply superficial patches that contradict the intended long-term direction.
  - Document the current exposure in the round record.

### Step 4: Repeat
Return to Step 1 with the updated remediation record and Coverage Report from the just-completed round.

## Termination Condition
The process is complete only when a cycle completes with **both** of the following:
- Zero new findings from the discovery step.
- No new architecture specs need to be created to properly address any class of issue.

Pending specs created in earlier rounds must be resolved (implemented, descoped with justification, or otherwise closed) before the process can be declared complete. The final cycle should be a heavy deep pass that leverages all prior records.

**Upon termination**:
- Create the final summary document in `docs/remediation/` (see Hard Rules).
- Do not merge or push any worktree changes. A human must review everything before any integration.

## Artifacts and Recording
- **Process definition** (this file): `docs/internal/correctness-remediation-process.md` — this is committed and part of the repository.
- **Per-round records and final summary**: These are written to `docs/remediation/` (e.g. `round-001-baseline.md`, `final-summary.md`).
  - Each record contains: date, findings, Coverage Report (what was reviewed and what was explicitly not covered), mechanisms created, specs created, fixes applied, and open items.
  - The final summary provides an overall retrospective of the entire remediation effort.
- **Important**: The `docs/remediation/` directory is listed in `.gitignore`. These records are **ephemeral / local artifacts** created inside the remediation worktree. They are never committed to the main repository. They exist only to support the current run and to allow the agent (or a human) to maintain state and delta focus across rounds within that worktree.

All records are created from within the remediation worktree. After the process completes (or is paused), the human reviewer can inspect the worktree's `docs/remediation/` contents before deciding whether to preserve any of the summary information outside the repo (e.g. in an issue or private note).

## Invocation
To run this process, reference this document directly:
> "Run the Correctness Remediation Process (see docs/internal/correctness-remediation-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using the previous remediation records for delta guidance."

The agent performing the process is expected to:
- Follow the 4 steps exactly.
- Perform **all** work inside the dedicated remediation worktree (primary checkout must stay clean).
- Produce the required Coverage Report each round.
- Write a complete record to `docs/remediation/`.
- Re-run all created mechanisms every round.
- Only create project-local fit checks when adding prevention mechanisms.
- Upon termination, create the final summary document in `docs/remediation/`.
- Never merge or push changes from the worktree to main (or any shared branch). Human review is required.

**Inter-cycle Merge Gate**: When running the family of improvement processes in the agreed order, the code changes from one domain (new local mechanisms + any direct fixes) must be merged to main by a human before the agent creates a worktree for the next domain. See the central note in `improvement-processes.md` ("Inter-cycle Merge Gate") for the rationale: it guarantees that each new cycle starts with an up-to-date baseline and the full accumulated set of prevention mechanisms for re-validation.

### Worktree Setup (Typical)
A common pattern at the start of the process:
```bash
git worktree add ../remediation-$(date +%Y%m%d) -b correctness-remediation
cd ../remediation-$(date +%Y%m%d)
# All subsequent commands (discovery, edits, git commit, etc.) happen here.
# The original repo checkout remains completely untouched.
```

## Notes on Evolution
This process is intended to be adjusted as we gain experience. After each major cycle (especially after the first full baseline and after the final deep pass), review this document and the accumulated remediation records to identify improvements.

Initial baseline round should be recorded as `round-001-baseline.md`.

---

*Document created 2026-06-13 based on collaborative definition in the 2026-06 correctness audit session.*