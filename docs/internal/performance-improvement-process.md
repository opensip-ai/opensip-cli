# Performance Improvement Process

**Goal**: Drive the OpenSIP CLI codebase to a state with no new high-impact performance issues or regressions, and to systematically capture and implement meaningful performance improvements.

This is the canonical, internal definition of the repeatable process, adapted from the Correctness Remediation Process. It can be invoked by referencing this document (e.g., "Run the Performance Improvement Process").

It follows the *exact same meta-structure and hard rules* as the correctness process for consistency and safety.

## Hard Rules (Non-Negotiable)
These rules are absolute. There are no exceptions. (Identical to the correctness process.)

- **Worktree Only**: All work (discovery, analysis, creating mechanisms, writing specs, implementing improvements, committing changes, etc.) **must** be performed inside a dedicated git worktree. Never modify the primary working tree directly.
- **Final Summary Document**: Upon reaching the termination condition, the agent **must** create a final summary document in `docs/remediation/` (e.g. `final-summary.md` or `performance-remediation-complete-YYYY-MM-DD.md`).
- **No Direct Merge to Main**: The agent must never merge, push, or integrate changes from the worktree into the main branch (or any shared branch). All results remain isolated in the worktree. A human must review the worktree state, all remediation records, and the final summary before any integration occurs.

## Core Principles
- Follow the four steps strictly.
- Prevention (mechanisms) is prioritized over pure optimization.
- Architecture-first: no band-aids or micro-optimizations that complicate the code without big wins. Medium/large architectural changes (e.g., new data structures, caching layers, sharding improvements, async boundaries) are routed through specs for human review.
- Every round must re-validate previously created mechanisms (e.g., new benchmarks or local perf checks).
- Record-keeping is mandatory for repeatability and delta decisions (via Coverage Reports).
- The process is iterative. We stop only when both conditions in the termination rule are met.

## The 4-Step Cycle

All activity occurs inside the dedicated remediation worktree.

### Step 1: Discovery (Find Performance Issues/Opportunities)
1. Run the full set of CI gates (typecheck, lint, and any existing perf-related gates or benchmarks that can run safely in the environment).
2. Execute the performance-focused audit discovery process:
   - Systematically identify hot paths (using profiling, known benchmarks, static analysis of loops/allocations, review of high-traffic code in core, parsers, graph engine, fitness execution, etc.).
   - Measure and categorize issues: excessive allocations, hot sync paths, poor algorithmic complexity (e.g., O(n^2) in common cases), missing/invalidated caches, unnecessary object churn, N+1 traversals, lock contention, suboptimal data structures for access patterns, etc.
   - Run existing benchmarks and note regressions or opportunities.
   - Use tools like the graph for complexity insights, manual review of inner loops, and searches for common perf anti-patterns.
3. **Mandatory in every round (lightweight or heavy)**:
   - Re-execute and validate all mechanisms created in prior rounds. This includes running new benchmarks, local perf checks, or regression tests.
4. Produce two outputs:
   - A clear list of performance issues and improvement opportunities (with before/after potential where measurable, and file references).
   - A **Coverage Report** that explicitly states:
     - What workloads, hot paths, modules, and benchmark suites were actively measured/reviewed this round.
     - What mechanisms were re-run.
     - What was **not** covered this round (e.g., specific subsystems, cold paths, particular workloads) with rationale. This is critical for determining future delta scope.
5. Record the complete results (findings + Coverage Report + notes on gates/mechanisms/benchmarks) in a new file under `docs/remediation/`.

**Lightweight / Delta Rounds vs. Final Deep Pass**:
- Early and middle rounds use a lightweight, delta-informed approach. The scope is determined by previous round remediation records (focus on areas previously marked as not covered + recent changes that could impact performance).
- The very first round (001) establishes the baseline with reasonably broad discovery (profile key paths, run all available benchmarks, broad static searches for perf smells).
- When the team believes the loop is nearing completion, execute a heavy deep review pass. This pass uses all prior remediation logs and Coverage Reports to ensure previously under-covered areas (and the full set of perf categories) receive thorough attention.

### Step 2: Create Prevention Mechanisms
For each performance finding or opportunity (or logical cluster):
- Determine whether a benchmark, project-local perf regression test, or **project-local** perf check (placed only in `opensip-cli/fit/checks/` or equivalent local areas, never added to shipped packages) would have caught/prevented the regression or systematically encouraged the improvement.
- If a suitable mechanism exists or can be created, implement it (e.g., a local benchmark that gates on allocations in a hot parse path, or a check that flags excessive object creation in inner loops).
- Re-evaluate whether the mechanism actually detects/measures the issue (run the benchmark or check on the bad case).

**Architectural cases**:
- If the *correct long-term fix* requires a medium or large architectural change (e.g., introducing a new cache layer, changing core data representations for better cache locality, improving concurrency model for hot paths, etc.), do **not** implement a rushed micro-optimization or band-aid.
- Instead, create a spec (typically under `docs/plans/specs/`) describing the proper architectural solution, including expected perf impact.
- The existence of such a pending spec counts as an "open item" for the termination condition (see below). Creating the spec does **not** stop the overall loop.

