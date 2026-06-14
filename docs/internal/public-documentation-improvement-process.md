# Public Documentation Improvement Process

**Goal**: Drive the OpenSIP CLI public documentation (`docs/public/`) to a state where it is verifiably correct against the current codebase and continuously improved for clarity, structure, flow, and reader experience.

This process follows the *exact same meta-structure and hard rules* as the Correctness Remediation Process and the other domain-specific improvement processes.

## Hard Rules (Non-Negotiable)
(Identical to previous processes)
- **Worktree Only**: All work must be performed inside a dedicated git worktree. The primary checkout remains untouched.
- **Final Summary Document**: Upon termination, create `final-summary.md` (or dated variant) in `docs/remediation/`.
- **No Direct Merge to Main**: The agent must never merge or push from the worktree. A human must review everything first.

## Core Principles
- Follow the four steps strictly.
- Prevention mechanisms are prioritized (local checks that catch doc drift and writing issues before they ship).
- Architecture-first: medium/large changes (e.g., reorganizing the top-level doc structure, introducing new documentation conventions, major updates to how public vs. implementation docs are separated) route through specs.
- Every round re-validates previously created mechanisms.
- Use Coverage Reports for focused delta work after the baseline.
- The process is iterative until zero new high-impact documentation correctness or quality issues are found and no new specs are required.

## The 4-Step Cycle

### Step 1: Discovery (Find Documentation Issues)
1. Run the existing documentation gates (`pnpm docs:check`, `pnpm docs:build`, etc.).
2. Execute a documentation-focused audit discovery process:
   - Compare `docs/public/` content against the actual source (extracted APIs, CLI surface, configuration options, architectural facts from ADRs and code, example scaffolding).
   - Search for common drift patterns: outdated code references, stale architecture descriptions, examples that no longer match current behavior or scaffolding, broken internal links to symbols or sections, claims about behavior that contradict the current implementation.
   - Review for writing/flow issues: walls of text, poor heading structure, missing cross-references, unclear audience targeting, inconsistent terminology, weak examples, missing "why" or "when to use" context.
   - Leverage the existing `scripts/build-web-docs.mjs`, `pnpm docs:build`, and the Diátaxis-inspired organization (`00-start/`, `10-concepts/`, `20-fit/`, …) as a baseline for structure review.
3. **Mandatory re-validation**: Re-execute all previously created mechanisms (local doc-drift checks, writing-quality checks, example validators, etc.).
4. Produce:
   - List of documentation correctness and quality issues/opportunities (with file references in `docs/public/` and corresponding source locations).
   - Detailed **Coverage Report** (what parts of the public docs, which subsystems, and which writing-quality dimensions were reviewed; what was not covered this round).

**Baseline vs. Delta vs. Final Deep Pass**:
- Round 001 = baseline (broad review of all major public sections against the current codebase).
- Subsequent rounds = delta-informed using prior Coverage Reports (focus on previously uncovered sections + docs that changed or whose underlying code changed since last round).
- When close to termination, run one heavy final deep pass.

### Step 2: Create Prevention Mechanisms
For each finding or cluster:
- Create project-local mechanisms only (in `opensip-cli/fit/checks/docs/` or similar local areas — never added to the shipped check packs).
  - Examples: local fit checks that run on changed public docs inside the worktree ("no reference to a symbol or CLI flag that no longer exists", "examples must match current scaffolding or pass a validation script", "no direct source links without version pinning or 'as of' note", "sections over X words must have a clear audience or 'when to use' heading").
  - Local validators or scripts that compare extracted public API/CLI surface against documented surfaces.
  - Simple writing-flow heuristics turned into checks (e.g., "no heading deeper than level 3 without a preceding overview", "no paragraph longer than 120 words without a subheading").
- Re-validate that the mechanism would catch the issue on the current state.

**Architectural cases**:
- If proper improvement requires medium/large architectural work (reorganizing the top-level doc taxonomy, introducing a new documentation platform convention, major changes to the public vs. implementation doc boundary, new cross-tool documentation standards), create a spec (typically under `docs/plans/specs/`).
- Pending specs do not stop the loop.

### Step 3: Resolve / Implement Improvements
- Small/medium improvements: update the public docs directly (full `pnpm docs:check && pnpm docs:build` gates inside the worktree). Include notes on improved correctness or flow.
- Medium/large architectural documentation changes: create a spec for human review. Avoid piecemeal edits that contradict the intended long-term structure.

### Step 4: Repeat
Return to Step 1.

## Termination Condition
The process is complete only when a full cycle (ideally the heavy final deep pass) finds:
- Zero new high-impact documentation correctness or quality issues, **and**
- No new architecture specs are required to properly address any class of documentation problem.

Pending specs from earlier rounds must be resolved before final termination.

**Upon termination**:
- Create the final summary document in `docs/remediation/`.
- Do not merge or push any worktree changes. A human must review everything before any integration.

## Artifacts and Recording
- **Process definition** (this file): `docs/internal/public-documentation-improvement-process.md` (committed).
- **Per-round records and final summary**: written to `docs/remediation/` (gitignored — ephemeral, only inside the worktree).
  - Each record must include: date, findings list (with links to `docs/public/` files and source locations), Coverage Report, mechanisms created (local only), specs created, doc updates made, open items.
- All artifacts are created from within the remediation worktree.

## Invocation
To run this process, reference this document directly:
> "Run the Public Documentation Improvement Process (see docs/internal/public-documentation-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using the previous remediation records for delta guidance."

The agent performing the process is expected to:
- Follow the 4 steps exactly.
- Perform **all** work inside the dedicated remediation worktree (primary checkout must stay clean).
- Produce the required Coverage Report each round.
- Write a complete record to `docs/remediation/`.
- Re-run all created mechanisms every round.
- Only create project-local mechanisms (never add new shipped doc checks without human review via spec).
- Upon termination, create the final summary document in `docs/remediation/`.
- Never merge or push changes from the worktree to main (or any shared branch). Human review is required.

### Worktree Setup (Typical)
A common pattern at the start of the process:
```bash
git worktree add ../docs-remediation-$(date +%Y%m%d) -b public-documentation-improvement
cd ../docs-remediation-$(date +%Y%m%d)
# All subsequent commands (discovery, doc edits, mechanism creation, record writing, `pnpm docs:check`, etc.) happen here.
# The original repo checkout remains completely untouched.
```

## Notes on Evolution and Adaptation
This is a direct adaptation of the original Correctness Remediation Process (and the Performance Improvement Process) for the public documentation domain.

It heavily leverages:
- The existing `docs:build` / `docs:check` scripts and `scripts/build-web-docs.mjs`.
- The committed Diátaxis-inspired structure in `docs/public/`.
- The rule that `docs/web-generated/` must never be hand-edited.
- The distinction between public reader-facing docs and implementation/ADR material.

Key domain differences:
- "Issues" are both factual incorrectness (drift from code) and quality problems (poor writing, structure, flow, audience fit).
- Mechanisms are often local doc-linting rules or validation scripts rather than (or in addition to) runtime checks.
- Architectural work frequently involves the overall documentation taxonomy, the public vs. internal boundary, or new conventions for examples and cross-linking.

Review and evolve this document after each major cycle (especially after the first full baseline and after the final deep pass).

Initial baseline round should be recorded as `public-docs-round-001-baseline.md` (inside the worktree's `docs/remediation/`).

---
*Adapted from the collaborative definition of the correctness and performance processes (2026-06).*