# Improvement Processes

This directory contains a family of repeatable improvement processes for the OpenSIP CLI codebase. All of them follow the **exact same meta-structure** and **hard rules** first established in the Correctness Remediation Process:

- **4-step cycle**: Discovery (Find) → Create Prevention Mechanisms → Resolve/Implement (or spec for medium/large architectural work) → Repeat
- **Hard rules** (non-negotiable):
  - All work must occur inside a dedicated git worktree (primary checkout remains untouched).
  - Per-round records and the final summary are written to the gitignored `docs/remediation/` directory (ephemeral artifacts).
  - Upon termination a final summary document must be created in `docs/remediation/`.
  - The agent must never merge or push changes from the worktree to `main` (or any shared branch). A human must review the worktree state, records, and final summary before any integration.
  - First round is always a broad baseline; subsequent rounds are delta-informed using explicit Coverage Reports.
  - All previously created mechanisms must be re-executed/validated in every round.
  - Mechanisms are created as project-local only (e.g. in `opensip-cli/fit/checks/` or equivalent local areas) and are never added to the published check packs without going through the spec + human-review path.

These processes exist so that different quality and improvement concerns can be attacked with the same disciplined, auditable, and safe methodology.

## The Family

- **[Correctness Remediation Process](correctness-remediation-process.md)** — The foundational process. Systematically finds and eliminates bugs and correctness issues while adding guardrails (tests, local fit checks, etc.) that prevent the same classes from recurring.
- **[Performance Improvement Process](performance-improvement-process.md)** — Applies the pattern to performance. Focuses on discovering hot-path issues, allocation problems, and other perf anti-patterns, then creates local mechanisms (benchmarks, perf guards) and implements improvements (or specs for larger changes).
- **[Resilience & Reliability Improvement Process](resilience-reliability-improvement-process.md)** — Targets error handling, fault tolerance, graceful degradation, retries, timeouts, abort signals, and recovery. Creates local resilience checks and strengthens the existing simulation/fault-injection capabilities.
- **[Observability Improvement Process](observability-improvement-process.md)** — Improves logging, tracing, metrics, structured diagnostics, and runId/spans coverage. Creates local checks that enforce observable behavior and reduces reliance on raw `console.*` or silent paths.
- **[Supply Chain & Dependency Hygiene Improvement Process](supply-chain-dependency-hygiene-improvement-process.md)** — Focuses on dependency bloat, trust policies, build scripts, provenance, and overall supply-chain risk. Creates local hygiene checks that run against changed packages inside the worktree.
- **[Testability & Test Health Improvement Process](testability-test-health-improvement-process.md)** — Addresses gaps in test coverage of public seams, fixture quality, and untested error/fault paths. Creates local mechanisms that enforce test requirements for new or changed code.
- **[Maintainability & Structural Quality Improvement Process](maintainability-structural-quality-improvement-process.md)** — Targets coupling, duplication, module boundaries, complexity, and unclear ownership. Uses the graph tool and depcruise as discovery aids and creates local structural-quality checks.
- **[Public Documentation Improvement Process](public-documentation-improvement-process.md)** — Ensures the public-facing documentation (`docs/public/`) stays correct against the current codebase and improves writing, flow, structure, and reader experience. Creates local checks for doc drift, example validity, and writing-quality issues.

## How to Use

Each process document is self-contained and can be invoked directly:

> "Run the Observability Improvement Process (see docs/internal/observability-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using the previous remediation records for delta guidance."

All processes produce the same style of artifacts:
- Per-round records in `docs/remediation/` (e.g. `observability-round-001-baseline.md`)
- A final summary on termination
- Project-local mechanisms (never shipped)
- Optional architecture specs when bigger changes are needed

## Evolution

These documents are intended to be living and will be updated after major cycles (especially after a baseline and after a final deep pass). If you run one of the processes and discover improvements to the meta-pattern itself, please propose updates to the relevant process document(s) and to this overview.

---
*Maintained as part of the ongoing effort to apply systematic, repeatable improvement processes across multiple quality dimensions (2026-06).*