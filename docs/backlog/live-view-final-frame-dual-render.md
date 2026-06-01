# Backlog: Live-view final frame through the dual-renderer

## What was deferred

The animated live progress views — `packages/fitness/engine/src/cli/fit-runner.tsx`
and `packages/graph/engine/src/cli/graph-runner.tsx`, registered via
`cli.registerLiveView` (Path B) — are **not** converted to the view-model IR
in the dual-renderer effort. They stay Ink-only and TTY-only.

The deferred work: express each live view's **final/terminal frame** as a
`ViewNode` tree so that a non-TTY or interrupted live run (CI, `| tee`,
SIGINT) emits the same content through `renderToText` that the TTY user sees
in the last animated frame — closing the last remaining content-consistency
gap.

## Why deferred

- Live views are inherently TTY-only: animated, stateful, frame-driven. They
  are **not** the drift vector the dual-renderer effort exists to fix — the
  drift was in the hand-maintained plain-text *static* report duplicates
  (`graph-report.ts` `write*Plain`), which the main effort deletes.
- A non-TTY run **already falls back to the static result**, which *is*
  dual-rendered after the main effort. So piped/CI users already get
  consistent output; this item only tightens parity for the live frame
  itself.
- Converting live composition to the IR is larger and lower-value than the
  static path; bundling it would have widened the blast radius of every
  phase. Decision recorded in the spec (resolved open question).

## Source

- Spec: `docs/specs/dual-renderer-cli-output.md` — "Out of Scope → Live
  progress views (Path B)" and "Resolved → Live views end state".
- Plan: `docs/plans/ready/dual-renderer-cli-output/` (the implementing plan,
  which explicitly excludes live-view conversion).
- Decision date: 2026-06-01.

## Promotion trigger

Pick this up when **any** of:
- A user reports CI/piped live-run output diverging from the TTY live view in
  a way the static fallback doesn't cover.
- The view-model IR has stabilized through Phase 5 (rich components) and the
  remaining inconsistency is demonstrably the live frame.
- Live views gain a second consumer (e.g. a non-terminal surface) that needs
  the frame content renderer-agnostic.

On pickup: graduate to a spec/plan and delete this file in the same change.
