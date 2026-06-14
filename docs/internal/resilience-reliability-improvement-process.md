# Resilience & Reliability Improvement Process

**Goal**: Drive the OpenSIP CLI codebase to a state with no new high-impact resilience or reliability issues, and to systematically capture and implement meaningful improvements in error handling, fault tolerance, graceful degradation, and recovery.

This process follows the *exact same meta-structure and hard rules* as the Correctness Remediation Process and the Performance Improvement Process.

## Hard Rules (Non-Negotiable)
(Identical to previous processes)
- **Worktree Only**: All work must be performed inside a dedicated git worktree. The primary checkout remains untouched.
- **Final Summary Document**: Upon termination, create `final-summary.md` (or dated variant) in `docs/remediation/`.
- **No Direct Merge to Main**: The agent must never merge or push from the worktree. A human must review everything first.

## Core Principles
- Follow the four steps strictly.
- Prevention mechanisms are prioritized.
- Architecture-first: medium/large changes (e.g., new fault models, cross-tool recovery contracts, enhanced simulation for chaos) route through specs.
- Every round re-validates previously created mechanisms.
- Use Coverage Reports for focused delta work after the baseline.
- The process is iterative until zero new high-impact issues are found and no new specs are required.

## The 4-Step Cycle

### Step 1: Discovery (Find Resilience & Reliability Issues)
1. Run full CI gates (typecheck, lint, fit:ci, graph:ci, etc.).
2. Execute a resilience-focused audit discovery process:
   - Systematic search for missing error handling, unhandled promises, blocking calls in async contexts, insufficient timeouts/abort signals, lack of graceful degradation, swallowed critical errors without recovery, missing retries with proper backoff, inadequate cleanup in finally/ on abort, poor circuit-breaker or bulkhead patterns, insufficient observability of failure modes.
   - Leverage existing resilience checks in `checks-universal`, the simulation engine's fault model (ADR-0018), graph for blast-radius analysis, and manual review of hot paths (parsers, graph build, fitness execution, plugin loading, datastore access).
   - Run simulation scenarios that inject faults where possible.
3. **Mandatory re-validation**: Re-execute all previously created mechanisms (local resilience checks, test harnesses for error paths, etc.).
4. Produce:
   - List of resilience/reliability issues and opportunities (with file references and blast-radius notes).
   - Detailed **Coverage Report** (what failure modes, paths, and subsystems were exercised; what was not covered this round).

**Baseline vs. Delta vs. Final Deep Pass**:
- Round 001 = baseline (broad discovery across all major subsystems).
- Subsequent rounds = delta-informed using prior Coverage Reports (focus on previously uncovered failure modes + recent changes).
- When close to termination, run one heavy final deep pass.

### Step 2: Create Prevention Mechanisms
For each finding or cluster:
- Create project-local mechanisms only (in `opensip-cli/fit/checks/` or equivalent local areas — never add to shipped check packs).
  - Examples: local fit checks for "every async boundary must propagate AbortSignal", "no raw sync I/O in production hot paths without justification", "retry logic must use approved backoff helper", "cleanup must occur in finally or on abort".
  - Expand or add tests that specifically exercise error/fault paths (using the existing test-support and simulation harnesses).
  - Local benchmarks or harnesses that measure recovery time or blast radius under injected faults.
- Re-validate that the mechanism detects the pattern (or would have prevented the issue).

**Architectural cases**:
- If the proper fix requires medium/large architectural work (new recovery contracts between tools, enhanced host-planes for resilience, major changes to simulation fault injection, cross-process recovery, etc.), create a spec instead of a tactical change.
- Pending specs do not stop the loop.

### Step 3: Resolve / Implement Improvements
- Small/medium improvements: implement directly (with full gates, including running any new or affected resilience tests/harnesses). Include before/after notes on failure modes covered.
- Medium/large architectural improvements: create spec (in `docs/plans/specs/`) for human review. Do not apply band-aids that contradict the long-term direction.

### Step 4: Repeat
Return to Step 1.

## Termination Condition
The process completes only when a full cycle (ideally the heavy final deep pass) finds:
- Zero new high-impact resilience or reliability issues, **and**
- No new architecture specs are required to properly address any class of problem.

Pending specs from earlier rounds must be resolved before final termination.

**Upon termination**:
- Create the final summary in `docs/remediation/`.
- Do not merge from the worktree — human review is mandatory.

## Artifacts and Recording
- Process definition: `docs/internal/resilience-reliability-improvement-process.md` (committed).
- Per-round records and final summary: written to `docs/remediation/` (gitignored — ephemeral, only inside the worktree).
  - Each record must include: date, findings list (with blast radius), Coverage Report, mechanisms created (local only), specs created, improvements implemented, open items.
- All records created from within the worktree.

## Invocation
To run: "Run the Resilience & Reliability Improvement Process (see docs/internal/resilience-reliability-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using prior Coverage Reports for delta guidance."

The agent must:
- Follow the 4 steps exactly.
- Stay inside the worktree.
- Produce Coverage Reports every round.
- Create only project-local mechanisms.
- Write records to `docs/remediation/`.
- Re-validate mechanisms every round.
- Create final summary on termination.
- Never merge to main.

### Worktree Setup (Typical)
```bash
git worktree add ../resilience-remediation-$(date +%Y%m%d) -b resilience-reliability-improvement
cd ../resilience-remediation-$(date +%Y%m%d)
# All work here.
```

## Notes on Evolution and Adaptation
This is a direct adaptation of the original Correctness Remediation Process (and the Performance Improvement Process) for the resilience/reliability domain. It heavily leverages existing assets:
- Resilience checks already present in `checks-universal`.
- Simulation engine and fault model (ADR-0018).
- AbortSignal and timeout infrastructure in the core execution layer.
- Existing test-support for error-path testing.

Key domain differences:
- "Issues" include both defects (crashes on error) and missing resilience features (no graceful degradation, insufficient observability of failures).
- Mechanisms often extend the fitness check corpus with local-only resilience rules.
- Architectural work frequently involves the simulation engine, host planes, or cross-tool contracts.

Review and evolve this document after each major cycle (baseline and final deep pass).

Initial baseline round should be recorded as `resilience-round-001-baseline.md` (inside the worktree).

---
*Adapted from the collaborative definition of the correctness and performance processes (2026-06).*