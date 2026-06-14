# Testability & Test Health Improvement Process

**Goal**: Drive the OpenSIP CLI codebase to a state with no new high-impact testability or test health issues, and to systematically improve test coverage of seams, fixture quality, and prevention of untested regressions so that the project remains well-tested and maintainable.

This process follows the *exact same meta-structure and hard rules* as the Correctness Remediation Process and the Performance Improvement Process.

## Hard Rules (Non-Negotiable)
(Identical to previous processes)
- **Worktree Only**: All work must be performed inside a dedicated git worktree. The primary checkout remains untouched.
- **Final Summary Document**: Upon termination, create `final-summary.md` (or dated variant) in `docs/remediation/`.
- **No Direct Merge to Main**: The agent must never merge or push from the worktree. A human must review everything first.

## Core Principles
- Follow the four steps strictly.
- Prevention mechanisms are prioritized (local checks enforcing test requirements for new code).
- Architecture-first: medium/large changes (e.g., enhancements to the test-support package, new harnesses for concurrency or error paths, changes to how fixtures are managed) route through specs.
- Every round re-validates previously created mechanisms.
- Use Coverage Reports for focused delta work after the baseline.
- The process is iterative until zero new high-impact testability issues are found and no new specs are required.

## The 4-Step Cycle

### Step 1: Discovery (Find Testability & Test Health Issues)
1. Run full CI gates (typecheck, lint, fit:ci, graph:ci, test, etc.).
2. Execute a testability-focused audit discovery process:
   - Systematic search for missing tests on public seams, untested error/fault paths, fixture coverage gaps, tests that rely on implementation details instead of contracts, missing tests for new code or architectural changes, poor test isolation, lack of coverage for concurrency, serialization, or plugin loading paths.
   - Leverage the test-support package (ADR-0040), existing fixture harnesses, coverage reports, knip for dead test code, and manual review of public APIs, core contracts, and hot paths (parsers, graph, fitness, plugin system).
   - Review for "tests that would have caught this" in recent changes or known issues.
3. **Mandatory re-validation**: Re-execute all previously created mechanisms (local test-enforcement checks, etc.).
4. Produce:
   - List of testability and test health issues and opportunities (with file references and seam coverage notes).
   - Detailed **Coverage Report** (what seams, paths, and test categories were exercised; what was not covered this round).

**Baseline vs. Delta vs. Final Deep Pass**:
- Round 001 = baseline (broad discovery).
- Subsequent = delta-informed using prior Coverage Reports.
- Final = one heavy deep pass.

### Step 2: Create Prevention Mechanisms
For each finding or cluster:
- Create project-local mechanisms only (in `opensip-cli/fit/checks/` or local test areas — never shipped).
  - Examples: local fit checks that run on changed packages inside the worktree ("every new public API surface or contract must have corresponding test coverage", "no new untested error paths in core", "all new plugin or authored-tool code must include local test fixtures").
  - Local extensions to the test-support harness.
  - Test that assert fixture coverage or seam test presence.
- Re-validate that the mechanism would catch the gap.

**Architectural cases**:
- If proper improvement requires medium/large architectural work (enhancements to test-support, new harnesses for specific domains like concurrency or serialization, changes to how the monorepo runs tests), create a spec.
- Pending specs do not stop the loop.

### Step 3: Resolve / Implement Improvements
- Small/medium: implement directly (full gates, including running new or affected tests). Include notes on improved testability.
- Medium/large: create spec for human review. Avoid band-aids.

### Step 4: Repeat
Return to Step 1.

## Termination Condition
Same as previous processes: zero new high-impact issues in a full cycle + no new specs required.

**Upon termination**:
- Create final summary in `docs/remediation/`.
- Human review required before any merge.

## Artifacts and Recording
- Process definition: `docs/internal/testability-test-health-improvement-process.md` (committed).
- Per-round records and final summary: `docs/remediation/` (gitignored — ephemeral, worktree-only).
  - Records must include date, findings, Coverage Report, mechanisms (local only), specs, improvements, open items.
- All created from within the worktree.

## Invocation
To run: "Run the Testability & Test Health Improvement Process (see docs/internal/testability-test-health-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using prior Coverage Reports for delta guidance."

The agent must follow the rules exactly as in the performance and correctness processes.

### Worktree Setup (Typical)
```bash
git worktree add ../testability-remediation-$(date +%Y%m%d) -b testability-test-health-improvement
cd ../testability-remediation-$(date +%Y%m%d)
# All work here.
```

## Notes on Evolution and Adaptation
Direct adaptation of the correctness and performance processes.

Leverages heavily:
- The test-support package (ADR-0040) and its harnesses (RunScope test sugar, fixture coverage, with-scope, etc.).
- Existing fitness checks that already target test quality and dead code.
- The monorepo's test and coverage infrastructure.

Key differences:
- "Issues" are testability and coverage gaps rather than runtime defects.
- Mechanisms focus on enforcement of test requirements for new or changed code.
- Architectural work frequently involves the test-support package and how tests are organized across the monorepo.

Review after baseline and final deep pass.

Initial baseline: `testability-round-001-baseline.md` (in worktree).

---
*Adapted from the collaborative correctness and performance processes (2026-06).*