# Observability Improvement Process

**Goal**: Drive the OpenSIP CLI codebase to a state with no new high-impact observability gaps, and to systematically improve logging, tracing, metrics, diagnostics, and structured event emission so that runs are fully observable and debuggable.

This process follows the *exact same meta-structure and hard rules* as the Correctness Remediation Process and the Performance Improvement Process.

## Hard Rules (Non-Negotiable)
(Identical to previous processes)
- **Worktree Only**: All work must be performed inside a dedicated git worktree. The primary checkout remains untouched.
- **Final Summary Document**: Upon termination, create `final-summary.md` (or dated variant) in `docs/remediation/`.
- **No Direct Merge to Main**: The agent must never merge or push from the worktree. A human must review everything first.

## Core Principles
- Follow the four steps strictly.
- Prevention mechanisms are prioritized (e.g., local checks enforcing structured events).
- Architecture-first: medium/large changes (e.g., new signal types, enhanced host-planes for telemetry, cross-tool correlation contracts) route through specs.
- Every round re-validates previously created mechanisms.
- Use Coverage Reports for focused delta work after the baseline.
- The process is iterative until zero new high-impact observability gaps are found and no new specs are required.

## The 4-Step Cycle

### Step 1: Discovery (Find Observability Gaps)
1. Run full CI gates (typecheck, lint, fit:ci, graph:ci, etc.).
2. Execute an observability-focused audit discovery process:
   - Systematic search for raw `console.*`, missing `runId` or structured `logger.*` calls, untraced hot paths, missing spans or metrics, inconsistent event shapes, places that bypass the `diagnostics-bus` or `currentScope()?.diagnostics`, lack of cardinality discipline in metrics, insufficient error observability, missing lifecycle events.
   - Leverage existing telemetry/OTEL integration (ADRs 0004, 0049), the `diagnostics-bus`, uniform CommandOutcome diagnostics, and manual review of hot paths (parsers, graph build, fitness execution, plugin loading, datastore).
   - Review for "silent" runs (no events on key paths) and poor signal-to-noise in logs.
3. **Mandatory re-validation**: Re-execute all previously created mechanisms (local observability checks, event shape validators, etc.).
4. Produce:
   - List of observability gaps and opportunities (with file references).
   - Detailed **Coverage Report** (what subsystems, event types, and paths were exercised; what was not covered this round).

**Baseline vs. Delta vs. Final Deep Pass**:
- Round 001 = baseline (broad discovery).
- Subsequent = delta-informed using prior Coverage Reports.
- Final = one heavy deep pass.

### Step 2: Create Prevention Mechanisms
For each gap or cluster:
- Create project-local mechanisms only (in `opensip-cli/fit/checks/` or local areas — never shipped).
  - Examples: local fit checks for "must emit at least one structured `logger.info` with runId in every command path", "no raw console.* in src/", "every hot function must be wrapped in a span or diagnostic event", "metrics must use low-cardinality labels".
  - Local validators for event shape consistency.
  - Test harnesses that assert presence of key diagnostics in simulated runs.
- Re-validate that the mechanism would catch the gap.

**Architectural cases**:
- If proper improvement requires medium/large architectural work (new event schemas, enhanced cross-tool telemetry contracts, changes to host-planes for observability, major OTEL integration upgrades), create a spec.
- Pending specs do not stop the loop.

### Step 3: Resolve / Implement Improvements
- Small/medium: implement directly (full gates). Include notes on improved observability.
- Medium/large: create spec for human review. Avoid band-aids.

### Step 4: Repeat
Return to Step 1.

## Termination Condition
Same as previous processes: zero new high-impact gaps in a full cycle + no new specs required.

**Upon termination**:
- Create final summary in `docs/remediation/`.
- Human review required before any merge.

## Artifacts and Recording
- Process definition: `docs/internal/observability-improvement-process.md` (committed).
- Per-round records and final summary: `docs/remediation/` (gitignored — ephemeral, worktree-only).
  - Records must include date, findings, Coverage Report, mechanisms (local only), specs, improvements, open items.
- All created from within the worktree.

## Invocation
To run: "Run the Observability Improvement Process (see docs/internal/observability-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using prior Coverage Reports for delta guidance."

The agent must follow the rules exactly as in the performance and correctness processes.

### Worktree Setup (Typical)
```bash
git worktree add ../observability-remediation-$(date +%Y%m%d) -b observability-improvement
cd ../observability-remediation-$(date +%Y%m%d)
# All work here.
```

## Notes on Evolution and Adaptation
Direct adaptation of the correctness and performance processes.

Leverages heavily:
- Existing OTEL and diagnostics infrastructure.
- Uniform lifecycle events already emitted on CommandOutcome.
- The `diagnostics-bus` and `currentScope()?.diagnostics` pattern.

Key differences:
- "Issues" are observability gaps (missing signals, poor signal quality, bypasses) rather than defects.
- Mechanisms focus on enforcement of structured, low-noise telemetry.
- Architectural work often touches telemetry planes and host-planes.

Review after baseline and final deep pass.

Initial baseline: `observability-round-001-baseline.md` (in worktree).

---
*Adapted from the collaborative correctness and performance processes (2026-06).*