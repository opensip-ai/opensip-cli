# Maintainability & Structural Quality Improvement Process

**Goal**: Drive the OpenSIP CLI codebase to a state with no new high-impact maintainability or structural quality issues, and to systematically improve coupling, duplication, module boundaries, complexity, and ownership so that the project remains easy to understand, extend, and evolve.

This process follows the *exact same meta-structure and hard rules* as the Correctness Remediation Process and the Performance Improvement Process.

## Hard Rules (Non-Negotiable)
(Identical to previous processes)
- **Worktree Only**: All work must be performed inside a dedicated git worktree. The primary checkout remains untouched.
- **Final Summary Document**: Upon termination, create `final-summary.md` (or dated variant) in `docs/remediation/`.
- **No Direct Merge to Main**: The agent must never merge or push from the worktree. A human must review everything first.

## Core Principles
- Follow the four steps strictly.
- Prevention mechanisms are prioritized (local checks for structural rules).
- Architecture-first: medium/large changes (e.g., refactoring module boundaries, introducing new ownership contracts, major graph-based quality gates) route through specs.
- Every round re-validates previously created mechanisms.
- Use Coverage Reports for focused delta work after the baseline.
- The process is iterative until zero new high-impact maintainability issues are found and no new specs are required.

## The 4-Step Cycle

### Step 1: Discovery (Find Maintainability & Structural Issues)
1. Run full CI gates (typecheck, lint, fit:ci, graph:ci, depcruise, etc.).
2. Execute a maintainability-focused audit discovery process:
   - Systematic search for high coupling (using graph insights), duplicated utility functions or logic, overly broad modules, missing clear ownership, high complexity in core paths, violations of layering (beyond what depcruise already catches), "god objects", poor separation of concerns, and code that is hard to reason about or extend.
   - Leverage the graph tool (for coupling, blast radius, duplication detection), depcruise for layering, fitness checks for duplication and complexity, knip for dead code, and manual review of module boundaries, public APIs, and hot paths (parsers, graph, fitness, cli bootstrap).
   - Review for structural problems that make future changes risky or expensive.
3. **Mandatory re-validation**: Re-execute all previously created mechanisms (local structural quality checks, etc.).
4. Produce:
   - List of maintainability and structural quality issues and opportunities (with file references and coupling/ownership notes).
   - Detailed **Coverage Report** (what modules, boundaries, and complexity hotspots were exercised; what was not covered this round).

**Baseline vs. Delta vs. Final Deep Pass**:
- Round 001 = baseline (broad discovery).
- Subsequent = delta-informed using prior Coverage Reports.
- Final = one heavy deep pass.

### Step 2: Create Prevention Mechanisms
For each finding or cluster:
- Create project-local mechanisms only (in `opensip-cli/fit/checks/` or local areas — never shipped).
  - Examples: local fit checks that run on changed packages inside the worktree ("no new high coupling without justification", "no duplicated utility logic — extract or reference existing", "module complexity must stay below threshold in core paths", "new code must respect documented ownership boundaries").
  - Local extensions to graph-based or depcruise rules for the worktree run.
  - Test harnesses that assert structural properties.
- Re-validate that the mechanism would catch the issue.

**Architectural cases**:
- If proper improvement requires medium/large architectural work (refactoring major module boundaries, introducing new ownership or layering contracts, major changes to how the graph tool is used for quality, etc.), create a spec.
- Pending specs do not stop the loop.

### Step 3: Resolve / Implement Improvements
- Small/medium: implement directly (full gates). Include notes on improved maintainability.
- Medium/large: create spec for human review. Avoid band-aids.

### Step 4: Repeat
Return to Step 1.

## Termination Condition
Same as previous processes: zero new high-impact issues in a full cycle + no new specs required.

**Upon termination**:
- Create final summary in `docs/remediation/`.
- Human review required before any merge.

## Artifacts and Recording
- Process definition: `docs/internal/maintainability-structural-quality-improvement-process.md` (committed).
- Per-round records and final summary: `docs/remediation/` (gitignored — ephemeral, worktree-only).
  - Records must include date, findings, Coverage Report, mechanisms (local only), specs, improvements, open items.
- All created from within the worktree.

## Invocation
To run: "Run the Maintainability & Structural Quality Improvement Process (see docs/internal/maintainability-structural-quality-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using prior Coverage Reports for delta guidance."

The agent must follow the rules exactly as in the performance and correctness processes.

**Inter-cycle Merge Gate**: When running the family of improvement processes in the agreed order, the code changes from one domain (new local mechanisms + any direct fixes) must be merged to main by a human before the agent creates a worktree for the next domain. See the central note in `improvement-processes.md` ("Inter-cycle Merge Gate") for the rationale: it guarantees that each new cycle starts with an up-to-date baseline and the full accumulated set of prevention mechanisms for re-validation.

### Worktree Setup (Typical)
```bash
git worktree add ../maintainability-remediation-$(date +%Y%m%d) -b maintainability-structural-quality-improvement
cd ../maintainability-remediation-$(date +%Y%m%d)
# All work here.
```

## Notes on Evolution and Adaptation
Direct adaptation of the correctness and performance processes.

Leverages heavily:
- The graph tool (for coupling, duplication, blast radius).
- depcruise for layering and architecture rules.
- Existing fitness checks for duplication and complexity.
- knip for dead code and orphans.

Key differences:
- "Issues" are structural and maintainability problems (coupling, duplication, unclear boundaries, complexity) rather than runtime defects.
- Mechanisms focus on enforcement of structural quality rules for new or changed code.
- Architectural work frequently involves the graph tool, depcruise configuration, or module ownership contracts.

Review after baseline and final deep pass.

Initial baseline: `maintainability-round-001-baseline.md` (in worktree).

---
*Adapted from the collaborative correctness and performance processes (2026-06).*