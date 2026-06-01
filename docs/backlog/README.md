# docs/backlog

Committed, contributor-facing record of **deliberately deferred work** —
follow-ups that a shipped or in-flight effort consciously pushed out of
scope, captured so they are not forgotten.

## Contract

- One file per deferred item. Name it after the work, not the originating
  effort (`live-view-final-frame-dual-render.md`, not `dual-renderer-followups.md`).
- Each item states **what** was deferred, **why**, **where it came from**
  (link the spec/plan/PR), and **the trigger** that should promote it back
  into active work.
- A backlog item is not a plan. When it's picked up, it graduates to a spec
  (`docs/specs/`) or plan (`docs/plans/`), and the backlog file is deleted in
  the same change that starts the work.

## What does NOT go here

- In-progress implementation plans → `docs/plans/` (local-only, gitignored).
- Durable decisions / consumer contracts → `docs/internal/`.
- Reader-facing product docs → `docs/public/`.
- Vague "would be nice" ideas with no originating commitment — those are
  noise, not backlog.