All mechanisms created in this step must be exercised as part of Step 1 in the *next* round.

### Step 3: Resolve / Implement Improvements
- For opportunities whose proper implementation is small or medium: implement the performance win following all project rules.
  - Architecture first (prefer clean, maintainable improvements).
  - Full gates before any commit inside the worktree (including running affected benchmarks).
  - Include before/after measurements in the commit or record.
- For improvements blocked behind medium/large architectural work (see Step 2):
  - Create the spec.
  - Do not apply superficial patches that contradict the intended long-term direction or add technical debt.
  - Document the current performance exposure/opportunity in the round record.

### Step 4: Repeat
Return to Step 1 with the updated remediation record and Coverage Report from the just-completed round.

## Termination Condition
The process is complete only when a cycle completes with **both** of the following:
- Zero new high-impact performance issues or opportunities from the discovery step (in the context of the covered workloads and paths).
- No new architecture specs need to be created to properly address any class of performance problem.

Pending specs created in earlier rounds must be resolved (implemented after review, descoped with justification, or otherwise closed) before the process can be declared complete. The final cycle should be a heavy deep pass that leverages all prior records.

**Upon termination**:
- Create the final summary document in `docs/remediation/` (see Hard Rules).
- Do not merge or push any worktree changes. A human must review everything before any integration.

## Artifacts and Recording
- **Process definition** (this file): `docs/internal/performance-improvement-process.md` — this is committed and part of the repository.
- **Per-round records and final summary**: These are written to `docs/remediation/` (e.g. `performance-round-001-baseline.md`, `final-summary.md`).
  - Each record contains: date, list of performance findings/opportunities (with metrics where available), Coverage Report (workloads/paths covered and not covered), mechanisms created (with locations, confirming project-local), specs created, improvements implemented (with before/after data), and any open items.
- **Important**: The `docs/remediation/` directory is listed in `.gitignore`. These records are **ephemeral / local artifacts** created inside the remediation worktree. They are never committed to the main repository. They exist only to support the current run and to allow delta focus across rounds within that worktree.
- All artifacts are created from within the remediation worktree. After the process completes (or is paused), the human reviewer can inspect the worktree's `docs/remediation/` contents before deciding whether to preserve any of the summary information outside the repo (e.g., in an issue or private note).

## Invocation
To run this process, reference this document directly:
> "Run the Performance Improvement Process (see docs/internal/performance-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using the previous remediation records for delta guidance."

The agent performing the process is expected to:
- Follow the 4 steps exactly.
- Perform **all** work inside the dedicated remediation worktree (primary checkout must stay clean).
- Produce the required Coverage Report each round (with specific focus on measured workloads, benchmarks run, and hot paths analyzed).
- Write a complete record to `docs/remediation/`.
- Re-run all created mechanisms (benchmarks, local perf checks, regression tests) every round.
- Only create project-local mechanisms (never add new shipped perf checks or benchmarks without human review via spec).
- Upon termination, create the final summary document in `docs/remediation/`.
- Never merge or push changes from the worktree to main (or any shared branch). Human review is required.

**Inter-cycle Merge Gate**: When running the family of improvement processes in the agreed order, the code changes from one domain (new local mechanisms + any direct fixes) must be merged to main by a human before the agent creates a worktree for the next domain. See the central note in `improvement-processes.md` ("Inter-cycle Merge Gate") for the rationale: it guarantees that each new cycle starts with an up-to-date baseline and the full accumulated set of prevention mechanisms for re-validation.

### Worktree Setup (Typical)
A common pattern at the start of the process:
```bash
git worktree add ../performance-remediation-$(date +%Y%m%d) -b performance-improvement
cd ../performance-remediation-$(date +%Y%m%d)
# All subsequent commands (discovery, edits, git commit, benchmark runs, record writing, etc.) happen here.
# The original repo checkout remains completely untouched.
```

## Notes on Evolution and Adaptation from Correctness Process
This process is directly adapted from the Correctness Remediation Process to ensure consistency. The key domain differences for performance are:
- Discovery focuses on measurement and anti-patterns rather than binary defects (use profiling, benchmarks, static analysis for allocations/loops/complexity).
- Mechanisms often include benchmarks and local perf guards rather than (or in addition to) correctness checks.
- "Zero issues" is interpreted as no *new high-impact* regressions or missed opportunities in the covered scope (performance is continuous and workload-dependent).
- Architectural specs are expected to be more common, as many big wins require data structure, caching, or concurrency changes.
- Records should capture metrics (e.g., allocations reduced, time improved, throughput increased) for verifiable improvements.

This document (and the overall approach) is intended to be adjusted as we gain experience running it. After each major cycle (especially after the first full baseline and after the final deep pass), review this document and the accumulated remediation records to identify improvements.

Initial baseline round should be recorded as `performance-round-001-baseline.md` (or similar) inside the worktree's (gitignored) `docs/remediation/`.

---
*Document created based on the collaborative definition adapting the correctness remediation process for performance improvements.*