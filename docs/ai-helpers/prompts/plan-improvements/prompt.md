---
status: current
last_verified: 2026-06-22
owner: opensip-cli
indexable: true
---

# Orchestrator Prompt — Run All Phases Sequentially (opensip-cli)

Hand this prompt to an agent to walk a draft opensip-cli plan through every
improvement phase in `plan-improvements.md`. The orchestrator applies one phase
at a time, writes the revised plan back, summarizes what changed, and (in
supervised mode) pauses for approval before the next phase. The phases operate on
stable input from their predecessors — running ahead without verification breaks
the design.

**Phase count: 9** (this pipeline is the curtailed opensip-cli sibling of the
11-phase platform pipeline; see the mapping table in `plan-improvements.md`).
Create one progress entry per phase as listed in that file (Phase 1 through
Phase 9) — do not assume a count from the platform pipeline.

## AUTONOMOUS MODE

```text
You are running the plan-improvement pipeline defined in
docs/ai-helpers/prompts/plan-improvements/plan-improvements.md.

PLAN_PATH = docs/plans/ready/<plan-name>

The plan to improve is at: <PLAN_PATH>

Workflow:

1. Read docs/ai-helpers/prompts/plan-improvements/plan-improvements.md to
   load all phase prompts. Read the current plan at <PLAN_PATH> to
   establish baseline.
2. Create a TODO list with one entry per phase AS LISTED in that file
   (Phase 1 through Phase 9). This is your durable progress tracker — mark
   each in_progress when you start and completed when finished.
3. For the next pending phase:
   a. Re-read <PLAN_PATH> (it may have changed since the last phase).
   b. Apply that single phase prompt verbatim to the plan. Do not blend
      in concerns from other phases. Do not skip rules in the phase prompt.
   c. Write the revised plan back to <PLAN_PATH>.
   d. Summarize the changes in ≤200 words: what you added, what you
      reorganized, what gaps you flagged for downstream phases, and any
      decisions you made where the prompt allowed judgment.
4. Repeat step 3 until all 9 phases are completed.
5. After Phase 9, run a final coherence check across the whole plan:
   verify each phase's "Output:" specification is satisfied, verify
   cross-references between phases resolve, verify no phase invalidated
   an earlier phase's work. Report findings.

Rules:

- Apply exactly one phase per iteration. Do not batch phases. Do not jump
  ahead even if a later phase looks "obviously needed" — its prompt
  assumes its predecessors have already run.
- Do not modify <PLAN_PATH> outside the active phase's scope.
- This is opensip-cli: never introduce platform-only concepts (Postgres,
  tenants/RLS, DBOS, distributed tracing, audit chains, auth/RBAC,
  rate-limiting). If a phase seems to call for one, that is a signal the
  concern does not apply here — note it and move on.
- If a phase's prompt is unclear when applied to this specific plan,
  surface the ambiguity in the summary rather than guessing silently.
- Treat the phase prompts as load-bearing instructions, not suggestions.
  Every "must", "never", and "Output:" line is a constraint to satisfy.
```

## SUPERVISED MODE

Identical to AUTONOMOUS MODE, with one addition to step 3:

```text
   e. [SUPERVISED ONLY] Stop and wait for the user to type "approved",
      "next", or "continue" before proceeding to the next phase. If they
      request revisions, address them, rewrite, and resummarize.
```

## NOTES

- **Supervised vs autonomous.** Supervised is the safer default — each phase's
  output is the next phase's input, and a missed constraint compounds. Autonomous
  is reasonable for small, contained plans where you trust the agent and intend to
  review the final result rather than each intermediate step. (The `backend-plan`
  skill chains in autonomous mode by default.)
- **Resumability.** The TODO list is the resume mechanism. If interrupted, hand
  the agent the same prompt; it reads the existing TODO list (or reconstructs it
  from the plan state) and resumes at the first pending phase.
- **Cost.** Expect ~10× the tokens of a single-shot pass — each phase re-reads the
  plan and the relevant codebase context. For a plan that will live through
  `build-phase` execution, this is worthwhile compared to a missed Phase 2 layer
  violation or a missed Phase 3 persistence-shape regression.
- **Relationship to the platform pipeline.** This is a curtailed sibling of
  opensip's 11-phase pipeline. Phases for tenant isolation, DBOS, observability
  SDK wiring/correlation, production hardening (auth/rate-limit/headers), and the
  audit/provenance trail are removed (not stubbed) because opensip-cli has none of
  that surface. See the mapping table at the top of `plan-improvements.md`.
